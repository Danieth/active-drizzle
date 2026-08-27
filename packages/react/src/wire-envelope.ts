/**
 * Columnar wire envelope — the CLIENT half (transport WS2).
 *
 * The server's ONE serializer (buildColumnarEnvelope, proof A3/A0) emits a
 * TEXT-JSON columnar envelope with a self-describing `k` header; this module
 * is its ONE decoder — decode + merge live HERE, not smeared through
 * generated strings (I1: only generated response handlers call these, and
 * they are one-liners over this module).
 *
 *   mergeEnvelope        envelope → EntityStore. Zips k/v/r per table into
 *                        per-row merge(model, pk, fields, { version }) calls
 *                        (Rule M1, per-field, version-gated; v[i] = null is
 *                        the store's UNTRACKED arrival-order lane). `touched`
 *                        destroy echoes raise deletion floors (M2) — or take
 *                        the legacy remove() lane when the model has no lock.
 *   mergeRecordEnvelope  mergeEnvelope + a PURE recompose of the nested
 *                        RecordEnvelope shape { record, abilities, can, … }
 *                        so FormSession/useEditForm are untouched (P6).
 *   mergeIndexEnvelope   mergeEnvelope + the nested IndexResult shape
 *                        { data, pagination, facets?, … } for `.with()` and
 *                        the index-surface query.
 *   useProjectedRows     live door-masked row objects materialized FROM the
 *                        store (§3a corollary: union storage, per-door
 *                        projection) — the one accepted P6 deviation: rows
 *                        keep updating as fresher merges land.
 *
 * Envelope conventions consumed here (each serializer-enforced and pinned by
 * the controller parity suite): tables keyed by TABLE name, k[0] is the pk
 * column, `v` is a parallel token array (the token is NEVER a k column),
 * included hasMany = ordered `<singular>Ids` pk-array on the owner + child
 * rows in their own table, belongsTo/hasOne travel as FK linkage,
 * meta.nestedKeys carries the ephemeral `_key` per table (a transport
 * passenger — stitched onto recomposed rows, never merged as a cell).
 */
import { useMemo, useSyncExternalStore } from 'react'
import { EntityStore, entityStore, isGone, visibleFields, type EntityPk } from './entity-store.js'

// ── Wire types (structural — generated specs are plain object literals) ──────

/** One include edge of a door's compiled wire spec (emitted by codegen). */
export interface WireSpecInclude {
  /** Association property name — the key the recomposed row nests under. */
  name: string
  /** The child's TABLE name (the entities/section + store identity key). */
  table: string
  /** Widened to string so generated object literals type-check as-is. */
  kind: 'hasMany' | 'belongsTo' | 'hasOne' | (string & {})
  /** belongsTo: FK column on the OWNER row. hasMany/hasOne: FK column on
   *  the CHILD row (informational for hasMany — reassembly uses idsColumn). */
  fk: string
  /** hasMany only: the ordered pk-array column on the owner. */
  idsColumn?: string
  /** The door's CHILD field mask (emitted from an explicit `access:`
   *  ceiling's child node, pk included). When present, store-materialized
   *  child rows project only these cells — §3a corollary: the store holds
   *  the union of every door's fields, and every read path masks back down
   *  to ITS door's ceiling, children included. Absent = legacy whole-row
   *  children (expose-only doors serve whole child rows on the wire too). */
  fields?: string[]
  includes?: WireSpecInclude[]
}

/** A door's compiled reassembly knowledge (get and index trees are separate). */
export interface WireSpec {
  table: string
  /** The root pk column — always k[0] on the wire; carried for clarity. */
  pk: string
  includes?: WireSpecInclude[]
}

export interface WireTableSection {
  k: string[]
  v: Array<number | null>
  r: unknown[][]
}

export interface WireMembership {
  pks: Array<number | string>
  pagination?: unknown
  facets?: unknown
  chart?: unknown
  metric?: unknown
  options?: unknown
  emptyReason?: unknown
}

export interface WireTouched {
  resource: string
  id: number | string
  op: 'create' | 'update' | 'destroy' | (string & {})
  version: number | null
}

export interface WireEnvelope {
  membership?: WireMembership
  entities?: Record<string, WireTableSection>
  version?: string
  abilities?: Record<string, unknown>
  can?: Record<string, boolean>
  why?: Record<string, string>
  issues?: Array<{ field: string; code: string }>
  meta?: { nestedKeys?: Record<string, Record<string, string>> }
  ctx?: Record<string, unknown>
  touched?: WireTouched[]
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

// ── mergeEnvelope — envelope → store (values), touched → floors ──────────────

/**
 * Merge every entity table of a columnar envelope into the store, then act
 * on destroy echoes. Per row i of table t:
 *   store.merge(t, r[i][0], zip(k, r[i]), v[i] != null ? { version: v[i] } : {})
 * — per-field M1 joins, notify-coalesced per microtask (an index page never
 * fires listeners per row). `touched` entries with op 'destroy' call
 * store.destroy(resource, id, version) when the token is a finite number
 * (M2: raises the deletion floor) and the legacy store.remove(resource, id)
 * when it is null (lock-less models — today's semantics, no regression).
 * Non-envelope inputs are ignored (safe on any response shape).
 */
export function mergeEnvelope(store: EntityStore, env: WireEnvelope | null | undefined): void {
  if (!env || typeof env !== 'object') return
  const entities = env.entities
  if (entities && typeof entities === 'object') {
    for (const [table, section] of Object.entries(entities)) {
      const k = section?.k
      const r = section?.r
      if (!Array.isArray(k) || !Array.isArray(r) || k.length === 0) continue
      const v = Array.isArray(section.v) ? section.v : []
      for (let i = 0; i < r.length; i++) {
        const row = r[i]
        if (!Array.isArray(row)) continue
        const pk = row[0] as EntityPk | null | undefined // k[0] IS the pk column
        if (pk === null || pk === undefined) continue
        const fields: Record<string, unknown> = {}
        for (let j = 0; j < k.length; j++) fields[k[j]!] = row[j]
        const tok = v[i]
        store.merge(table, pk, fields, tok !== null && tok !== undefined ? { version: tok } : {})
      }
    }
  }
  if (Array.isArray(env.touched)) {
    for (const t of env.touched) {
      if (!t || t.op !== 'destroy' || t.id === null || t.id === undefined) continue
      if (typeof t.version === 'number' && Number.isFinite(t.version)) {
        store.destroy(t.resource, t.id, t.version) // M2: monotone floor — no resurrection
      } else {
        store.remove(t.resource, t.id) // legacy untokened lane (model has no lock)
      }
    }
  }
}

// ── Pure recompose (envelope → nested shapes) ────────────────────────────────

type EnvIndex = Map<string, Map<unknown, number>>

/** pk → row-index lookup per table (k[0] is the pk column, by convention). */
function indexEntities(entities: Record<string, WireTableSection>): EnvIndex {
  const byTable: EnvIndex = new Map()
  for (const [table, section] of Object.entries(entities)) {
    const rows = section?.r
    if (!Array.isArray(rows)) continue
    const byPk = new Map<unknown, number>()
    for (let i = 0; i < rows.length; i++) {
      const pk = rows[i]?.[0]
      if (pk !== null && pk !== undefined && !byPk.has(pk)) byPk.set(pk, i)
    }
    byTable.set(table, byPk)
  }
  return byTable
}

/**
 * Recompose one nested row, pure over the ENVELOPE (never the store — the
 * caller of an echo must see the response's own values, not whatever fresher
 * truth the store already holds):
 *   - hasMany  → row[name] = idsColumn ids mapped through the child table
 *                (order preserved — membership of an association is a
 *                property of the parent); the idsColumn key is REMOVED
 *                (it is wire linkage, not a nested-lane field)
 *   - belongsTo→ row[name] = the child row keyed by row[fk]
 *   - hasOne   → the child row whose [fk] === this row's pk
 *   - `_key`   → stitched from meta.nestedKeys[table][String(pk)] (form
 *                adoption of created nested rows)
 */
function recomposeRow(
  env: WireEnvelope,
  index: EnvIndex,
  table: string,
  includes: WireSpecInclude[] | undefined,
  pk: unknown,
): Record<string, unknown> | undefined {
  if (pk === null || pk === undefined) return undefined
  const section = env.entities?.[table]
  const i = index.get(table)?.get(pk)
  if (!section || i === undefined) return undefined
  const k = section.k
  const raw = section.r[i]!
  const row: Record<string, unknown> = {}
  for (let j = 0; j < k.length; j++) row[k[j]!] = raw[j]

  const nk = env.meta?.nestedKeys?.[table]?.[String(pk)]
  if (nk !== undefined) row['_key'] = nk

  for (const inc of includes ?? []) {
    if (inc.kind === 'hasMany') {
      const idsCol = inc.idsColumn ?? ''
      const ids = row[idsCol]
      delete row[idsCol]
      const children: Array<Record<string, unknown>> = []
      if (Array.isArray(ids)) {
        for (const id of ids) {
          const child = recomposeRow(env, index, inc.table, inc.includes, id)
          if (child) children.push(child)
        }
      }
      row[inc.name] = children
    } else if (inc.kind === 'belongsTo') {
      const fkVal = row[inc.fk]
      if (fkVal !== null && fkVal !== undefined) {
        const child = recomposeRow(env, index, inc.table, inc.includes, fkVal)
        if (child) row[inc.name] = child
      }
    } else if (inc.kind === 'hasOne') {
      // Linkage rides on the CHILD row: scan its table for [fk] === our pk.
      const childSection = env.entities?.[inc.table]
      if (childSection) {
        const fkIdx = childSection.k.indexOf(inc.fk)
        if (fkIdx >= 0) {
          for (const childRaw of childSection.r) {
            if (childRaw?.[fkIdx] === pk) {
              const child = recomposeRow(env, index, inc.table, inc.includes, childRaw[0])
              if (child) row[inc.name] = child
              break
            }
          }
        }
      }
    }
  }
  return row
}

/** Copy the show/echo verdict passengers onto a recomposed result. */
function copyVerdicts(env: WireEnvelope, out: Record<string, unknown>): void {
  if (env.version !== undefined) out['version'] = env.version
  if (env.abilities !== undefined) out['abilities'] = env.abilities
  if (env.can !== undefined) out['can'] = env.can
  if (env.why !== undefined) out['why'] = env.why
  if (env.issues !== undefined) out['issues'] = env.issues
  if (env.ctx !== undefined) out['ctx'] = env.ctx
}

/**
 * Decode a SHOW/echo columnar envelope: merge every entity into the store
 * (Rule M — the identity layer learns), then recompose the nested
 * RecordEnvelope shape `{ record, abilities, can, why?, issues?, version?,
 * ctx? }` PURELY from the envelope, so FormSession/useEditForm and every
 * consumer of the nested lane are untouched (P6). The root is the
 * membership.pks[0] row of entities[spec.table].
 *
 * Non-envelope inputs pass through unchanged — safe as the funnel for every
 * response of a flagged door.
 */
export function mergeRecordEnvelope(store: EntityStore, env: any, spec: WireSpec): any {
  if (!env || typeof env !== 'object' || !env.entities) return env
  const e = env as WireEnvelope
  mergeEnvelope(store, e)
  const index = indexEntities(e.entities!)
  const rootPk = e.membership?.pks?.[0]
  const record = recomposeRow(e, index, spec.table, spec.includes, rootPk)
  const out: Record<string, unknown> = { record }
  copyVerdicts(e, out)
  return out
}

/**
 * Decode an INDEX columnar envelope: merge every entity into the store, then
 * recompose the nested IndexResult shape `{ data, pagination, facets?,
 * chart?, metric?, options?, emptyReason?, ctx? }` purely from the envelope
 * (membership order preserved). Non-envelope inputs pass through unchanged.
 */
export function mergeIndexEnvelope(store: EntityStore, env: any, spec: WireSpec): any {
  if (!env || typeof env !== 'object' || !env.entities) return env
  const e = env as WireEnvelope
  mergeEnvelope(store, e)
  const index = indexEntities(e.entities!)
  const m = e.membership
  const data: Array<Record<string, unknown>> = []
  for (const pk of m?.pks ?? []) {
    const row = recomposeRow(e, index, spec.table, spec.includes, pk)
    if (row) data.push(row)
  }
  const out: Record<string, unknown> = { data, pagination: m?.pagination }
  if (m?.facets !== undefined) out['facets'] = m.facets
  if (m?.chart !== undefined) out['chart'] = m.chart
  if (m?.metric !== undefined) out['metric'] = m.metric
  if (m?.options !== undefined) out['options'] = m.options
  if (m?.emptyReason !== undefined) out['emptyReason'] = m.emptyReason
  if (e.ctx !== undefined) out['ctx'] = e.ctx
  return out
}

// ── useProjectedRows — live door-masked rows from the store ──────────────────

type DepMap = Map<string, [string, EntityPk]>

const depKey = (table: string, pk: EntityPk): string => `${table} ${String(pk)}`

/**
 * Materialize one row from STORE truth. Root cells are masked to the door's
 * projected `fields` (§3a: union storage, per-door projection); nested child
 * rows mask to the spec's per-child `fields` when the door declared an
 * explicit access ceiling, and project all visible cells otherwise (legacy
 * whole-row children). hasMany re-nests through the owner's idsColumn (which is removed
 * from the row); belongsTo through the FK cell. hasOne is NOT re-nested here
 * — the store has no FK index; hasOne children reach app code through the
 * recomposed get/echo shapes, and the row simply omits the member.
 * Every (table, pk) touched is recorded in `deps` for live subscription.
 */
function projectRow(
  store: EntityStore,
  table: string,
  pk: EntityPk,
  fields: string[] | null,
  includes: WireSpecInclude[] | undefined,
  deps: DepMap,
): Record<string, unknown> | undefined {
  deps.set(depKey(table, pk), [table, pk])
  const entry = store.get(table, pk)
  if (!entry || isGone(entry)) return undefined
  const vis = visibleFields(entry)
  const row: Record<string, unknown> = {}
  if (fields) {
    for (const f of fields) if (hasOwn(vis, f)) row[f] = vis[f]
  } else {
    Object.assign(row, vis)
  }
  for (const inc of includes ?? []) {
    if (inc.kind === 'hasMany') {
      const idsCol = inc.idsColumn ?? ''
      const ids = vis[idsCol]
      delete row[idsCol]
      if (Array.isArray(ids)) {
        const children: Array<Record<string, unknown>> = []
        for (const id of ids) {
          const child = projectRow(store, inc.table, id as EntityPk, inc.fields ?? null, inc.includes, deps)
          if (child) children.push(child) // a destroyed child drops out live
        }
        row[inc.name] = children
      }
    } else if (inc.kind === 'belongsTo') {
      const fkVal = vis[inc.fk]
      if (fkVal !== null && fkVal !== undefined) {
        const child = projectRow(store, inc.table, fkVal as EntityPk, inc.fields ?? null, inc.includes, deps)
        if (child) row[inc.name] = child
      }
    }
    // hasOne: see jsdoc — no store-side FK index; omitted from projection.
  }
  return row
}

/**
 * Live rows for a columnar door's list surfaces: subscribes to every record
 * the projection touches (owners AND re-nested children) via
 * useSyncExternalStore and materializes door-masked row objects, parallel to
 * `pks` (an evicted/gone pk yields undefined in its slot — membership
 * refetch reconciles). THIS is the documented P6 deviation: flag-on rows
 * update live as fresher merges land, from any surface.
 *
 * Subscriptions double as eviction pins (the store never evicts a mounted
 * key), and the dependency set re-wires itself when a recompute discovers
 * new children. Inputs are keyed by VALUE (pks/fields arrays may be fresh
 * identities every render); `spec` should be a module-level constant, as
 * codegen emits.
 */
export function useProjectedRows(
  table: string,
  pks: EntityPk[],
  fields: string[],
  spec?: WireSpec,
  store: EntityStore = entityStore,
): Array<Record<string, unknown> | undefined> {
  const pksKey = pks.map(String).join('\u0001')
  const fieldsKey = fields.join('\u0001')
  const { subscribe, getSnapshot } = useMemo(() => {
    const pksLocal = [...pks]
    const fieldsLocal = [...fields]
    let snapshot: Array<Record<string, unknown> | undefined> | null = null
    let deps: DepMap = new Map()
    const getSnapshot = (): Array<Record<string, unknown> | undefined> => {
      if (snapshot === null) {
        const nextDeps: DepMap = new Map()
        snapshot = pksLocal.map(pk => projectRow(store, table, pk, fieldsLocal, spec?.includes, nextDeps))
        deps = nextDeps
      }
      return snapshot
    }
    const subscribe = (onChange: () => void): (() => void) => {
      const subs = new Map<string, () => void>()
      let disposed = false
      let scheduled = false
      const sync = (): void => {
        if (disposed) return
        getSnapshot() // repopulates deps when invalidated
        for (const [key, un] of subs) if (!deps.has(key)) { un(); subs.delete(key) }
        for (const [key, [t, p]] of deps) {
          if (!subs.has(key)) subs.set(key, store.subscribe(t, p, onNotify))
        }
      }
      const onNotify = (): void => {
        snapshot = null
        if (!scheduled) {
          scheduled = true
          // Re-wire AFTER the store's coalesced flush — one recompute per
          // burst, and newly-discovered children get subscribed.
          queueMicrotask(() => { scheduled = false; sync() })
        }
        onChange()
      }
      sync()
      return () => {
        disposed = true
        for (const un of subs.values()) un()
        subs.clear()
      }
    }
    return { subscribe, getSnapshot }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, table, pksKey, fieldsKey, spec])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
