/**
 * The validation client — transport WS3's CLIENT half (obligation O10; the
 * dispatch pipeline of DESIGN-transport-work WS3: signal ⇒ echo-merge skip ⇒
 * unheld-fields fetch ⇒ W = projFreshAt ⇒ certify / destroy / mergeEnvelope).
 *
 * ONE module (I1/DRY): generated doors call `revalidateProjection` with their
 * codegen-embedded mask + projId and two transport callables; nothing about
 * the three-way protocol lives in generated strings.
 *
 * The pipeline, per (door, pk):
 *
 *   0. signal join   — an optional rumor token (frame signal, touched echo)
 *                      joins knownVersion via store.signal (M3). Rumors never
 *                      certify; they only raise the staleness bound.
 *   1. echo-merge skip — the projection is CURRENT (every mask field's
 *                      lastSeen ≥ knownVersion, wire-identity §3a clause 3)
 *                      ⇒ zero round trips. This is §4 path 2: a signal whose
 *                      values already arrived by echo costs nothing.
 *   2. unheld ⇒ FETCH, never validate — projFreshAt is null when ANY mask
 *                      field is unheld/untracked: there is no lawful W, and
 *                      a 304 must never freshen a cell the client does not
 *                      hold (proof T3/O8 — the store's certify() dev-throws
 *                      on exactly this misuse). The full GET merges through
 *                      mergeEnvelope, the ONE decoder.
 *   3. validate      — `{ id, projId, ifNoneMatch: W }` where W is the
 *                      coverage watermark projFreshAt(P) at ISSUE time,
 *                      deliberately never knownVersion (landmine 3: rumor
 *                      would make the 304 fabricate freshness or loop).
 *   4. dispatch      — fresh(V) ⇒ store.certify(fields, V, W) with the SAME
 *                      issue-time W (the M4 apply-time per-field guard in the
 *                      store then refuses cells that regressed in flight);
 *                      gone(D) ⇒ store.destroy(D) (M2 floor — a REAL destroy
 *                      token, T4); stale ⇒ mergeEnvelope (per-field M1 at the
 *                      slice's token — W advances past the interval,
 *                      self-healing); scope-miss NOT_FOUND ⇒ legacy
 *                      store.remove() eviction, never a fabricated floor.
 *
 * Every branch also raises knownVersion through the store's normal joins.
 *
 * The membership lane rider lives here too: `shareMembershipData` is the
 * client half of the STRUCTURE token (wire-identity §4 — the index-refetch
 * 304 guard). Passed as `structuralSharing` on the generated columnar index
 * queries: token equality means pk-set + order + count + cursor are verified
 * identical, so the previous structural identities survive the confirming
 * refetch (the list neither re-keys nor re-renders); value passengers
 * (facets, chart, metric, the counter tag) still take the fresh response —
 * facets are excluded from the token BY DESIGN and must not be frozen by it.
 */
import { EntityStore, projFreshAt, type EntityPk } from './entity-store.js'
import { mergeEnvelope, type WireEnvelope } from './wire-envelope.js'
import { parseControllerError } from './errors.js'

// ── Wire shapes (mirrors the server's ValidateResult tagged union) ───────────

export type ValidateResponse =
  | { status: 'fresh'; v: number }
  | { status: 'gone'; d: number }
  | { status: 'stale'; envelope: WireEnvelope }

/** A door's compiled validation knowledge + transport callables (emitted by
 *  codegen; the mask/projId twins the server's validatableMask via the shared
 *  projIdFor helper, so the two cannot drift). */
export interface ProjectionValidator {
  /** TABLE name — the store identity space. */
  model: string
  /** The door's validatable mask: pk + exposed physical columns +
   *  belongsTo-FK linkage, MINUS the lock column; hasMany pk-array columns
   *  are excluded by construction (child commits do not bump the owner's
   *  token — list/child freshness rides the membership lane). */
  fields: string[]
  /** projIdFor(fields) — order-insensitive hash of the compiled mask. */
  projId: string
  /** The door's validate procedure (a sibling of show — scope params are the
   *  caller's closure, exactly like every generated transport). */
  validate: (input: { id: EntityPk; projId: string; ifNoneMatch: number }) => Promise<ValidateResponse>
  /** The door's full GET — the fallback lane for unheld projections. */
  fetch: (id: EntityPk) => Promise<unknown>
}

export interface RevalidateOptions {
  /** A rumor token to join FIRST (store.signal, M3) — e.g. a CHANGE-frame or
   *  cross-tab signal's version. The currency skip is then judged against it. */
  signal?: number
  /** Bypass the currency skip (reconnect revalidation must round-trip even
   *  when nothing looks stale — the socket gap is itself the rumor). */
  force?: boolean
}

export type RevalidateOutcome =
  | { outcome: 'current' }            // step 1: already fresh — zero round trips
  | { outcome: 'fetched' }            // step 2: unheld ⇒ full GET merged
  | { outcome: 'fresh'; v: number }   // 304: certified at V
  | { outcome: 'gone'; d: number }    // destroyed at D: floor raised
  | { outcome: 'stale' }              // dirty slice merged
  | { outcome: 'evicted' }            // scope-miss 404: legacy removal

// ── The dispatch ─────────────────────────────────────────────────────────────

export async function revalidateProjection(
  store: EntityStore,
  spec: ProjectionValidator,
  pk: EntityPk,
  opts: RevalidateOptions = {},
): Promise<RevalidateOutcome> {
  if (typeof opts.signal === 'number') store.signal(spec.model, pk, opts.signal)

  const entry = store.get(spec.model, pk)
  const w = entry ? projFreshAt(entry, spec.fields) : null

  if (w === null) {
    // Unheld projection: FETCH, never validate (T3/O8 — no lawful W exists).
    try {
      const env = await spec.fetch(pk)
      mergeEnvelope(store, env as WireEnvelope)
      return { outcome: 'fetched' }
    } catch (e) {
      if (parseControllerError(e)?.isNotFound) {
        store.remove(spec.model, pk)               // scope-miss: legacy eviction,
        return { outcome: 'evicted' }              // never a fabricated floor
      }
      throw e
    }
  }

  // Echo-merge skip (§4 path 2): every mask field current ⇒ no round trip.
  if (!opts.force && w >= entry!.knownVersion) return { outcome: 'current' }

  let res: ValidateResponse
  try {
    res = await spec.validate({ id: pk, projId: spec.projId, ifNoneMatch: w })
  } catch (e) {
    if (parseControllerError(e)?.isNotFound) {
      store.remove(spec.model, pk)
      return { outcome: 'evicted' }
    }
    throw e
  }

  switch (res?.status) {
    case 'fresh':
      // The SAME issue-time W — the store's M4 apply-time guard needs it to
      // refuse cells whose lastSeen regressed while the 304 was in flight.
      store.certify(spec.model, pk, spec.fields, res.v, w)
      return { outcome: 'fresh', v: res.v }
    case 'gone':
      store.destroy(spec.model, pk, res.d)         // M2: a REAL destroy token (T4)
      return { outcome: 'gone', d: res.d }
    case 'stale':
      mergeEnvelope(store, res.envelope)           // the ONE decoder — never a second
      return { outcome: 'stale' }
    default:
      throw new Error(
        `[validation-client] revalidateProjection(${spec.model}, ${String(pk)}): the validate endpoint ` +
        `answered ${JSON.stringify(res)} — expected the WS3 tagged union {status:'fresh',v} | ` +
        `{status:'gone',d} | {status:'stale',envelope}. Is this door's server running the columnar ` +
        `transport (wire: 'columnar' + the migrated write-log tables)?`,
      )
  }
}

// ── Membership structure-token guard (wire-identity §4, client half) ─────────

const jsonEq = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/** One `{ membership, ctx? }` page. Token equality PROVES pk-set + order +
 *  count + cursor identical (the probabilistic grade, declared — landmine
 *  10), so the previous structural identities (pks, pagination) survive;
 *  passengers stay fresh. When nothing else moved either, the previous page
 *  object survives whole — query.data keeps identity, zero re-render. */
function shareMembershipPage(prev: any, next: any): any {
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return next
  const pm = prev.membership
  const nm = next.membership
  const token = nm?.structureToken
  if (typeof token !== 'string' || pm?.structureToken !== token) return next
  const membership = {
    ...nm,
    pks: pm.pks,
    ...(pm.pagination !== undefined ? { pagination: pm.pagination } : {}),
  }
  const merged = { ...next, membership }
  return jsonEq(merged, prev) ? prev : merged
}

/**
 * `structuralSharing` for the generated columnar index queries (flat AND
 * infinite shapes). A confirming refetch whose structure token matches keeps
 * the previous pks/pagination identities (and, when passengers are unchanged
 * too, the whole previous data object) — the client half of "skip list
 * re-render on token equality". Non-columnar/absent tokens pass through.
 */
export function shareMembershipData(oldData: unknown, newData: unknown): unknown {
  if (!oldData || !newData) return newData
  const o = oldData as any
  const n = newData as any
  if (Array.isArray(n?.pages)) {                   // InfiniteData shape
    if (!Array.isArray(o?.pages)) return newData
    const pages = n.pages.map((p: any, i: number) => shareMembershipPage(o.pages[i], p))
    const allSame =
      pages.length === o.pages.length &&
      pages.every((p: any, i: number) => p === o.pages[i]) &&
      jsonEq(n.pageParams, o.pageParams)
    return allSame ? oldData : { ...n, pages }
  }
  return shareMembershipPage(o, n)
}
