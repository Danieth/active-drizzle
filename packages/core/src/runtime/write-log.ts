/**
 * The server write-log — transport WS3, obligation O10 (server side).
 *
 * Per commit on a LOGGED model, one row is persisted INSIDE the same
 * transaction as the data write:
 *
 *   record_write_log (model, pk, token, changed, lifecycle, committed_at)
 *
 * where `model` is the TABLE NAME (the identity space — STI subclasses share
 * it), `pk` is text (uuid pks are a framework default, O14), `token` is the
 * lock int the write committed at, `changed` is a bitmap over the model's
 * declaration-order column numbering, and `lifecycle` marks the writes the
 * validation predicate's clause (ii) must trip on:
 *
 *   0 = plain update · 1 = create · 2 = destroy (hard DELETE, or the
 *   soft-delete column transitioning null→set) · 3 = undelete (set→null)
 *
 * WHY in-transaction, never afterCommit (the write-point argument, recorded
 * in DESIGN-transport-work WS3): tokens are DENSE consecutive integers per
 * lineage (create=0 via the DB default; every save CAS / updateAll /
 * counter-cache / destroy bumps by exactly 1 — pinned by
 * lineage-tokens.test.ts), so validation gap-checks the interval (W, V]:
 * a missing row degrades to the conservative dirty slice, never a wrong 304 —
 * a lossy log is never UNSOUND for updates. But gone(D) makes afterCommit
 * logging untenable anyway: after a hard destroy the lifecycle=2 row is the
 * ONLY durable carrier of D; a lost afterCommit write leaves the server
 * unable to distinguish "destroyed" from "never existed", and any fabricated
 * D violates T4 ("every floor corresponds to a real destroy at its token").
 * In-transaction logging makes log-row-exists ⟺ commit-happened a Postgres
 * atomicity fact and gone(D) a theorem. The cost — logged models force the
 * save()/destroy() transaction wrap — is accepted (a partial dividend on O1).
 *
 * WHICH models are logged — derived, never a knob: a model is logged iff it
 * is lock-tokened AND reachable (root or include) from a door with
 * wire:'columnar'. Codegen computes that set in the wire-columnar pass
 * (computeWriteLogRegistry); the runtime backstop is registerLoggedModel(),
 * called by the controller's router builder for plugin-less apps (the same
 * pattern as optimistic-lock.ts's lockField).
 *
 * RETENTION: every row EXCEPT lifecycle=2 is prunable by age (default ~72h)
 * — the gap rule makes expiry safe (pruned interval ⇒ slice, and the slice
 * advances W past the gap, self-healing; a pruned create=1 row is never in
 * any interval since W ≥ 0, and a pruned undelete=3 row degrades to the
 * slice via the gap). ONLY lifecycle=2 rows are EXEMPT and kept forever:
 * they are the tombstone map — one tiny row per DESTROYED lineage, the only
 * durable carrier of D. This mirrors WS1's floorRetention-default-Infinity.
 *
 * HASH GRADES (T8 / landmine 10): projIdFor is a 48-bit truncated SHA-256 —
 * the mask-agreement check is PROBABILISTIC grade, not by-construction: a
 * collision between an old-deploy client mask and the door's mask would let
 * clause (i) verify over the door's mask while the client certifies its own
 * field set (~2^-48 per skewed pair — declared, negligible, not zero).
 * fieldsRev (64-bit) and the structure token carry the same declared grade.
 *
 * WRITE-PATH COST, stated honestly: besides the transaction wrap, every
 * LIFECYCLE write (create/destroy/undelete) bumps each registered door's
 * single membership_tags row in-commit — that row lock is held until the
 * surrounding transaction commits, so concurrent creates/destroys on a
 * doored table SERIALIZE on it (one statement covers all doors of a table;
 * bulk paths bump once per call). Mitigation path when it bites: bump at
 * the transaction tail / dedupe per (tx, door); the rollback-atomicity
 * argument (a sequence survives rollback and breaks tag-equal ⇒ same-list)
 * is why it cannot simply move out of the transaction.
 *
 * CONTRACT EXCLUSION (the WS3 extension of WS0's): out-of-contract writes
 * (raw SQL, sequence resets) create log gaps. Gaps degrade to conservative
 * slices for updates — but an out-of-contract HARD delete never writes the
 * tombstone, so gone(D) is unanswerable FOREVER for that pk; the client
 * renders stale until membership removes it. Because that loss is permanent
 * and invisible at the call site, `Relation.deleteAll` REFUSES on a logged
 * model with a teaching error naming `destroyAll` (in-contract) — the
 * framework's own first-class APIs are all in-contract: save/destroy,
 * updateAll, insertAll (bulk creates log lifecycle=1 + one tag bump), and
 * destroyAll all write their rows.
 */
import { createHash } from 'node:crypto'
import { sql, getTableColumns } from 'drizzle-orm'
import { getExecutor, getSchema, databaseForTable } from './boot.js'
import { resolveLockColumnName } from './optimistic-lock.js'

// ── Schema (names bikesheddable, semantics not — Appendix B, revised: text
//    pk + tableName model key so uuid pks and deploy-stable identity work) ──

/** Paste-ready DDL for the three transport tables (the teaching-error snippet). */
export const WRITE_LOG_SCHEMA_SQL = `
CREATE TABLE record_write_log (
  model        text        NOT NULL,   -- table name (identity space)
  pk           text        NOT NULL,
  token        bigint      NOT NULL,   -- the lock int this commit wrote
  changed      bytea       NOT NULL,   -- field bitmap, declaration-order numbering
  lifecycle    smallint    NOT NULL DEFAULT 0,  -- 0 update, 1 create, 2 destroy, 3 undelete
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, pk, token)
);
CREATE TABLE record_write_log_meta (
  model       text NOT NULL PRIMARY KEY,
  fields_hash text NOT NULL
);
CREATE TABLE membership_tags (
  door text   NOT NULL PRIMARY KEY,
  tag  bigint NOT NULL DEFAULT 0
);`.trim()

export const LIFECYCLE = { none: 0, create: 1, destroy: 2, undelete: 3 } as const

// ── Registry ────────────────────────────────────────────────────────────────

interface LoggedEntry {
  ctor: any
  tableName: string
  /** Lazily computed (schema must be booted): declaration-order columns. */
  fields?: string[]
  fieldsRev?: string
  lockCol?: string | null
  softDeleteCol?: string | null
  /**
   * Lazy PHYSICAL verification: the resolved lock column must actually exist
   * on the booted table. The DECLARATION alone is not enough — the default
   * `lockVersion` resolves for every model, and registering a model whose
   * table lacks the column would force the transaction wrap forever while
   * _writeRecordLog silently bails (permanent overhead, zero log rows, and
   * validate answering the 100% slice). Codegen's twin (lockColumnOf in
   * wire-columnar.ts) already requires the physical column; this keeps the
   * runtime backstop in agreement. undefined = not yet checkable (router
   * build can precede boot()) — re-checked until the schema is available.
   */
  verified?: boolean
}

const _logged = new Map<string, LoggedEntry>()          // tableName → entry
const _membershipDoors = new Map<string, Set<string>>() // tableName → door ids

function schemaTableFor(tableName: string): any | undefined {
  try { return getSchema()[tableName] } catch { return undefined }
}

/** Physically verify a registration once the schema is booted (memoized). */
function entryVerified(e: LoggedEntry): boolean {
  if (e.verified !== undefined) return e.verified
  const table = schemaTableFor(e.tableName)
  if (!table) return true   // boot() not run yet — defer, do not cache
  const lockCol = resolveLockColumnName(e.ctor?.lockingColumn)
  e.verified = lockCol !== null && lockCol in getTableColumns(table)
  return e.verified
}

/**
 * Runtime backstop of the codegen-derived logged set: mark one model's table
 * as write-logged. Called by the controller router builder for every
 * lock-tokened model reachable from a wire:'columnar' door (and by the
 * generated registry). Idempotent. A model without a resolvable lock column
 * — or whose table does not PHYSICALLY carry it (checked lazily, since the
 * router build may precede boot()) — is silently skipped: an untracked lane
 * cannot gap-check and must never pretend to.
 */
export function registerLoggedModel(ModelClass: any): void {
  const tableName = ModelClass?._activeDrizzleTableName ?? ModelClass?.tableName
  if (!tableName || typeof tableName !== 'string') return
  if (resolveLockColumnName(ModelClass?.lockingColumn) === null) return
  if (!_logged.has(tableName)) _logged.set(tableName, { ctor: ModelClass, tableName })
}

/** Test/boot hygiene: clear every registration (mirrors MODEL_REGISTRY resets). */
export function resetWriteLogRegistry(): void {
  _logged.clear()
  _membershipDoors.clear()
  _reconciled.clear()
}

/** Is this model's table write-logged? Checked on every save/destroy/updateAll. */
export function isWriteLogged(ctorOrTable: any): boolean {
  const tableName = typeof ctorOrTable === 'string'
    ? ctorOrTable
    : ctorOrTable?._activeDrizzleTableName ?? ctorOrTable?.tableName
  if (typeof tableName !== 'string') return false
  const e = _logged.get(tableName)
  return e !== undefined && entryVerified(e)
}

/** The registered logged tables (codegen parity checks + reconciliation). */
export function loggedTableNames(): string[] {
  return [..._logged.values()].filter(e => entryVerified(e)).map(e => e.tableName)
}

/**
 * Membership-tag lane (O5, theorem grade per T8): register a DOOR whose
 * index membership is served from `tableName`. Any lifecycle write
 * (create/destroy/undelete) to that table bumps the door's counter row
 * IN THE SAME COMMIT — the conservative bump: spurious bumps cost a
 * membership refetch (hundreds of bytes), never a wrong list.
 */
export function registerMembershipDoor(tableName: string, doorId: string): void {
  let set = _membershipDoors.get(tableName)
  if (!set) { set = new Set(); _membershipDoors.set(tableName, set) }
  set.add(doorId)
}

export function membershipDoorsFor(tableName: string): string[] {
  return [...(_membershipDoors.get(tableName) ?? [])]
}

// ── Field numbering (ONE model-level numbering, door-agnostic) ──────────────

function entryFor(tableName: string): LoggedEntry | null {
  const e = _logged.get(tableName)
  if (!e || !entryVerified(e)) return null
  if (e.fields === undefined) {
    const table = getSchema()[tableName]
    if (!table) {
      throw new Error(
        `[active-drizzle] write-log: table '${tableName}' is registered as logged but is not in ` +
        `the booted schema — boot(db, schema) must include every columnar door's table.`,
      )
    }
    // Declaration order — the same order drizzle's table object carries and
    // the wire-columnar codegen pass reads. This is THE numbering; door masks
    // intersect it only at validation time.
    e.fields = Object.keys(getTableColumns(table))
    e.fieldsRev = fieldsRevOf(e.fields)
    e.lockCol = resolveLockColumnName(e.ctor?.lockingColumn)
    // @include(SoftDeletable) with no args stores `undefined` under the key —
    // presence of the KEY is the signal; columnName defaults like the concern.
    const concernBag = e.ctor?.__concern_config
    e.softDeleteCol = concernBag && 'SoftDeletable' in concernBag
      ? (concernBag.SoftDeletable?.columnName ?? 'deletedAt')
      : null
  }
  return e
}

/** The model-level declaration-order column numbering for a logged table. */
export function fieldNumberingFor(tableName: string): string[] {
  const e = entryFor(tableName)
  if (!e) throw new Error(`[active-drizzle] write-log: '${tableName}' is not a logged table.`)
  return e.fields!
}

/** The soft-delete column of a logged table (SoftDeletable), or null. */
export function softDeleteColumnFor(tableName: string): string | null {
  return entryFor(tableName)?.softDeleteCol ?? null
}

/**
 * fieldsRev — hash of the ordered column-name list. Numbering drift across
 * deploys is detected at boot (reconcileWriteLogFieldsRev): on mismatch the
 * model's lifecycle=0 rows are deleted, so post-deploy validations answer
 * conservative slices briefly and never misread a bitmap.
 */
export function fieldsRevOf(orderedFields: string[]): string {
  return createHash('sha256').update(orderedFields.join(' ')).digest('hex').slice(0, 16)
}

/**
 * projId — hash of a compiled field mask (wire-identity §3a.4). Deliberately
 * ORDER-INSENSITIVE (a mask is a set); a ceiling change yields a new projId
 * by construction, so a client-supplied id can never widen and deploy skew
 * degrades to the slice. Shared verbatim by codegen, the validate handler,
 * and the generated client.
 */
export function projIdFor(maskFields: string[]): string {
  const canonical = [...new Set(maskFields)].sort().join(' ')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

// ── Bitmaps ─────────────────────────────────────────────────────────────────

/**
 * Pack changed COLUMN keys into the declaration-order bitmap (bit i = byte
 * i>>3, mask 1<<(i&7)). A changed key that is not a numbered column (an
 * out-of-schema write path) sets EVERY bit — conservative: the unknown
 * change stales every projection rather than hiding from all of them.
 */
export function packChangedBitmap(orderedFields: string[], changedKeys: Iterable<string>): Buffer {
  const buf = Buffer.alloc(Math.max(1, Math.ceil(orderedFields.length / 8)))
  const index = new Map(orderedFields.map((f, i) => [f, i]))
  for (const key of changedKeys) {
    const i = index.get(key)
    if (i === undefined) { buf.fill(0xff); return buf }
    buf[i >> 3] = buf[i >> 3]! | (1 << (i & 7))
  }
  return buf
}

/** A full bitmap (creates / conservative rows). */
export function fullBitmap(orderedFields: string[]): Buffer {
  return Buffer.alloc(Math.max(1, Math.ceil(orderedFields.length / 8)), 0xff)
}

/** Does the bitmap intersect any of the given field indices? */
export function bitmapIntersects(bitmap: Buffer | Uint8Array, fieldIndices: number[]): boolean {
  for (const i of fieldIndices) {
    const byte = bitmap[i >> 3]
    if (byte !== undefined && (byte & (1 << (i & 7))) !== 0) return true
  }
  return false
}

// ── The write points ────────────────────────────────────────────────────────

function isMissingTableError(err: any): boolean {
  return err?.code === '42P01' || err?.cause?.code === '42P01'
}

/** Marks the teaching error so READ paths can degrade instead of 500ing. */
export const WRITE_LOG_TABLES_MISSING = 'ADRZ_WRITE_LOG_TABLES_MISSING'

function missingTablesError(): Error {
  const err = new Error(
    `[active-drizzle] write-log: the transport tables do not exist. A model reachable from a ` +
    `wire:'columnar' door is write-logged (validation 304s and gone(D) depend on it), and the ` +
    `log row commits INSIDE the data transaction — so the whole write refuses rather than ` +
    `silently shipping an unvalidatable commit. Run this migration:\n\n${WRITE_LOG_SCHEMA_SQL}\n`,
  )
  ;(err as any).code = WRITE_LOG_TABLES_MISSING
  return err
}

/**
 * Is this the missing-transport-tables teaching refusal? WRITE paths must
 * let it propagate (atomicity is the point); READ-side envelope extras (the
 * membership tag on index responses) degrade by omission instead — an
 * EXISTING columnar door must keep serving reads on an unmigrated database.
 */
export function isWriteLogTablesMissing(err: any): boolean {
  return err?.code === WRITE_LOG_TABLES_MISSING
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : result?.rows ?? []
}

export interface WriteLogRow {
  tableName: string
  pk: string | number
  token: number
  /** Changed COLUMN keys (declaration-order numbering resolves them), or a
   *  pre-packed bitmap. */
  changed: Iterable<string> | Buffer
  lifecycle: number
}

/**
 * Persist one log row. MUST be called with the executor of the transaction
 * the data write ran in (getExecutor inside the wrap) — atomicity is the
 * entire point. Bumps the membership counters of every door registered on
 * this table when the row is a lifecycle event (same commit, T8 counter).
 */
export async function writeLogRow(db: any, row: WriteLogRow): Promise<void> {
  await writeLogRows(db, row.tableName, [row])
}

/**
 * Bulk write point: N log rows in ONE INSERT, and AT MOST ONE membership
 * bump per door per call — a bulk soft-delete of N rows must not issue 2N
 * sequential statements while holding the hot counter row (updateAll /
 * insertAll ride this). Same executor rule as writeLogRow.
 */
export async function writeLogRows(
  db: any,
  tableName: string,
  rows: Array<Omit<WriteLogRow, 'tableName'> | WriteLogRow>,
): Promise<void> {
  if (rows.length === 0) return
  const fields = fieldNumberingFor(tableName)
  const values = rows.map(row => {
    const bitmap = Buffer.isBuffer(row.changed) ? row.changed : packChangedBitmap(fields, row.changed)
    return sql`(${tableName}, ${String(row.pk)}, ${row.token}, ${bitmap}, ${row.lifecycle})`
  })
  try {
    await db.execute(sql`
      INSERT INTO record_write_log (model, pk, token, changed, lifecycle)
      VALUES ${sql.join(values, sql`, `)}
    `)
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
  if (rows.some(r => r.lifecycle !== LIFECYCLE.none)) {
    await bumpMembershipTags(db, tableName)
  }
}

/**
 * The in-commit conservative membership bump (O5, counter option — the
 * theorem grade): one row per door, upserted so registration needs no
 * boot-time DB write, ALL doors of the table in one statement (the row lock
 * is held to commit — see the header's write-path cost paragraph). Runs on
 * the SAME executor as the data write — a sequence would survive rollback
 * and break tag-equal ⇒ same-list.
 */
export async function bumpMembershipTags(db: any, tableName: string): Promise<void> {
  const doors = membershipDoorsFor(tableName)
  if (doors.length === 0) return
  try {
    const values = doors.map(door => sql`(${door}, 1)`)
    await db.execute(sql`
      INSERT INTO membership_tags (door, tag) VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (door) DO UPDATE SET tag = membership_tags.tag + 1
    `)
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

/** The current commit-ordered tag of one door (0 before its first bump). */
export async function currentMembershipTag(door: string, tableName?: string): Promise<number> {
  const db = getExecutor(tableName)
  try {
    const result = await db.execute(sql`SELECT tag FROM membership_tags WHERE door = ${door}`)
    const row = rowsOf(result)[0]
    return row ? Number(row.tag) : 0
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

// ── Reads (the validation predicate's evidence) ─────────────────────────────

export interface WriteLogIntervalRow {
  token: number
  changed: Buffer
  lifecycle: number
}

/**
 * The log rows for one lineage over (afterToken, throughToken] — the
 * validation interval. Density holds iff exactly throughToken−afterToken
 * distinct tokens come back; anything less is a gap (pruned, pre-logging
 * history, or an out-of-contract write) and the caller answers the slice.
 *
 * SOUNDNESS GUARD: the first interval read of each table per process runs
 * fieldsRev reconciliation first (memoized) — a bitmap packed under a
 * previous deploy's numbering must NEVER be probed under the current one
 * (a misread could answer a wrong 304). Zero-config by construction: no
 * boot hook to forget. Reads are outside data transactions, so the memo
 * cannot be poisoned by a rollback.
 */
export async function readWriteLogInterval(
  tableName: string,
  pk: string | number,
  afterToken: number,
  throughToken: number,
): Promise<WriteLogIntervalRow[]> {
  await ensureFieldsRevReconciled(tableName)
  const db = getExecutor(tableName)
  try {
    const result = await db.execute(sql`
      SELECT token, changed, lifecycle FROM record_write_log
      WHERE model = ${tableName} AND pk = ${String(pk)}
        AND token > ${afterToken} AND token <= ${throughToken}
      ORDER BY token ASC
    `)
    return rowsOf(result).map((r: any) => ({
      token: Number(r.token),
      changed: Buffer.isBuffer(r.changed) ? r.changed : Buffer.from(r.changed ?? []),
      lifecycle: Number(r.lifecycle),
    }))
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

/**
 * The latest destroy token of one lineage — gone(D)'s only lawful source
 * (T4: every floor corresponds to a real destroy at its token; a fabricated
 * D is forbidden). null = no recorded destroy: the caller answers 404/slice,
 * never gone.
 */
export async function latestDestroyToken(
  tableName: string,
  pk: string | number,
): Promise<number | null> {
  const db = getExecutor(tableName)
  try {
    const result = await db.execute(sql`
      SELECT token FROM record_write_log
      WHERE model = ${tableName} AND pk = ${String(pk)} AND lifecycle = ${LIFECYCLE.destroy}
      ORDER BY token DESC LIMIT 1
    `)
    const row = rowsOf(result)[0]
    return row ? Number(row.token) : null
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

// ── Boot-time reconciliation + retention ────────────────────────────────────

/**
 * fieldsRev reconciliation for ONE logged table: on hash mismatch with the
 * stored meta row, that model's lifecycle=0 rows are DELETED — bitmaps
 * packed under a different numbering must never be read, and the resulting
 * gap degrades every affected validation to the conservative slice (never a
 * misread 304). Lifecycle rows carry no bitmap semantics and survive (they
 * are the tombstone map). NOTE: rows written under the NEW numbering before
 * the first post-deploy reconcile are deleted too on a mismatch — a
 * conservative over-delete (brief slices), never an under-delete.
 */
async function reconcileTable(tableName: string): Promise<void> {
  const e = entryFor(tableName)
  if (!e) return
  const rev = e.fieldsRev!
  const db = getExecutor(tableName)
  try {
    const result = await db.execute(
      sql`SELECT fields_hash FROM record_write_log_meta WHERE model = ${tableName}`)
    const existing = rowsOf(result)[0]?.fields_hash
    if (existing === rev) return
    if (existing !== undefined) {
      await db.execute(sql`
        DELETE FROM record_write_log
        WHERE model = ${tableName} AND lifecycle = ${LIFECYCLE.none}
      `)
    }
    await db.execute(sql`
      INSERT INTO record_write_log_meta (model, fields_hash) VALUES (${tableName}, ${rev})
      ON CONFLICT (model) DO UPDATE SET fields_hash = ${rev}
    `)
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

/**
 * The zero-config guard: memoized once-per-table-per-process reconciliation,
 * awaited by the FIRST bitmap read (readWriteLogInterval) so a deploy that
 * renumbered columns can never cross a misread. A failed attempt clears the
 * memo (the read that triggered it fails loudly; the next one retries).
 */
const _reconciled = new Map<string, Promise<void>>()

function ensureFieldsRevReconciled(tableName: string): Promise<void> {
  let p = _reconciled.get(tableName)
  if (!p) {
    p = reconcileTable(tableName)
    p.catch(() => { _reconciled.delete(tableName) })
    _reconciled.set(tableName, p)
  }
  return p
}

/**
 * Explicit whole-registry reconciliation — an OPTIONAL boot accelerator
 * (front-loads the per-table work the lazy guard would do on first read).
 * Deliberately unmemoized so tests and operators can force a re-check.
 */
export async function reconcileWriteLogFieldsRev(): Promise<void> {
  for (const tableName of _logged.keys()) {
    await reconcileTable(tableName)
  }
}

/**
 * Age-bounded retention (default 72h) for every row EXCEPT the destroy
 * tombstone. ONLY lifecycle=2 is load-bearing forever (gone(D)'s carrier —
 * WS1's floorRetention-default-Infinity symmetry): a pruned create=1 row is
 * never inside any validation interval (W ≥ 0 ⇒ token 0 excluded), and a
 * pruned undelete=3 row degrades to the slice via the gap rule. Keeping
 * them forever was pure unbounded growth — one immortal row per record EVER
 * created — and made pk-reusing re-creates collide on the (model, pk, 0)
 * primary key long after the lineage aged out. BOUNDED per call (default
 * 10k rows via ctid) so opportunistic pruning piggybacked on a request can
 * never ride it unboundedly; call in a loop from a task when draining a
 * backlog. Returns the number of rows removed.
 */
export async function pruneWriteLog(
  opts: { maxAgeMs?: number; limit?: number } = {},
): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? 72 * 3600 * 1000
  const limit = opts.limit ?? 10_000
  const db = getExecutor()
  try {
    const result = await db.execute(sql`
      DELETE FROM record_write_log
      WHERE ctid IN (
        SELECT ctid FROM record_write_log
        WHERE lifecycle <> ${LIFECYCLE.destroy}
          AND committed_at < now() - make_interval(secs => ${maxAgeMs / 1000})
        LIMIT ${limit}
      )
    `)
    return Number((result as any)?.rowCount ?? rowsOf(result).length ?? 0)
  } catch (err) {
    if (isMissingTableError(err)) throw missingTablesError()
    throw err
  }
}

/** The database name write-log statements for a table route to (wrap target). */
export function writeLogDatabaseFor(tableName: string): string {
  return databaseForTable(tableName)
}
