/**
 * The entity store — identity, normalized: [model, pk] → the record.
 *
 * React Query stays the MEMBERSHIP layer (which pks, in what order, with
 * what aggregates — async lifecycle, dedupe, pagination). This store is
 * the IDENTITY layer: one write updates every surface that renders the
 * record. DESIGN-entity-store.md carries the contract; the merge
 * semantics are Rule M of DESIGN-transport-proof.md §3 (the proof IS the
 * spec). The invariants:
 *
 *   I1 single origin — only generated response handlers call merge();
 *      app code has no write path
 *   I2 monotonic, PER FIELD (Rule M1) — a payload at token V writes
 *      field f iff V ≥ lastSeen(f); fields outside the payload are
 *      untouched (absence is projection, never null). Deletion is a
 *      monotone FLOOR, not a tombstone: a cell renders iff
 *      lastSeen(f) > floor, so no delivery order resurrects a
 *      pre-delete cell (T2). Token-less merges take the named UNTRACKED
 *      lane: arrival-order (today's RQ guarantee — never worse), and an
 *      untracked overwrite DEMOTES a tracked cell (T4: no value ever
 *      keeps a token it was not read with).
 *   I3 optimism never enters — pending intents compose at render via
 *      composeEntity(); there is no write path from intents to truth
 *   I5 membership never guessed — the store holds records, not lists;
 *      pk-sets/aggregates stay in React Query
 *   eviction safety — LRU evicts only UNPINNED entities; live queries
 *      retain() their referents. The deletion floor SURVIVES eviction
 *      (compact side map — O12).
 *
 * Backend-agnostic by construction: models are names, pks are opaque
 * string|number, tokens are opaque numeric-comparable lock ints — a
 * model backed by Postgres, an external API, or a queue merges
 * identically.
 */
import { useSyncExternalStore } from 'react'

export type EntityPk = string | number

/** Attr kind, for kind-aware fieldTicks equality + the flat-row contract. */
export type FieldKind = 'scalar' | 'jsonb' | 'pkArray'

/**
 * Entry = (floor, cells) per proof §3, with the cell map split into the
 * value bag + a (defaultToken + exceptions) lastSeen encoding. floor and
 * knownVersion are RENDER COPIES denormalized onto the entry so the
 * interpretation functions are pure over one object (useSyncExternalStore
 * snapshot identity); the authorities are the store's compact side maps
 * (floors survive eviction, rumors are droppable).
 */
export interface EntityEntry {
  model: string
  pk: EntityPk
  /** Union of held cells (L3: cells dead under the floor are GC'd). */
  fields: Record<string, unknown>
  /** Monotone deletion floor; -Infinity = never destroyed. */
  floor: number
  /** Greatest token ever HEARD — a rumor bound, never a freshness claim
   *  (M3); -Infinity = never heard. */
  knownVersion: number
  /** lastSeen for every held field NOT in seenExcept; null = the whole
   *  entry is on the UNTRACKED legacy lane (no tokened merge yet). */
  seenDefault: number | null
  /** Per-field lastSeen exceptions (-Infinity marks an untracked cell);
   *  null until the first divergence (memory: the dominant payload is a
   *  whole row at one token — one number, no exceptions object). */
  seenExcept: Record<string, number> | null
  /** Bumps on every APPLIED merge (stale drops don't tick) — row-level
   *  chrome (a Board card pulse). 1-based. */
  tick: number
  /** PER-FIELD ticks — bumped only when THAT field's value actually
   *  changed (kind-aware equality via registerFieldKinds). Sparse. */
  fieldTicks: Record<string, number>
  /** @deprecated Greatest lastSeen over held cells — kept one cycle for
   *  external barrel consumers. Derived, never merged against. (The old
   *  meaning was "last applied record token"; do not gate on it.) */
  version: number | null
}

export interface MergeOptions {
  /** Lock-int token (number, or numeric string via Number()). This is
   *  the model's per-lineage strictly-increasing commit stamp (A1,
   *  emitted by WS0) — NEVER a timestamp: `updatedAt` is a display
   *  field cosplaying as a Lamport clock (1ms ties, not
   *  framework-maintained — landmine 12). Non-numeric values dev-throw
   *  a teaching error; in prod they warn once and fall to the UNTRACKED
   *  lane. Omit for the UNTRACKED arrival-order lane. */
  version?: number | string | null
}

const keyOf = (model: string, pk: EntityPk): string => `${model} ${String(pk)}`
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Teaching throws fire only under an EXPLICIT non-production NODE_ENV
 *  (vitest/jest set `test`, bundlers define `development`). A missing
 *  `process` global (raw browser ESM, no bundler define) must never turn
 *  the throw path on in someone's production bundle — the store never
 *  threw before WS1, so the prod-safe polarity is warn, not throw. */
const DEV: boolean =
  typeof process !== 'undefined' &&
  typeof process.env?.NODE_ENV === 'string' &&
  process.env.NODE_ENV !== 'production'

const warned = new Set<string>()
function warnOnce(msg: string): void {
  if (warned.has(msg)) return
  warned.add(msg)
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/** Sentinel inside seenExcept marking a held-but-untracked cell. */
const UNTRACKED = -Infinity

// ─── Interpretation I — pure functions over one entry (rendering, not state) ──

/** lastSeen of a held, tracked cell; null = unheld or untracked. */
export function lastSeenOf(e: EntityEntry, f: string): number | null {
  if (!hasOwn(e.fields, f)) return null
  if (e.seenDefault === null) return null
  const ex = e.seenExcept ? e.seenExcept[f] : undefined
  const v = ex !== undefined ? ex : e.seenDefault
  return v === UNTRACKED ? null : v
}

/** Cell f is visible iff lastSeen(f) > floor. An untracked held cell has
 *  no token to clear a floor with: visible iff floor === -Infinity. */
export function isVisible(e: EntityEntry, f: string): boolean {
  if (!hasOwn(e.fields, f)) return false
  const ls = lastSeenOf(e, f)
  if (ls === null) return e.floor === -Infinity
  return ls > e.floor
}

/** The record renders as GONE iff no cell is visible and a floor exists.
 *  There is no tombstone object — "deleted" is this interpretation. */
export function isGone(e: EntityEntry): boolean {
  if (e.floor === -Infinity) return false
  for (const f of Object.keys(e.fields)) if (isVisible(e, f)) return false
  return true
}

/** Field f is current iff visible and lastSeen(f) ≥ knownVersion (the
 *  rumor bound). Untracked cells are never current. */
export function isCurrent(e: EntityEntry, f: string): boolean {
  if (!isVisible(e, f)) return false
  const ls = lastSeenOf(e, f)
  return ls !== null && ls >= e.knownVersion
}

/** The projection's coverage watermark: min lastSeen over its fields —
 *  what goes out as If-None-Match (wire-identity §3a.4). null when any
 *  field is unheld or untracked (=> the projection is not 304-able). */
export function projFreshAt(e: EntityEntry, fields: string[]): number | null {
  let min = Infinity
  for (const f of fields) {
    const ls = lastSeenOf(e, f)
    if (ls === null) return null
    if (ls < min) min = ls
  }
  return min === Infinity ? null : min
}

/** The render bag: held fields masked by isVisible. An explicit pure
 *  call — NEVER computed inside get()/snapshots (fresh objects per read
 *  would infinite-loop useSyncExternalStore). */
export function visibleFields(e: EntityEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [f, v] of Object.entries(e.fields)) if (isVisible(e, f)) out[f] = v
  return out
}

// ─── lastSeen codec: seenDefault + exceptions ────────────────────────────────

/** Materialize the per-field lastSeen of TRACKED held cells (untracked
 *  cells are simply absent from the result). */
function decodeSeen(e: EntityEntry): Record<string, number> {
  const out: Record<string, number> = {}
  if (e.seenDefault === null) return out
  for (const f of Object.keys(e.fields)) {
    const ex = e.seenExcept ? e.seenExcept[f] : undefined
    const v = ex !== undefined ? ex : e.seenDefault
    if (v !== UNTRACKED) out[f] = v
  }
  return out
}

/** Re-encode (renormalize) a materialized lastSeen map: modal token as
 *  seenDefault, everything else (incl. untracked markers) as exceptions.
 *  Recomputed per write — O(fields), which merge already costs — so the
 *  encoding can never drift from the naive per-field reference model. */
function encodeSeen(
  seen: Record<string, number>,
  held: string[],
): { seenDefault: number | null; seenExcept: Record<string, number> | null } {
  const tracked = Object.keys(seen)
  if (tracked.length === 0) return { seenDefault: null, seenExcept: null }
  // Fast path — the dominant shape the encoding was designed for: every
  // held cell tracked at ONE token (whole-row merges). No Map, no modal
  // count, no exceptions object.
  let uniform: number | null = seen[tracked[0]!]!
  for (const f of tracked) if (seen[f] !== uniform) { uniform = null; break }
  if (uniform !== null && tracked.length === held.length) {
    return { seenDefault: uniform, seenExcept: null }
  }
  const counts = new Map<number, number>()
  let modal = seen[tracked[0]!]!
  let best = 0
  for (const f of tracked) {
    const v = seen[f]!
    const c = (counts.get(v) ?? 0) + 1
    counts.set(v, c)
    if (c > best) { best = c; modal = v }
  }
  let except: Record<string, number> | null = null
  for (const f of held) {
    const v = hasOwn(seen, f) ? seen[f]! : UNTRACKED
    if (v !== modal) { (except ??= {})[f] = v }
  }
  return { seenDefault: modal, seenExcept: except }
}

/** @deprecated derivation: max lastSeen over held tracked cells. */
function derivedVersion(seen: Record<string, number>): number | null {
  let max: number | null = null
  for (const v of Object.values(seen)) if (max === null || v > max) max = v
  return max
}

interface FloorRec { model: string; pk: EntityPk; floor: number; touched: number }

const RUMOR_CAP = 1024

export class EntityStore {
  private entries = new Map<string, EntityEntry>()          // Map preserves insertion order → LRU
  private listeners = new Map<string, Set<() => void>>()
  private pins = new Map<string, number>()                  // key → pin count
  private pending = new Map<string, number>()               // key → in-flight write count
  private revs = new Map<string, number>()                  // key → notification revision (status snapshots)
  /** pk → floor AUTHORITY (O12): NEVER LRU-evicted — a floor outliving
   *  its entry is exactly what makes T2 hold across eviction. Pruned
   *  only by the floorRetention policy. */
  private floors = new Map<string, FloorRec>()
  /** knownVersion for entry-less pks (M3 on a never-fetched pk). Bounded
   *  and DROPPABLE: a lost rumor only delays staleness detection, never
   *  corrupts — contrast floors, whose loss can resurrect. */
  private rumors = new Map<string, number>()
  private kinds = new Map<string, Record<string, FieldKind>>()
  private dirty = new Set<string>()                         // notify coalescing (per microtask)
  private flushScheduled = false
  private writeRev = 0                                      // store-revision clock (no wall clocks)
  private readonly capacity: number
  private readonly floorRetention: number

  /**
   * @param opts.capacity LRU entry capacity (default 5000).
   * @param opts.floorRetention How many store WRITE REVISIONS a floor is
   *   retained after it was last touched (destroyed, imported, evicted,
   *   or consulted by any Rule-M write on its key — merge, signal,
   *   certify all keep a live record's floor alive). Default Infinity —
   *   floors are kept forever.
   *   THE SAFETY INEQUALITY: a finite retention MUST dominate the
   *   maximum number of store writes that can occur while a stale
   *   pre-delete payload can still arrive — max in-flight requests +
   *   retries + an IndexedDB restore holding a GET. BE EXPLICIT ABOUT
   *   THE TRADE: 𝒞w payload delay is unbounded (a suspended tab's WS
   *   buffer, a replayed offline queue), so NO finite retention closes
   *   T2 from inside the model — finiteness trades a reopened
   *   resurrection window for bounded memory. Configure it only when
   *   that trade is intended; the default is the safe one. Revision-
   *   distance, not wall clock: the model has no physical clocks.
   */
  constructor(opts: { capacity?: number; floorRetention?: number } = {}) {
    this.capacity = opts.capacity ?? 5000
    this.floorRetention = opts.floorRetention ?? Infinity
  }

  /**
   * Codegen registers Attr kinds once per model (WS2 emits one call per
   * generated client-model module). Powers kind-aware fieldTicks
   * equality (jsonb re-sends are new object identities every payload —
   * structural compare stops spurious presenter flashes) and the
   * flat-row contract: on a REGISTERED model, an object-valued field not
   * declared jsonb/pkArray dev-throws (the nested-envelope poisoning
   * guard, wire-identity §3). Unregistered models keep scalar !== —
   * today's behavior.
   */
  registerFieldKinds(model: string, kinds: Record<string, FieldKind>): void {
    this.kinds.set(model, { ...kinds })
  }

  // ─── Rule M — one public method per rule; all writes funnel through
  //     one private join + rebuild step (applyJoin). ──────────────────────────

  /**
   * M1 (live payload F at V): per-field join — write f iff
   * V ≥ lastSeen(f), then lastSeen(f) = V. Fields outside the payload
   * are untouched (absence is projection, never null; null travels as
   * an explicit cell). Returns true iff ANY field was admitted — note
   * two edges: a knownVersion-only advance (empty or wholly-vacuous
   * payload at a fresh token) commits and notifies yet returns false,
   * and an exact duplicate delivery (same values, same token) returns
   * true WITHOUT committing (no tick, no notify — network duplicates
   * are routine on 𝒞w and must not pulse chrome).
   * Token-less calls take the UNTRACKED lane: arrival-order value
   * writes — such cells render (until a floor exists) but are never
   * `current` and never 304-able. An untracked write over a TRACKED
   * cell DEMOTES it to untracked (deletes its lastSeen): keeping the
   * old token would assert the new value was true at a commit it was
   * never read from (T4), making a stale value 304-certifiable.
   * ONLY generated response handlers call this (I1).
   */
  merge(model: string, pk: EntityPk, fields: Record<string, unknown>, opts: MergeOptions = {}): boolean {
    const key = keyOf(model, pk)
    const V = this.tokenOf(opts.version, `merge(${model}, ${String(pk)})`)
    if (DEV) this.checkFlatRow(model, pk, fields)

    const existing = this.entries.get(key)
    const floor = this.floorOf(key, existing)
    const seen: Record<string, number> = existing ? decodeSeen(existing) : {}
    const prevFields = existing?.fields ?? {}
    let knownVersion = existing?.knownVersion ?? this.rumors.get(key) ?? -Infinity
    const prevKnown = knownVersion

    const nextFields: Record<string, unknown> = { ...prevFields }
    const fieldTicks = { ...(existing?.fieldTicks ?? {}) }
    let admitted = false
    let moved = false                                        // did anything OBSERVABLE change?

    if (V === null) {
      // UNTRACKED lane — isolated and named: today's arrival-order
      // last-write-wins.
      if (DEV && floor > -Infinity) {
        warnOnce(
          `[entity-store] merge(${model}, ${String(pk)}) without a version token on a DESTROYED record ` +
          `(floor ${floor}): the values were DISCARDED — an untracked cell cannot clear a deletion ` +
          `floor, and L3 GC drops it in the same commit (this is the no-resurrection guarantee, ` +
          `DESIGN-transport-proof.md T2). Pass the lock-int token so the write can prove it post-dates ` +
          `the destroy.`,
        )
      }
      if (DEV) {
        const ua = fields['updatedAt']
        const numericAble =
          (typeof ua === 'number' && Number.isFinite(ua)) ||
          (typeof ua === 'string' && (Number.isFinite(Number(ua)) || Number.isFinite(Date.parse(ua))))
        if (numericAble) {
          warnOnce(
            `[entity-store] merge(${model}, …) is version-less but its payload carries a numeric-able ` +
            `updatedAt. The old updatedAt→version fallback is DELETED (updatedAt is a display field ` +
            `cosplaying as a Lamport clock — landmine 12, DESIGN-transport-work.md §6): this payload ` +
            `took the UNTRACKED arrival-order lane, so out-of-order responses are no longer dropped. ` +
            `Thread the model's lock-int token (WS2) to restore monotonic stale-drop.`,
          )
        }
      }
      for (const [f, v] of Object.entries(fields)) {
        // fieldTicks stay silent on entry CREATION (first paint is not a flash)
        const changed = !existing || !this.kindEquals(model, f, nextFields[f], v)
        if (existing && changed) fieldTicks[f] = (fieldTicks[f] ?? 0) + 1
        nextFields[f] = v
        if (changed) moved = true
        if (hasOwn(seen, f)) {
          // DEMOTE an overwritten tracked cell to UNTRACKED (T4): the old
          // lastSeen must never certify a value it was not read with —
          // the cell keeps rendering arrival-order but drops out of
          // isCurrent/projFreshAt/certify (and hides under any floor).
          delete seen[f]
          moved = true
        }
      }
      admitted = true
    } else {
      for (const [f, v] of Object.entries(fields)) {
        const ls = hasOwn(seen, f) ? seen[f]! : -Infinity   // untracked/unheld cell: lastSeen = −∞
        if (V >= ls) {                                       // equal-token applies (agreement: A0/L1)
          const changed = !this.kindEquals(model, f, nextFields[f], v)
          if (existing && changed) fieldTicks[f] = (fieldTicks[f] ?? 0) + 1
          nextFields[f] = v
          if (changed || V > ls || !hasOwn(seen, f)) moved = true
          seen[f] = V
          admitted = true
        }
      }
      knownVersion = Math.max(knownVersion, V)               // every payload performs M3's join
    }

    if (!admitted && knownVersion === prevKnown) return false // wholly-stale slice: no tick, no notify
    if (existing && !moved && knownVersion === prevKnown) return admitted // exact duplicate: vacuous apply

    this.writeRev++
    this.commitEntry(key, model, pk, existing, nextFields, seen, fieldTicks, floor, knownVersion,
      (existing?.tick ?? 0) + (admitted ? 1 : 0), /*touchLru*/ true)
    return admitted
  }

  /**
   * M2 (destroy at D): floor := max(floor, D) in the AUTHORITY map —
   * cells untouched by the rule; L3 GC then physically drops cells with
   * lastSeen ≤ floor (interpretation-invariant). The floor survives
   * entry eviction (O12). Also performs M3's knownVersion join with D.
   */
  destroy(model: string, pk: EntityPk, token: number): void {
    const D = this.requireToken(token, `destroy(${model}, ${String(pk)})`)
    if (D === null) return
    const key = keyOf(model, pk)
    this.writeRev++
    const rec = this.floors.get(key)
    if (rec) { rec.floor = Math.max(rec.floor, D); rec.touched = this.writeRev }
    else this.floors.set(key, { model, pk, floor: D, touched: this.writeRev })
    this.pruneFloors()

    const existing = this.entries.get(key)
    if (existing) {
      const floor = this.floors.get(key)!.floor
      const knownVersion = Math.max(existing.knownVersion, D)
      this.commitEntry(key, model, pk, existing, { ...existing.fields }, decodeSeen(existing),
        { ...existing.fieldTicks }, floor, knownVersion, existing.tick, /*touchLru*/ false)
    } else {
      this.joinRumor(key, D)
      this.notify(key)                                       // a mounted-but-empty key still learns
    }
  }

  /**
   * M3 (bare signal at V): knownVersion := max(knownVersion, V). Nothing
   * else — signals are rumors, they never certify (a value write here
   * would be the forbidden corruption). Entry-less pks go to the bounded
   * droppable rumor map; no entry is fabricated (a signal storm must not
   * evict real records from the LRU).
   */
  signal(model: string, pk: EntityPk, token: number): void {
    const V = this.requireToken(token, `signal(${model}, ${String(pk)})`)
    if (V === null) return
    const key = keyOf(model, pk)
    const existing = this.entries.get(key)
    if (!existing) { this.joinRumor(key, V); return }
    if (V <= existing.knownVersion) return
    this.writeRev++
    // floorOf, not existing.floor: keeps the FloorRec alive under a finite
    // retention (signal-only traffic must not age a live record's floor
    // out) and re-syncs the render copy from the authority map.
    this.commitEntry(key, model, pk, existing, { ...existing.fields }, decodeSeen(existing),
      { ...existing.fieldTicks }, this.floorOf(key, existing), V, existing.tick, /*touchLru*/ false)
  }

  /**
   * M4, 304 shape (validation response for projection P at V, issued at
   * coverage watermark W = projFreshAt(P) at issue time):
   * lastSeen(f) := max(lastSeen(f), V) for the fields of P **whose
   * lastSeen(f) >= W at apply time** — values untouched. The per-field
   * W guard is load-bearing: a cell evicted/GC'd after the request
   * issued and re-merged from a STALER payload has lastSeen < W, and
   * the in-flight 304 must not certify that value at V (TLC found the
   * 11-state ComponentwiseTruth violation without it; proof M4 + T3
   * case L < W, the O8 amendment). PRECONDITION (dev-throw): every
   * f ∈ P is a held, TRACKED cell — "a 304 never freshens a cell the
   * client does not hold" is the O8 model-check target, enforced at
   * the type of the operation. (M4's other two cases route elsewhere:
   * gone(D) responses call destroy(); dirty slices call merge().)
   * Also joins knownVersion.
   */
  certify(model: string, pk: EntityPk, fields: string[], token: number, watermark: number): void {
    const V = this.requireToken(token, `certify(${model}, ${String(pk)})`)
    const W = this.requireToken(watermark, `certify(${model}, ${String(pk)}) watermark`)
    if (V === null || W === null) return
    if (W > V) {
      const msg =
        `[entity-store] certify(${model}, ${String(pk)}): watermark ${W} exceeds the certified token ${V} — ` +
        `a 304's token is never below the If-None-Match watermark it validated. This response is ill-formed; ` +
        `refusing it whole. (Pass the projFreshAt(P) computed when the request was ISSUED, not a newer one.)`
      if (DEV) throw new Error(msg)
      warnOnce(msg)
      return
    }
    const key = keyOf(model, pk)
    const existing = this.entries.get(key)
    for (const f of fields) {
      const held = existing !== undefined && lastSeenOf(existing, f) !== null
      if (!held) {
        const msg =
          `[entity-store] certify(${model}, ${String(pk)}) for field "${f}": the client does not hold a ` +
          `tracked cell for it — a 304 never freshens a cell the client does not hold ` +
          `(DESIGN-transport-proof.md T3/O8; the If-None-Match watermark must be computed from HELD cells, ` +
          `never from knownVersion). Fetch the slice instead of validating it.`
        if (DEV) throw new Error(msg)
        warnOnce(msg)
        return                                               // ill-formed response: refuse it whole
      }
    }
    if (!existing) return
    const seen = decodeSeen(existing)
    let moved = false
    for (const f of fields) {
      // Apply-time W guard (proof M4, O8 amendment): a cell whose
      // lastSeen fell below the issue-time watermark (eviction/GC +
      // stale re-merge while the 304 was in flight) is NOT the cell
      // the server certified — it receives no certification.
      if (seen[f]! >= W && V > seen[f]!) { seen[f] = V; moved = true }
    }
    const knownVersion = Math.max(existing.knownVersion, V)
    if (!moved && knownVersion === existing.knownVersion) return
    this.writeRev++
    // floorOf for the same reasons as signal(): retention keep-alive +
    // authority re-sync (certify-only traffic on a recreated record).
    this.commitEntry(key, model, pk, existing, { ...existing.fields }, seen,
      { ...existing.fieldTicks }, this.floorOf(key, existing), knownVersion, existing.tick, /*touchLru*/ false)
  }

  /** Bulk-normalize index rows (the generated queryFn interception
   *  point). Notifications coalesce per microtask — an index page never
   *  fires listeners per row. */
  mergeRows(model: string, rows: Array<Record<string, unknown>>, pkField = 'id'): void {
    for (const row of rows) {
      const pk = row?.[pkField]
      if (pk === undefined || pk === null) continue
      this.merge(model, pk as EntityPk, row)
    }
  }

  /**
   * LEGACY untokened evict — deletes the entry, notifies, sets NO floor
   * (today's exact semantics, kept: inventing a floor from knownVersion
   * would violate T4 — every floor must correspond to a real destroy at
   * its token). The resurrection window this leaves open is today's
   * behavior; call sites migrate to destroy(token) as WS2/WS3 hand them
   * real destroy tokens.
   */
  remove(model: string, pk: EntityPk): void {
    const key = keyOf(model, pk)
    if (this.entries.delete(key)) this.notify(key)
    this.pins.delete(key)
  }

  // ─── O12: floor persistence hooks (future IndexedDB restore) ───────────────

  /** Snapshot every floor the store is retaining. */
  exportFloors(): Array<[model: string, pk: EntityPk, floor: number]> {
    return [...this.floors.values()].map(r => [r.model, r.pk, r.floor])
  }

  /** Restore floors. Joins (max) with whatever is already held — a stale
   *  snapshot can NEVER lower a floor learned live (O12: lowering would
   *  re-admit pre-delete cells). SHOULD run before the first merge after
   *  a restore (a merge racing the import can render a pre-delete payload
   *  for a frame), but ordering is no longer load-bearing: any existing
   *  entry whose floor the import raises is reconciled — recommitted
   *  under the new floor (L3 GC + notify) — in this same call. */
  importFloors(rows: Array<[string, EntityPk, number]>): void {
    this.writeRev++
    for (const [model, pk, floor] of rows) {
      if (!Number.isFinite(floor)) continue
      const key = keyOf(model, pk)
      const rec = this.floors.get(key)
      if (rec) { rec.floor = Math.max(rec.floor, floor); rec.touched = this.writeRev }
      else this.floors.set(key, { model, pk, floor, touched: this.writeRev })
      const joined = this.floors.get(key)!.floor
      const existing = this.entries.get(key)
      if (existing && joined > existing.floor) {
        this.commitEntry(key, model, pk, existing, { ...existing.fields }, decodeSeen(existing),
          { ...existing.fieldTicks }, joined, Math.max(existing.knownVersion, joined),
          existing.tick, /*touchLru*/ false)
      }
    }
    this.pruneFloors()
  }

  // ─── unchanged surface ─────────────────────────────────────────────────────

  get(model: string, pk: EntityPk): EntityEntry | undefined {
    const key = keyOf(model, pk)
    const e = this.entries.get(key)
    if (e) { this.entries.delete(key); this.entries.set(key, e) }   // touch recency
    return e
  }

  /**
   * Pin a query's referents against eviction; returns the release fn.
   * A live pk-list's records are ALWAYS resolvable (eviction safety).
   */
  retain(model: string, pks: EntityPk[]): () => void {
    const keys = pks.map(pk => keyOf(model, pk))
    for (const k of keys) this.pins.set(k, (this.pins.get(k) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      for (const k of keys) {
        const n = (this.pins.get(k) ?? 0) - 1
        if (n <= 0) this.pins.delete(k)
        else this.pins.set(k, n)
      }
    }
  }

  /**
   * Mark a record IN FLIGHT (a save/mutation is pending on it) — every
   * surface rendering it can show the saving affordance via
   * useEntityStatus. Counted (concurrent writes stack); returns release.
   */
  markPending(model: string, pk: EntityPk): () => void {
    const key = keyOf(model, pk)
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1)
    this.notify(key)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.pending.get(key) ?? 0) - 1
      if (n <= 0) this.pending.delete(key)
      else this.pending.set(key, n)
      this.notify(key)
    }
  }

  isPending(model: string, pk: EntityPk): boolean {
    return this.pending.has(keyOf(model, pk))
  }

  subscribe(model: string, pk: EntityPk, cb: () => void): () => void {
    const key = keyOf(model, pk)
    let set = this.listeners.get(key)
    if (!set) { set = new Set(); this.listeners.set(key, set) }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.listeners.delete(key)
    }
  }

  get size(): number { return this.entries.size }

  /** Monotonic per-key revision — the status-hook snapshot (a pending
   *  flip must re-render even though the entry object is unchanged).
   *  Bumps SYNCHRONOUSLY at write time; only listener callbacks coalesce. */
  rev(model: string, pk: EntityPk): number {
    return this.revs.get(keyOf(model, pk)) ?? 0
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** The one private join step every Rule-M method funnels into: builds
   *  the next entry (denormalized render copies included), applies L3 GC
   *  under a floor, stores, evicts, notifies. Every interpretation-
   *  changing write rebuilds the entry EXACTLY ONCE (snapshot identity:
   *  get() returns this stored object until the next write). */
  private commitEntry(
    key: string, model: string, pk: EntityPk,
    existing: EntityEntry | undefined,
    fields: Record<string, unknown>, seen: Record<string, number>,
    fieldTicks: Record<string, number>,
    floor: number, knownVersion: number, tick: number, touchLru: boolean,
  ): void {
    if (floor > -Infinity) {
      // L3 GC: physically drop dead cells (lastSeen ≤ floor; untracked
      // cells have lastSeen −∞). Interpretation-invariant by L3.
      for (const f of Object.keys(fields)) {
        const ls = hasOwn(seen, f) ? seen[f]! : -Infinity
        if (ls <= floor) { delete fields[f]; delete seen[f]; delete fieldTicks[f] }
      }
    }
    const { seenDefault, seenExcept } = encodeSeen(seen, Object.keys(fields))
    const next: EntityEntry = {
      model, pk, fields, floor, knownVersion, seenDefault, seenExcept,
      tick, fieldTicks, version: derivedVersion(seen),
    }
    if (!existing) this.rumors.delete(key)                   // adopted into the entry
    if (touchLru) this.entries.delete(key)                   // re-insert → most-recently-used
    this.entries.set(key, next)
    this.evictIfNeeded()
    this.notify(key)
  }

  /** Floor authority lookup; consulting it keeps the floor alive under a
   *  finite retention (an active record's floor never ages out). */
  private floorOf(key: string, existing: EntityEntry | undefined): number {
    const rec = this.floors.get(key)
    if (rec) { rec.touched = this.writeRev; return rec.floor }
    return existing?.floor ?? -Infinity
  }

  private joinRumor(key: string, V: number): void {
    const cur = this.rumors.get(key)
    if (cur !== undefined && cur >= V) return
    if (cur === undefined && this.rumors.size >= RUMOR_CAP) {
      const oldest = this.rumors.keys().next().value          // droppable by construction (M3)
      if (oldest !== undefined) this.rumors.delete(oldest)
    }
    this.rumors.delete(key)
    this.rumors.set(key, V)
  }

  private pruneFloors(): void {
    if (!Number.isFinite(this.floorRetention)) return
    const horizon = this.writeRev - this.floorRetention
    for (const [key, rec] of this.floors) {
      if (rec.touched < horizon) this.floors.delete(key)
    }
  }

  /** MergeOptions.version → numeric token | null (UNTRACKED lane). */
  private tokenOf(v: number | string | null | undefined, ctx: string): number | null {
    if (v === null || v === undefined) return null
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) return n
    const msg =
      `[entity-store] ${ctx} received a non-numeric version token: ${JSON.stringify(v)}. ` +
      `A version token is the model's LOCK INT — a per-lineage, strictly-increasing integer ` +
      `(DESIGN-transport-proof.md §3, emitted by WS0) — never a timestamp: updatedAt is a display ` +
      `field cosplaying as a Lamport clock (1ms ties, not framework-maintained — landmine 12 in ` +
      `DESIGN-transport-work.md §6). Pass the lock int, or omit \`version\` for the UNTRACKED ` +
      `arrival-order lane.`
    if (DEV) throw new Error(msg)
    warnOnce(msg)
    return null
  }

  /** Token params of destroy/signal/certify: must be a finite number. */
  private requireToken(v: number, ctx: string): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    const msg =
      `[entity-store] ${ctx} requires a finite numeric lock-int token, got ${JSON.stringify(v)} ` +
      `(DESIGN-transport-proof.md §3 — Rule M joins on tokens; there is no untracked lane for ` +
      `lifecycle or certification operations).`
    if (DEV) throw new Error(msg)
    warnOnce(msg)
    return null
  }

  /** Kind-aware value equality for fieldTicks (spurious-flash guard). */
  private kindEquals(model: string, f: string, a: unknown, b: unknown): boolean {
    const kind = this.kinds.get(model)?.[f] ?? 'scalar'
    if (kind === 'scalar') return a === b
    if (a === b) return true
    if (kind === 'pkArray') {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
        a.every((x, i) => x === b[i])
    }
    try { return JSON.stringify(a) === JSON.stringify(b) }    // jsonb: cheap structural
    catch { return false }
  }

  /** Flat-row contract (dev, registered models only): an object-valued
   *  field must be a DECLARED jsonb/pkArray Attr — the nested-envelope
   *  poisoning guard (wire-identity §3). */
  private checkFlatRow(model: string, pk: EntityPk, fields: Record<string, unknown>): void {
    const kinds = this.kinds.get(model)
    if (!kinds) return                                       // unregistered: today's behavior
    for (const [f, v] of Object.entries(fields)) {
      if (v === null || typeof v !== 'object') continue
      const kind = kinds[f]
      if (kind === 'jsonb' || kind === 'pkArray') continue
      throw new Error(
        `[entity-store] merge(${model}, ${String(pk)}): field "${f}" carries an object value but is ` +
        `not declared jsonb/pkArray in registerFieldKinds — rows must be FLAT (a nested association ` +
        `envelope must never poison the identity store; normalize it into its own model's entries ` +
        `instead — DESIGN-wire-identity.md §3).`,
      )
    }
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.capacity) return
    for (const [key, e] of this.entries) {                // oldest first
      if (this.entries.size <= this.capacity) break
      if (this.pins.has(key)) continue                    // NEVER a live referent
      if (this.listeners.has(key)) continue               // …or a mounted one
      this.entries.delete(key)
      // O12: eviction must never be the event that loses a floor. The
      // authority map normally still holds it, but under a finite
      // floorRetention the FloorRec may have been pruned while the
      // entry's render copy survived — re-seed the authority from the
      // entry so a post-eviction pre-delete payload cannot resurrect.
      if (e.floor > -Infinity) {
        const rec = this.floors.get(key)
        if (rec) { rec.floor = Math.max(rec.floor, e.floor); rec.touched = this.writeRev }
        else this.floors.set(key, { model: e.model, pk: e.pk, floor: e.floor, touched: this.writeRev })
      }
    }
  }

  /** rev() bumps SYNCHRONOUSLY (snapshots are correct the moment a write
   *  lands); listener callbacks coalesce into one flush per microtask —
   *  mergeRows over an index page fires each mounted key once. */
  private notify(key: string): void {
    this.revs.set(key, (this.revs.get(key) ?? 0) + 1)
    this.dirty.add(key)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => {
      this.flushScheduled = false
      const keys = [...this.dirty]
      this.dirty.clear()
      for (const k of keys) {
        const set = this.listeners.get(k)
        if (set) for (const cb of [...set]) cb()
      }
    })
  }
}

/** The app-wide store. One per browser tab; tests construct their own. */
export const entityStore = new EntityStore()

/**
 * Compose truth with pending intents (I3): a pure render-time function —
 * the store is NEVER written by intents, so revert = intents draining.
 * Patch order = mutation submission order.
 */
export function composeEntity(
  entry: EntityEntry | undefined,
  pendingPatches: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!entry) return undefined
  if (pendingPatches.length === 0) return entry.fields
  return Object.assign({}, entry.fields, ...pendingPatches)
}

/**
 * The BARE-MINIMUM per-record status, anywhere the record renders:
 * `pending` — a write is in flight right now (show the saving shimmer);
 * `tick` — bumps on every applied truth merge (effect on it → flash).
 * Stable snapshot: recomputed only when the store notifies this key.
 */
export function useEntityStatus(
  model: string,
  pk: EntityPk,
  store: EntityStore = entityStore,
): { pending: boolean; tick: number; entry: EntityEntry | undefined } {
  useSyncExternalStore(
    (cb) => store.subscribe(model, pk, cb),
    () => store.rev(model, pk),
    () => store.rev(model, pk),
  )
  const entry = store.get(model, pk)
  return { pending: store.isPending(model, pk), tick: entry?.tick ?? 0, entry }
}

/** Live-subscribe a component to one record's truth. */
export function useEntity(model: string, pk: EntityPk, store: EntityStore = entityStore): EntityEntry | undefined {
  return useSyncExternalStore(
    (cb) => store.subscribe(model, pk, cb),
    () => store.get(model, pk),
    () => store.get(model, pk),
  )
}
