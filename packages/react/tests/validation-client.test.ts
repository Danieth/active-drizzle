/**
 * The WS3 validation client — unit coverage of the ONE dispatch module
 * (`revalidateProjection`) with stub transports, plus the membership
 * structure-token guard (`shareMembershipData`).
 *
 * The pipeline under test (DESIGN-transport-work WS3, client half):
 * signal ⇒ echo-merge skip ⇒ unheld-fields fetch ⇒ W = projFreshAt ⇒
 * certify / destroy / mergeEnvelope. The real-PG end-to-end drive of the
 * same module lives in transport-forbidden-corruption.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { EntityStore, lastSeenOf, isGone, projFreshAt } from '../src/entity-store.js'
import {
  revalidateProjection,
  shareMembershipData,
  type ProjectionValidator,
  type ValidateResponse,
} from '../src/validation-client.js'

const P = ['id', 'title', 'stage']
const MODEL = 'vc_loans'

function envelopeAt(id: number, token: number, title: string, stage: number) {
  return {
    membership: { pks: [id] },
    entities: { [MODEL]: { k: ['id', 'title', 'stage'], v: [token], r: [[id, title, stage]] } },
  }
}

function specWith(overrides: Partial<ProjectionValidator> = {}): {
  spec: ProjectionValidator
  calls: { validate: any[]; fetch: any[] }
} {
  const calls = { validate: [] as any[], fetch: [] as any[] }
  const spec: ProjectionValidator = {
    model: MODEL,
    fields: P,
    projId: 'abcdef012345',
    validate: async input => {
      calls.validate.push(input)
      return { status: 'fresh', v: input.ifNoneMatch }
    },
    fetch: async id => {
      calls.fetch.push(id)
      return envelopeAt(id as number, 9, 'fetched', 1)
    },
    ...overrides,
  }
  return { spec, calls }
}

function seed(store: EntityStore, id: number, token: number): void {
  store.merge(MODEL, id, { id, title: 'T', stage: 0 }, { version: token })
}

describe('revalidateProjection — the dispatch pipeline', () => {
  it('unheld projection ⇒ FETCH, never validate (no lawful W exists)', async () => {
    const store = new EntityStore()
    const { spec, calls } = specWith()
    const out = await revalidateProjection(store, spec, 1)
    expect(out).toEqual({ outcome: 'fetched' })
    expect(calls.fetch).toEqual([1])
    expect(calls.validate).toEqual([])                    // never validated
    expect(store.get(MODEL, 1)!.fields['title']).toBe('fetched')  // merged via the ONE decoder
  })

  it('PARTIALLY held projection ⇒ fetch too (projFreshAt is null when ANY mask field is unheld)', async () => {
    const store = new EntityStore()
    store.merge(MODEL, 1, { id: 1, title: 'T' }, { version: 2 })   // stage unheld
    const { spec, calls } = specWith()
    const out = await revalidateProjection(store, spec, 1)
    expect(out).toEqual({ outcome: 'fetched' })
    expect(calls.validate).toEqual([])
  })

  it('echo-merge skip: a current projection costs zero round trips (§4 path 2)', async () => {
    const store = new EntityStore()
    seed(store, 1, 2)
    const { spec, calls } = specWith()
    const out = await revalidateProjection(store, spec, 1)
    expect(out).toEqual({ outcome: 'current' })
    expect(calls.validate).toEqual([])
    expect(calls.fetch).toEqual([])
  })

  it('a signal whose values already arrived by echo also skips (the echo-merge skip)', async () => {
    const store = new EntityStore()
    seed(store, 1, 5)                                     // echo already merged token 5
    const { spec, calls } = specWith()
    const out = await revalidateProjection(store, spec, 1, { signal: 5 })
    expect(out).toEqual({ outcome: 'current' })
    expect(calls.validate).toEqual([])
  })

  it('a stale-making signal validates with W = projFreshAt (the coverage watermark, never knownVersion) and certifies at the SAME W', async () => {
    const store = new EntityStore()
    seed(store, 1, 2)
    const { spec, calls } = specWith({
      validate: async input => {
        calls.validate.push(input)
        return { status: 'fresh', v: 5 } as ValidateResponse
      },
    })
    const out = await revalidateProjection(store, spec, 1, { signal: 5 })
    expect(calls.validate).toEqual([{ id: 1, projId: 'abcdef012345', ifNoneMatch: 2 }])  // W = 2, NOT the rumor 5
    expect(out).toEqual({ outcome: 'fresh', v: 5 })
    const entry = store.get(MODEL, 1)!
    for (const f of P) expect(lastSeenOf(entry, f)).toBe(5)        // certified at V
    expect(entry.knownVersion).toBe(5)
  })

  it('force bypasses the currency skip (reconnect revalidation)', async () => {
    const store = new EntityStore()
    seed(store, 1, 2)
    const { spec, calls } = specWith({
      validate: async input => {
        calls.validate.push(input)
        return { status: 'fresh', v: 2 } as ValidateResponse
      },
    })
    const out = await revalidateProjection(store, spec, 1, { force: true })
    expect(calls.validate).toHaveLength(1)
    expect(out).toEqual({ outcome: 'fresh', v: 2 })
  })

  it('gone(D) ⇒ destroy floor (M2) — a real destroy token, never a removal', async () => {
    const store = new EntityStore()
    seed(store, 1, 0)
    const { spec } = specWith({
      validate: async () => ({ status: 'gone', d: 3 }) as ValidateResponse,
    })
    const out = await revalidateProjection(store, spec, 1, { signal: 3 })
    expect(out).toEqual({ outcome: 'gone', d: 3 })
    expect(isGone(store.get(MODEL, 1)!)).toBe(true)
  })

  it('stale ⇒ the slice merges through mergeEnvelope and W self-heals past the interval', async () => {
    const store = new EntityStore()
    seed(store, 1, 0)
    const { spec } = specWith({
      validate: async () => ({ status: 'stale', envelope: envelopeAt(1, 2, 'rev', 4) }) as any,
    })
    const out = await revalidateProjection(store, spec, 1, { signal: 2 })
    expect(out).toEqual({ outcome: 'stale' })
    const entry = store.get(MODEL, 1)!
    expect(entry.fields['title']).toBe('rev')
    expect(projFreshAt(entry, P)).toBe(2)                 // self-healing: W advanced to V
  })

  it('scope-miss NOT_FOUND ⇒ legacy eviction — no floor is fabricated (T4)', async () => {
    const store = new EntityStore()
    seed(store, 1, 0)
    const { spec } = specWith({
      validate: async () => { throw Object.assign(new Error('nf'), { code: 'NOT_FOUND' }) },
    })
    const out = await revalidateProjection(store, spec, 1, { signal: 2 })
    expect(out).toEqual({ outcome: 'evicted' })
    expect(store.get(MODEL, 1)).toBeUndefined()
    // legacy removal, not a floor: an old payload can re-merge (no resurrection guard)
    store.merge(MODEL, 1, { id: 1, title: 'back' }, { version: 0 })
    expect(store.get(MODEL, 1)!.fields['title']).toBe('back')
  })

  it('NOT_FOUND on the unheld FETCH lane evicts too', async () => {
    const store = new EntityStore()
    const { spec, calls } = specWith({
      fetch: async () => { throw Object.assign(new Error('nf'), { code: 'NOT_FOUND' }) },
    })
    const out = await revalidateProjection(store, spec, 7)
    expect(out).toEqual({ outcome: 'evicted' })
    expect(calls.validate).toEqual([])
  })

  it('the M4 replay: an in-flight 304 whose cells regressed below the issue-time W certifies NOTHING', async () => {
    const store = new EntityStore()
    seed(store, 1, 1)                                     // W will be 1
    const { spec } = specWith({
      validate: async input => {
        expect(input.ifNoneMatch).toBe(1)
        // While the 304 is "in flight": evict + a REPLAYED stale payload
        // re-merges at token 0 — lastSeen(P) falls below the issue-time W.
        store.remove(MODEL, 1)
        store.merge(MODEL, 1, { id: 1, title: 'stale-replay', stage: 0 }, { version: 0 })
        return { status: 'fresh', v: 2 } as ValidateResponse
      },
    })
    const out = await revalidateProjection(store, spec, 1, { signal: 2 })
    expect(out).toEqual({ outcome: 'fresh', v: 2 })
    const entry = store.get(MODEL, 1)!
    // The store's apply-time guard (fed the SAME W the request was issued
    // with) refused every cell: the stale value is never stamped V.
    for (const f of P) expect(lastSeenOf(entry, f)).toBe(0)
    expect(entry.fields['title']).toBe('stale-replay')
  })

  it('a non-union response is a teaching error naming the expected shapes', async () => {
    const store = new EntityStore()
    seed(store, 1, 0)
    const { spec } = specWith({ validate: async () => ({ ok: true }) as any })
    await expect(revalidateProjection(store, spec, 1, { signal: 1 }))
      .rejects.toThrow(/tagged union.*fresh.*gone.*stale/s)
  })

  it('other transport errors propagate untouched (no silent eviction)', async () => {
    const store = new EntityStore()
    seed(store, 1, 0)
    const { spec } = specWith({
      validate: async () => { throw Object.assign(new Error('boom'), { code: 'INTERNAL_SERVER_ERROR' }) },
    })
    await expect(revalidateProjection(store, spec, 1, { signal: 1 })).rejects.toThrow('boom')
    expect(store.get(MODEL, 1)).toBeDefined()
  })
})

// ── shareMembershipData — the structure-token guard ──────────────────────────

describe('shareMembershipData (membership structure-ETag, client half)', () => {
  const page = (token: string, pks: number[], extra: Record<string, unknown> = {}) => ({
    membership: { structureToken: token, tag: 4, pks, pagination: { page: 1, hasMore: false }, ...extra },
  })

  it('token equality preserves the WHOLE previous data object when passengers are unchanged (zero re-render)', () => {
    const prev = page('aaaa', [1, 2, 3])
    const next = page('aaaa', [1, 2, 3])
    expect(shareMembershipData(prev, next)).toBe(prev)
  })

  it('token equality with moved passengers keeps pks + pagination IDENTITY but takes the fresh facets', () => {
    const prev = page('aaaa', [1, 2, 3], { facets: { stage: { open: 12 } } })
    const next = page('aaaa', [1, 2, 3], { facets: { stage: { open: 11 } } })
    const out: any = shareMembershipData(prev, next)
    expect(out).not.toBe(prev)
    expect(out.membership.pks).toBe(prev.membership.pks)                 // structural identity survives
    expect(out.membership.pagination).toBe(prev.membership.pagination)
    expect(out.membership.facets).toEqual({ stage: { open: 11 } })       // facets are NOT frozen by the token
  })

  it('a different token passes the new data through untouched', () => {
    const prev = page('aaaa', [1, 2, 3])
    const next = page('bbbb', [1, 2, 3, 4])
    expect(shareMembershipData(prev, next)).toBe(next)
  })

  it('absent tokens (non-columnar / legacy responses) pass through', () => {
    const prev = { membership: { pks: [1] } }
    const next = { membership: { pks: [1] } }
    expect(shareMembershipData(prev, next)).toBe(next)
  })

  it('infinite shape: pages share pairwise, and an all-equal refetch keeps the whole InfiniteData identity', () => {
    const prev = { pages: [page('aaaa', [1, 2]), page('cccc', [3, 4])], pageParams: [0, 1] }
    const same = { pages: [page('aaaa', [1, 2]), page('cccc', [3, 4])], pageParams: [0, 1] }
    expect(shareMembershipData(prev, same)).toBe(prev)

    const moved = { pages: [page('aaaa', [1, 2]), page('dddd', [3, 4, 5])], pageParams: [0, 1] }
    const out: any = shareMembershipData(prev, moved)
    expect(out).not.toBe(prev)
    expect(out.pages[0]).toBe(prev.pages[0])              // untouched page keeps identity
    expect(out.pages[1].membership.pks).toEqual([3, 4, 5])
  })
})
