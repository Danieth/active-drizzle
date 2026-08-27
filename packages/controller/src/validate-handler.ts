/**
 * The validation endpoint — transport WS3, A2′ implemented literally
 * (DESIGN-transport-proof.md; obligation O10 server side).
 *
 * A generated sibling procedure of `show` on every columnar door: framework
 * CRUD, so scope + permit run exactly as show's pipeline (proof A3 — a
 * validation response is bytes through the door). Input
 * { id, projId, ifNoneMatch: W }; model and door are implied by the route.
 *
 * Output is an APPLICATION-LEVEL tagged union — oRPC batching + typed unions
 * are the house style, and A0 requires only that the stale envelope be
 * buildColumnarEnvelope's bytes (the ONE serializer; a second encoder is a
 * review blocker):
 *
 *   { status: 'fresh', v }            — the 304: every cell of P the client
 *                                       holds at ≥ W is the cell at V
 *   { status: 'gone',  d }            — destroyed at D (a REAL destroy token
 *                                       from the write-log tombstone — T4
 *                                       forbids fabricating one)
 *   { status: 'stale', envelope }     — the dirty slice: the door's full
 *                                       record envelope at V (extra fields
 *                                       merging at V is sound under Rule M;
 *                                       changed-fields-only slices are the
 *                                       phase-7 byte optimization)
 *
 * The three A2′ clauses, literally:
 *   (i)  OR of changed bitmaps over log rows in (W, V], intersected with the
 *        door's validatable mask, must be empty;
 *   (ii) no lifecycle row in (W, V] — destroy=2, create=1, AND soft
 *        re-creation (undelete=3) all trip it;
 *   (iii) the record is live at V, read from the row itself (soft-delete
 *        column checked) — the V==W shortcut must NOT skip this clause: a
 *        record destroyed exactly at W has an empty interval but is not live.
 *
 * Plus the GAP RULE (the retention/expiry rule — they are the same rule):
 * fresh requires EVERY token in (W, V] present in the log; any gap (pruned,
 * pre-logging history, out-of-contract write) ⇒ the conservative slice. The
 * slice advances the client's W to V, so the gap falls out of every future
 * interval — self-healing.
 *
 * projId = hash of the door's compiled validatable mask (scalar +
 * belongsTo-FK columns ONLY — hasMany pk-arrays are excluded by
 * construction: child commits do not bump the owner's token, so clause (i)
 * over a pk-array is unanswerable from the owner's log; list/child freshness
 * rides the membership lane). Validated against THIS door's ceiling:
 * mismatch (deploy skew) ⇒ 200 slice at the door's ACTUAL mask, never a 304
 * — a client-supplied id can never widen, and a ceiling change yields a new
 * projId by construction.
 *
 * Scope-miss behaves exactly like show's 404 (no gone, no floor — scope
 * membership must not leak; the client evicts via legacy remove()/
 * membership). Soft-deleted rows CAN still be scope-checked, so they re-ask
 * through the door's own relation minus only the SoftDeletable filter
 * before answering gone. HARD-deleted rows cannot be scope-checked at all
 * (the tombstone stores no scope columns), so gone(D) off the tombstone is
 * answered ONLY through an UNSCOPED door (no URL scopes, no scopeBy): a
 * scoped door answering it would be a cross-tenant existence + destroy-
 * token oracle for principals who never had access to the record — a
 * strictly stronger disclosure than T9's epoch-scoped leak, so it is
 * refused, not accepted. On an unscoped door the residual leak is the
 * declared gone(D) non-theorem (proof §6): a door-authenticated user —
 * who could read every live row anyway — learns a pk existed and was
 * destroyed at D. Scoped doors answer show's 404 instead; the client
 * evicts via the legacy lane (correct, minus the floor's precision).
 */
import {
  modelClassName,
  resolveLockColumnName,
  columnKeyFor,
  resolveWireAssociation,
  normalizeIncludeSpecs,
  registerLoggedModel,
  registerMembershipDoor,
  isWriteLogged,
  fieldNumberingFor,
  softDeleteColumnFor,
  readWriteLogInterval,
  latestDestroyToken,
  bitmapIntersects,
  projIdFor,
  LIFECYCLE,
} from '@active-drizzle/core'
import type { ColumnarEnvelope } from './columnar-envelope.js'
import { usesColumnar } from './columnar-envelope.js'
import { finishColumnarRecordEnvelope } from './crud-handlers.js'
import type { CrudConfig } from './metadata.js'
import { getScopes } from './metadata.js'
import { NotFound } from './errors.js'

// ── Wire shapes ──────────────────────────────────────────────────────────────

export interface ValidateInput {
  id: number | string
  /** The client's compiled-mask hash (wire-identity §3a.4). */
  projId: string
  /** W — projFreshAt over the door's held fields (the coverage watermark,
   *  deliberately NEVER knownVersion — landmine 3). */
  ifNoneMatch: number
}

export type ValidateResult =
  | { status: 'fresh'; v: number }
  | { status: 'gone'; d: number }
  | { status: 'stale'; envelope: ColumnarEnvelope }

// ── The door's validatable mask (runtime twin of codegen's
//    validatableMaskFields — same rule, same hash helpers, so the two can
//    only disagree where an Attr maps a property to a differently-named
//    column codegen cannot see; disagreement degrades to the slice) ─────────

export interface ValidatableMask {
  /** Column names (declaration-order numbering space). */
  fields: string[]
  /** Indices into fieldNumberingFor(table) — clause (i)'s bitmap probe. */
  indices: number[]
  projId: string
}

/**
 * The shared mask rule: pk + exposed columns (through columnKeyFor) + the
 * belongsTo FK linkage columns of the given include tree, minus the lock
 * column (the token is never a wire field — WS0). ONE rule for the validate
 * lane (get includes) and the frame lanes (get vs index includes — the
 * silence-rule ceiling is per VIEW, transport WS4).
 */
function maskColumnSet(model: any, config: CrudConfig, includeSpecs: any[] | undefined): Set<string> {
  const tableName: string = (model as any)?._activeDrizzleTableName ?? (model as any)?.tableName
  const numbering = fieldNumberingFor(tableName)
  const physical = new Set(numbering)
  const pkRaw = (model as any)?.primaryKey
  const pk = typeof pkRaw === 'string' ? pkRaw : 'id'
  const mask = new Set<string>([pk])
  for (const f of config.get?.expose ?? []) {
    const col = columnKeyFor(model, f)
    if (physical.has(col)) mask.add(col)
  }
  // Included belongsTo FKs are linkage columns of the door's projection even
  // when expose omits them (the serializer ships them the same way).
  for (const entry of normalizeIncludeSpecs((includeSpecs ?? []) as any[], modelClassName(model))) {
    const meta = resolveWireAssociation(model, entry.name)
    if (meta?.kind === 'belongsTo' && meta.foreignKey && physical.has(meta.foreignKey)) {
      mask.add(meta.foreignKey)
    }
  }
  const lockCol = resolveLockColumnName((model as any)?.lockingColumn)
  if (lockCol) mask.delete(lockCol)          // the token is never a wire field (WS0)
  return mask
}

export function validatableMask(model: any, config: CrudConfig): ValidatableMask {
  const tableName: string = (model as any)?._activeDrizzleTableName ?? (model as any)?.tableName
  const numbering = fieldNumberingFor(tableName)
  const fields = [...maskColumnSet(model, config, config.get?.include as any[])]
  return {
    fields,
    indices: fields.map(f => numbering.indexOf(f)).filter(i => i >= 0),
    projId: projIdFor(fields),
  }
}

// ── Boot-time registration (the runtime backstop of the codegen-derived
//    logged set — called by buildRouter for every columnar door) ─────────────

/**
 * One retained columnar door — the shared registry the WS4 emitter and
 * gateway read (populated by buildRouter with ZERO new app wiring; the
 * write-log registration below is its side effect). Masks are computed
 * LAZILY (registration can precede boot(); fieldNumberingFor needs the
 * booted schema) and memoized.
 */
export interface ColumnarDoorTransportEntry {
  /** The door id = its basePath (scope segments included) — channel key root. */
  doorId: string
  model: any
  config: CrudConfig
  tableName: string
  pkField: string
  /** URL @scope segments (paramName ↔ column field) — membership routing. */
  scopes: Array<{ paramName: string; field: string; resource: string }>
  /** Door has a scopeBy fn (ctx-dependent scope ⇒ dry-run routing only). */
  hasScopeBy: boolean
  /** Record-channel silence-rule mask (get projection), lazily computed. */
  getMask(): Set<string>
  /** Index-channel silence-rule mask (index projection), lazily computed. */
  indexMask(): Set<string>
}

const _doorRegistry = new Map<string, ColumnarDoorTransportEntry>()

/** Every retained columnar door (emitter fanout walks this). */
export function columnarDoorRegistry(): ColumnarDoorTransportEntry[] {
  return [..._doorRegistry.values()]
}

/** One door by id (gateway SUB resolution). */
export function columnarDoorFor(doorId: string): ColumnarDoorTransportEntry | undefined {
  return _doorRegistry.get(doorId)
}

/** The doors served from one table (emitter fanout). */
export function columnarDoorsForTable(tableName: string): ColumnarDoorTransportEntry[] {
  return [..._doorRegistry.values()].filter(e => e.tableName === tableName)
}

/** Test/boot hygiene — mirrors resetWriteLogRegistry. */
export function resetColumnarDoorRegistry(): void {
  _doorRegistry.clear()
}

/**
 * Registers everything a columnar door implies for the transport substrate:
 * the root model and every lock-tokened model reachable through its include
 * trees become write-logged, the door's membership counter is bound to the
 * root table, and the door is RETAINED in the transport registry the WS4
 * emitter/gateway share. Derived, never a knob (zero new config).
 */
export function registerColumnarDoorTransport(
  model: any,
  config: CrudConfig,
  doorId: string,
  extras: { scopes?: Array<{ paramName: string; field: string; resource: string }> } = {},
): void {
  if (!usesColumnar(config)) return
  const seen = new Set<any>()
  const walk = (m: any, specs: any[] | undefined): void => {
    if (!m || seen.has(m)) return
    seen.add(m)
    registerLoggedModel(m)                    // silently skips untracked models
    for (const entry of normalizeIncludeSpecs((specs ?? []) as any[], modelClassName(m))) {
      const meta = resolveWireAssociation(m, entry.name)
      if (meta?.targetModel) walk(meta.targetModel, entry.children)
    }
  }
  walk(model, config.get?.include as any[])
  walk(model, config.index?.include as any[])
  seen.delete(model)                          // include trees may re-walk the root
  const tableName: string = (model as any)?._activeDrizzleTableName ?? (model as any)?.tableName
  if (tableName && isWriteLogged(tableName)) {
    // URL-scope columns are membership columns: a scope-column VALUE write
    // re-tenants the row (moves it between tenants' lists), so it must bump
    // the door's tag in-commit like a lifecycle write (O5 — WS4 consumes
    // tag-equality as a reconnect skip, so value-driven membership moves
    // need the bump). scopeBy doors derive scope from ctx at call time — no
    // static column to register; their lists heal on refetch/reconnect.
    const membershipColumns = (extras.scopes ?? [])
      .map(s => {
        try { return columnKeyFor(model, s.field) ?? s.field } catch { return s.field }
      })
    registerMembershipDoor(tableName, doorId, membershipColumns)
  }

  // ── Retain the door for the WS4 emitter/gateway (idempotent by doorId) ────
  if (tableName) {
    const pkRaw = (model as any)?.primaryKey
    let getMaskMemo: Set<string> | null = null
    let indexMaskMemo: Set<string> | null = null
    _doorRegistry.set(doorId, {
      doorId,
      model,
      config,
      tableName,
      pkField: typeof pkRaw === 'string' ? pkRaw : 'id',
      scopes: extras.scopes ?? [],
      hasScopeBy: typeof (config as any).scopeBy === 'function',
      getMask() { return getMaskMemo ??= maskColumnSet(model, config, config.get?.include as any[]) },
      indexMask() { return indexMaskMemo ??= maskColumnSet(model, config, config.index?.include as any[]) },
    })
  }

  // ── Mask-drift diagnostic (the ONE known codegen/runtime divergence) ──────
  // An Attr that maps a property to a DIFFERENTLY-NAMED column lands in the
  // runtime mask (columnKeyFor sees it) but not in codegen's (raw expose
  // names against schema columns — codegen cannot see Attr._column). The
  // projIds then differ, so every validate from the generated client answers
  // the conservative slice: always CORRECT, never a 304 — a silently dead
  // lane. Surface it at router build with the field named, instead of
  // leaving the code writer a 100% cache miss with no diagnostic. (Making
  // it ONE computation — a codegen-emitted server registry — is the named
  // follow-up in DESIGN-transport-work WS3.)
  const drifting = (config.get?.expose ?? []).filter(f => columnKeyFor(model, f) !== f)
  if (drifting.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[active-drizzle] ${doorId}: the validation/304 lane of this columnar door is degraded — ` +
      `exposed Attr${drifting.length > 1 ? 's' : ''} ${drifting.map(f => `'${f}'`).join(', ')} ` +
      `map${drifting.length > 1 ? '' : 's'} to renamed column${drifting.length > 1 ? 's' : ''} ` +
      `(${drifting.map(f => `'${columnKeyFor(model, f)}'`).join(', ')}), which the build-time ` +
      `projId cannot see. Every revalidation will answer the full record (correct, never a 304). ` +
      `Rename the property to match its column to enable 304s on this door.`,
    )
  }
}

// ── The handler ──────────────────────────────────────────────────────────────

/**
 * Is this door scoped (URL @scope segments or a scopeBy function)? Gates the
 * hard-delete gone(D) lane: a tombstone cannot be scope-checked, so only a
 * door that never scope-checks live rows either may answer from it.
 */
function doorIsScoped(config: CrudConfig, ctrl: any): boolean {
  if (config.scopeBy) return true
  const cls = ctrl?.constructor
  return Boolean(cls && getScopes(cls).length > 0)
}

export async function defaultValidate(
  relation: any,
  model: any,
  config: CrudConfig,
  input: ValidateInput,
  ctx?: any,
  ctrl?: any,
): Promise<ValidateResult> {
  const tableName: string = (model as any)?._activeDrizzleTableName ?? (model as any)?.tableName
  const lockCol = resolveLockColumnName((model as any)?.lockingColumn)
  const pkRaw = (model as any)?.primaryKey
  const pkField = typeof pkRaw === 'string' ? pkRaw : 'id'
  // The write-log registry is the lane's substrate: an UNLOGGED root (no
  // physical lock column — the registry verifies presence) has no log, no
  // numbering, no tombstones. Its validate procedure stays sound by always
  // answering the slice below, and NEVER consults the transport tables
  // (codegen's W9 warning tells the code writer the lane is dead; the
  // generated client does not emit the transport for such a door).
  const logged = isWriteLogged(tableName)
  const softCol = logged ? softDeleteColumnFor(tableName) : null

  // ── Scope: EXACTLY show's lookup (relation is ctrl.relation — URL scopes +
  //    scopeBy already applied by dispatch) ─────────────────────────────────
  const record = await relation.where({ [pkField]: input.id }).first()

  if (!record) {
    // Soft-deletable models: the door's default scope hides deleted rows, but
    // scope CAN still be evaluated on them — re-ask through the SAME door
    // relation minus only the SoftDeletable filter. In scope + soft-deleted
    // ⇒ clause (iii) fails ⇒ gone(D) from the log (never a fabricated D).
    if (softCol && typeof relation.unscoped === 'function') {
      const deleted = await relation.unscoped('SoftDeletable').where({ [pkField]: input.id }).first()
      if (deleted && deleted[softCol] != null) {
        const d = await latestDestroyToken(tableName, input.id)
        if (d != null) return { status: 'gone', d }
        // No lawful D (pre-logging destroy) — same 404 as show; the client's
        // legacy remove()/membership eviction handles it.
        throw new NotFound(modelClassName(model))
      }
    }
    // Hard-delete lane: physically absent + tombstone ⇒ gone(D) — but ONLY
    // through an UNSCOPED door. The tombstone carries no scope columns, so a
    // scoped door answering gone(D) here would hand any tenant an existence
    // + destroy-token oracle over EVERY tenant's pks (see header). Scoped
    // doors answer show's 404; physically PRESENT but scope-missed is
    // always the 404 (scope membership must not leak).
    if (logged && !doorIsScoped(config, ctrl)) {
      const physical = await (model as any).unscoped().where({ [pkField]: input.id }).first()
      if (!physical) {
        const d = await latestDestroyToken(tableName, input.id)
        if (d != null) return { status: 'gone', d }
      }
    }
    throw new NotFound(modelClassName(model))
  }

  const slice = async (): Promise<ValidateResult> => {
    // The dirty slice: the door's full record envelope at V, through the ONE
    // serializer AND show's one assembly tail (finishColumnarRecordEnvelope)
    // — byte-identical to what show/echo/frames carry (A0).
    return { status: 'stale', envelope: await finishColumnarRecordEnvelope(record, model, config, ctx, ctrl) }
  }

  if (!logged) return slice()                  // unlogged lane: sound, never a 304
  const mask = validatableMask(model, config)

  // ── Clause (iii) FIRST — never skipped, even when V == W: liveness is read
  //    from the row itself (a door that serves deleted rows still must not
  //    certify one) ──────────────────────────────────────────────────────────
  if (softCol && record[softCol] != null) {
    const d = await latestDestroyToken(tableName, input.id)
    if (d != null) return { status: 'gone', d }
    return slice()                             // destroyed but no lawful D: never certify
  }

  // ── The current token V, from the row the door just read ─────────────────
  const v = lockCol ? record._attributes?.[lockCol] : null
  if (typeof v !== 'number') return slice()    // untracked/partial — cannot certify

  // ── projId ceiling validation: deploy skew ⇒ slice at the door's ACTUAL
  //    mask, never 304 (a client-supplied id can never widen) ───────────────
  if (input.projId !== mask.projId) return slice()

  const w = input.ifNoneMatch
  if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > v) return slice()

  // ── Clauses (i) + (ii) + the gap rule over (W, V] ────────────────────────
  if (w < v) {
    const interval = await readWriteLogInterval(tableName, input.id, w, v)
    if (interval.length !== v - w) return slice()               // GAP ⇒ conservative slice
    for (const row of interval) {
      if (row.lifecycle !== LIFECYCLE.none) return slice()      // clause (ii)
      if (bitmapIntersects(row.changed, mask.indices)) return slice()  // clause (i)
    }
  }

  return { status: 'fresh', v }
}
