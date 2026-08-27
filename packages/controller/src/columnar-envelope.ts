/**
 * The columnar wire envelope — DESIGN-wire-identity §1/§2, transport WS2.
 *
 * ONE serializer for every byte path through a flagged door (proof A3/A0
 * made literal): defaultIndex, defaultGet, and every echo path that builds
 * the record envelope today all factor through buildColumnarEnvelope.
 *
 * Shape (TEXT JSON, columnar, self-describing `k` header — keys once per
 * table, not per row):
 *
 *   {
 *     membership: { pks, pagination?, facets?, chart?, metric?, options?, emptyReason? },
 *     entities: {
 *       <tableName>: { k: ['id', ...], v: [tok|null, ...], r: [[...], ...] },
 *     },
 *     version?, abilities?, can?, why?, issues?,           // show/echo doors
 *     meta?: { nestedKeys?: { <table>: { id: _key } } },   // transport passenger
 *     ctx?,                                                // @frontendContext
 *     touched?: [{ resource, id, op, version }],           // destroy echoes
 *   }
 *
 * Conventions (each load-bearing, each pinned by the parity suite):
 *   - tables are keyed by TABLE NAME — the identity space (STI subclasses
 *     share a table + pk lineage; matches signal `resource` and coherence
 *     edges). The STI discriminator travels as an ordinary k column.
 *   - k[0] is the pk column, serializer-enforced.
 *   - `v` is a parallel per-row token array read from each model's resolved
 *     lock column (null = untracked lane). The token NEVER appears as a k
 *     column — the wire never carries a writable lock field (WS0's law);
 *     the store receives it via merge's `version` opt.
 *   - absence of a column = not-in-projection; null = explicit value (A0
 *     footnote). A column undefined on every row is dropped; a column
 *     undefined on SOME rows is a divergence and throws (columnar JSON
 *     cannot express per-row absence).
 *   - every record appears exactly once, FLAT: belongsTo/hasOne travel as
 *     FK columns; an included hasMany travels as an ordered pk-array column
 *     on the OWNER (versioned with the owner's token) plus the child rows in
 *     their own table.
 *   - every cell runs the field's Attr codec (toJSON / Attr.get) — ONE codec
 *     per field everywhere (A0): money as decimal-dollar NUMBERS (exact-string
 *     math happens inside the codec; the wire value is what toJSON emits, and
 *     the parity suite pins 19.99), dates ISO, enums as their serialized
 *     labels, exactly as the nested lane.
 */
import {
  modelClassName,
  resolveLockColumnName,
  resolveWireAssociation,
  resolveIncludableAssociation,
  normalizeIncludeSpecs,
} from '@active-drizzle/core'
import { PROJECTION_NODE, type NormalizedNode } from './projection.js'
import type { CrudConfig, IncludeSpec } from './metadata.js'
import type { PaginationResult } from './crud-handlers.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ColumnarTableSection {
  /** Column names, once per table. k[0] is the pk column. */
  k: string[]
  /** Per-row version token (the lock int), parallel to `r`. null = untracked. */
  v: Array<number | null>
  /** Rows: value arrays parallel to `k`. */
  r: any[][]
}

export interface ColumnarMembership {
  pks: Array<number | string>
  pagination?: PaginationResult
  facets?: Record<string, Record<string, number>>
  chart?: Array<{ x: string; y: number }>
  metric?: number | string | null
  options?: Array<{ value: any; label: any }>
  emptyReason?: 'no-records' | 'no-matches'
  /** WS3 membership lane: the pure STRUCTURE token — strong truncated crypto
   *  hash of pk-set + order + count + cursor identity (facets EXCLUDED; value
   *  churn cannot bust it). The index-refetch 304 guard (wire-identity §4). */
  structureToken?: string
  /** WS3 membership lane: the door-scoped commit-ordered COUNTER (T8 theorem
   *  grade), bumped in-commit by lifecycle writes on the root model. Present
   *  only when the door's root table is write-logged. */
  tag?: number
}

export interface ColumnarEnvelope {
  membership: ColumnarMembership
  entities: Record<string, ColumnarTableSection>
  /** Show/echo doors: the envelope record's token (same opaque string as the
   *  nested envelope's `version`). */
  version?: string
  abilities?: Record<string, 'edit' | 'view'>
  can?: Record<string, boolean>
  why?: Record<string, string>
  issues?: Array<{ field: string; code: string }>
  /** Transport passengers — never mergeable cells. nestedKeys: per TABLE,
   *  created-row id → the client's ephemeral `_key` (form adoption). */
  meta?: { nestedKeys?: Record<string, Record<string, string>> }
  ctx?: Record<string, unknown>
  /** Mutation echoes (destroy): what changed, with tokens, so the store can
   *  raise floors without guessing. */
  touched?: Array<{ resource: string; id: number | string; op: 'create' | 'update' | 'destroy'; version: number | null }>
}

/** Extras threaded by the door handlers — membership truth, show verdicts, ctx. */
export interface ColumnarExtras {
  /** The include tree in effect (index.include for lists, get.include for
   *  show/echoes). */
  includeSpecs?: IncludeSpec[]
  membership?: Omit<ColumnarMembership, 'pks'>
  version?: string
  abilities?: Record<string, 'edit' | 'view'>
  can?: Record<string, boolean>
  why?: Record<string, string>
  issues?: Array<{ field: string; code: string }>
  /** Keyed by ASSOCIATION name (as core records it); re-keyed to table names. */
  nestedKeys?: Record<string, Record<string, string>>
  ctx?: Record<string, unknown>
  touched?: ColumnarEnvelope['touched']
}

/** True when this door is flagged onto the columnar wire. */
export function usesColumnar(config: CrudConfig | undefined | null): boolean {
  return (config as any)?.wire === 'columnar'
}

// ── Internals ─────────────────────────────────────────────────────────────────

interface TableAcc {
  k: string[] | null
  v: Array<number | null>
  r: any[][]
  seen: Set<any>
  pkField: string
}

const STAR_NODE: NormalizedNode = { fields: '*', edit: new Set(), include: {} }

function tableNameOf(ModelClass: any): string {
  return (ModelClass as any)?._activeDrizzleTableName ?? (ModelClass as any)?.tableName
    ?? modelClassName(ModelClass)
}

/**
 * Serializes one record (instance or plain eager-loaded row) into its table
 * section, recursing into the included graph. Dedupe is by (table, pk) —
 * every record appears exactly once per response.
 */
function serializeRecord(
  tables: Map<string, TableAcc>,
  order: string[],                       // table insertion order
  raw: any,
  ModelClass: any,
  node: NormalizedNode,
  includeSpecs: IncludeSpec[],
  doorName: string,
): void {
  if (raw == null) return
  const table = tableNameOf(ModelClass)
  const pkRaw = (ModelClass as any)?.primaryKey
  const pkField = typeof pkRaw === 'string' ? pkRaw : 'id'

  // Hydrate plain eager-loaded rows through the model class so Attr codecs
  // run — the serialization-fidelity LAW; instances pass through untouched.
  const rec: any = typeof raw?.toJSON === 'function' ? raw : new (ModelClass as any)(raw, false)
  const pkVal = rec?.[pkField] ?? rec?._attributes?.[pkField]

  let acc = tables.get(table)
  if (!acc) {
    acc = { k: null, v: [], r: [], seen: new Set(), pkField }
    tables.set(table, acc)
    order.push(table)
  }
  if (pkVal != null && acc.seen.has(pkVal)) return
  if (pkVal != null) acc.seen.add(pkVal)

  const includes = normalizeIncludeSpecs(includeSpecs ?? [], doorName)
  const includeNames = new Set(includes.map(e => e.name))
  const lockCol = resolveLockColumnName((ModelClass as any)?.lockingColumn)

  // ── Column candidates ────────────────────────────────────────────────────
  let serialized: Record<string, any>
  let candidates: string[]
  if (node.fields === '*') {
    serialized = rec.toJSON()
    candidates = Object.keys(serialized).filter(kk => !includeNames.has(kk))
  } else {
    const fields = [...(node.fields as Set<string>)].filter(f => !includeNames.has(f))
    candidates = [pkField, ...fields.filter(f => f !== pkField)]
    serialized = rec.toJSON({ only: candidates })
  }
  // The token never rides as a k column (WS0: the wire never carries the
  // lock field) — it travels only in the parallel `v` array.
  if (lockCol) candidates = candidates.filter(c => c !== lockCol)

  // ── Included associations: FK columns, pk-arrays, child rows ─────────────
  const extraCells: Record<string, any> = {}
  const extraCols: string[] = []
  const recurse: Array<{ rows: any[]; ModelClass: any; node: NormalizedNode; children: IncludeSpec[] }> = []
  for (const entry of includes) {
    const meta = resolveIncludableAssociation(ModelClass, entry.name)
    // The child's ceiling node. On an EXPLICIT `access:` door the ceiling is
    // total: an include not present in the access tree must not serialize at
    // all — the nested lane's sliceByProjection DROPS it, and defaulting to
    // STAR here would ship the child table's ENTIRE column set past a door
    // that never exposed it (the per-table k-header leak).
    let childNode = node.include[entry.name]
    if (!childNode) {
      if (node.explicit) {
        throw new Error(
          `[active-drizzle] columnar wire on ${doorName}: include '${entry.name}' is not declared ` +
          `in this door's \`access:\` ceiling — an explicit ceiling is TOTAL, and serializing an ` +
          `undeclared association would ship every column of '${meta.targetTable}' past it. ` +
          `Declare it: \`access: { ..., include: { ${entry.name}: { viewable: [...] } } }\`, or ` +
          `drop '${entry.name}' from the include list.`,
        )
      }
      childNode = STAR_NODE
    }
    const loaded = rec._attributes?.[entry.name]
    if (meta.kind === 'belongsTo') {
      // The FK column IS the linkage — ensure it rides even when the ceiling
      // listed only the association (the nested lane embedded the whole child
      // object; the FK is strictly less).
      const fk = meta.foreignKey!
      if (!candidates.includes(fk)) {
        // undefined = not serialized (partial select / redaction) → the
        // column stays ABSENT (A0: absence is never coerced to null; the
        // k-uniformity check below catches per-row divergence).
        const fkVal = rec.toJSON({ only: [fk] })[fk]
        if (fkVal !== undefined) {
          extraCols.push(fk)
          extraCells[fk] = fkVal
        }
      }
      if (loaded) recurse.push({ rows: [loaded], ModelClass: meta.targetModel, node: childNode, children: entry.children })
    } else if (meta.kind === 'hasOne') {
      // Linkage is the FK on the CHILD row — no owner column needed.
      if (loaded) recurse.push({ rows: [loaded], ModelClass: meta.targetModel, node: childNode, children: entry.children })
    } else if (loaded !== undefined) {
      // hasMany: ordered pk-array column on the OWNER, versioned with the
      // owner's token, plus the child rows in their own table.
      const rows: any[] = Array.isArray(loaded) ? loaded : []
      const cpk = meta.primaryKey!
      extraCols.push(meta.idsKey)
      extraCells[meta.idsKey] = rows.map((row: any) => row?._attributes?.[cpk] ?? row?.[cpk])
      recurse.push({ rows, ModelClass: meta.targetModel, node: childNode, children: entry.children })
    }
    // hasMany with loaded === undefined: the association was NEVER attached
    // (an echo of a record loaded without includes). Emitting `[]` here would
    // certify an EMPTY membership at the owner's current token and wipe the
    // client store's true pk-array (absence→[] conflation). Absence of the
    // column is the honest wire statement — the nested lane's toJSON drops
    // unloaded associations the same way.
  }

  // ── Assemble the row (pk first; absence ≠ null is enforced here) ─────────
  const cells: Record<string, any> = {}
  const present: string[] = []
  for (const c of [pkField, ...candidates.filter(c => c !== pkField), ...extraCols]) {
    const val = c in extraCells ? extraCells[c] : serialized[c]
    // undefined = not-in-projection (absent column, dropped from k). Null is
    // an explicit VALUE and rides as a cell. Rows disagreeing about presence
    // hit the k-uniformity error below — absence is never coerced to null.
    if (val === undefined) continue
    cells[c] = val
    present.push(c)
  }

  if (acc.k === null) {
    acc.k = present
  } else if (acc.k.length !== present.length || acc.k.some((c, i) => c !== present[i])) {
    throw new Error(
      `[active-drizzle] columnar wire on ${doorName}: table '${table}' produced two different ` +
      `column sets — [${acc.k.join(', ')}] vs [${present.join(', ')}] (row pk ${String(pkVal)}). ` +
      `Columnar JSON has ONE k header per table and cannot express per-row absence ` +
      `(absence ≠ null is load-bearing). This usually means an STI door whose subclasses ` +
      `diverge, or one table reached through two include paths with different slices — ` +
      `keep \`wire: 'nested'\` on this door, or align the slices.`,
    )
  }

  // Per-row token from the resolved lock column — raw integer, or null
  // (untracked lane: model has no lock / partial select).
  const tokRaw = lockCol ? rec._attributes?.[lockCol] : null
  acc.v.push(typeof tokRaw === 'number' ? tokRaw : null)
  acc.r.push(acc.k.map(c => cells[c] === undefined ? null : cells[c]))

  for (const r of recurse) {
    for (const row of r.rows) serializeRecord(tables, order, row, r.ModelClass, r.node, r.children, doorName)
  }
}

/** The projection node in effect for a columnar door's ROOT records. */
function rootNode(model: any, config: CrudConfig): NormalizedNode {
  const explicit: NormalizedNode | undefined = (config as any)?.[PROJECTION_NODE]
  const expose: string[] | undefined = config.get?.expose
  if (!explicit?.explicit && !expose?.length) {
    throw new Error(
      `[active-drizzle] ${modelClassName(model)}: wire 'columnar' requires a read ceiling — the k ` +
      `header IS the column picking, and without \`get: { expose: [...] }\` there is nothing to ` +
      `pick from. Add the expose list (the build-time codegen gate teaches the same fix).`,
    )
  }
  // P6 backstop: the columnar lane's show/echo responses are ALWAYS the full
  // record envelope ({ record, abilities, can, version, ... }) — a door that
  // never opted into abilities would silently change its app-visible .get
  // shape (data.title → data.record.title) on flag flip. Refuse instead
  // (the build-time gate teaches the same fix earlier; `access:` doors
  // desugar abilities on).
  if (!config.get?.abilities) {
    throw new Error(
      `[active-drizzle] ${modelClassName(model)}: wire 'columnar' requires \`get: { abilities: ` +
      `true }\` — flagged doors always serve the record envelope, and without abilities the ` +
      `nested lane was serving a BARE record, so flipping the flag would change the app-visible ` +
      `hook shape (P6: the flag is a transport migration, never an API change). Add ` +
      `\`abilities: true\` beside the expose list.`,
    )
  }
  if (explicit?.explicit) return explicit
  return { fields: new Set(expose), edit: new Set(), include: {} }
}

// ── The ONE serializer ────────────────────────────────────────────────────────

/**
 * Builds the columnar envelope for a set of root records (index pages pass
 * many, show/echo doors pass one). Handlers thread membership truth and show
 * verdicts through `extras`; entity data only ever comes from here.
 */
export function buildColumnarEnvelope(
  roots: any[],
  model: any,
  config: CrudConfig,
  extras: ColumnarExtras = {},
): ColumnarEnvelope {
  const node = rootNode(model, config)
  const tables = new Map<string, TableAcc>()
  const order: string[] = []
  const doorName = modelClassName(model)
  const includeSpecs = extras.includeSpecs ?? []

  const pkRaw = (model as any)?.primaryKey
  const pkField = typeof pkRaw === 'string' ? pkRaw : 'id'
  const pks: Array<number | string> = []
  for (const root of roots) {
    if (root == null) continue
    const pkVal = root?.[pkField] ?? root?._attributes?.[pkField]
    if (pkVal != null) pks.push(pkVal)
    serializeRecord(tables, order, root, model, node, includeSpecs, doorName)
  }

  const entities: Record<string, ColumnarTableSection> = {}
  for (const t of order) {
    const acc = tables.get(t)!
    entities[t] = { k: acc.k ?? [acc.pkField], v: acc.v, r: acc.r }
  }

  const envelope: ColumnarEnvelope = {
    membership: { pks, ...(extras.membership ?? {}) },
    entities,
  }
  if (extras.version !== undefined && extras.version !== null) envelope.version = extras.version
  if (extras.abilities) envelope.abilities = extras.abilities
  if (extras.can) envelope.can = extras.can
  if (extras.why && Object.keys(extras.why).length) envelope.why = extras.why
  if (extras.issues && extras.issues.length) envelope.issues = extras.issues
  if (extras.nestedKeys && Object.keys(extras.nestedKeys).length) {
    // _key stitching moves OFF the rows into meta.nestedKeys per TABLE
    // (id → ephemeral key) — a transport passenger, never a mergeable cell.
    const byTable: Record<string, Record<string, string>> = {}
    for (const [assoc, byId] of Object.entries(extras.nestedKeys)) {
      const meta = resolveWireAssociation(model, assoc)
      byTable[meta?.targetTable ?? assoc] = byId
    }
    envelope.meta = { nestedKeys: byTable }
  }
  if (extras.ctx) envelope.ctx = extras.ctx
  if (extras.touched && extras.touched.length) envelope.touched = extras.touched
  return envelope
}
