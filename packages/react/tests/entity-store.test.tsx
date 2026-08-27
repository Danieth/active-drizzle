/**
 * The entity store — unit contract + the Jepsen-lite property suite.
 *
 * The merge semantics under test are Rule M of DESIGN-transport-proof.md
 * §3 (per-field join, monotone deletion floor, rumor-bound knownVersion,
 * 304 certification). The property tests throw seeded-random
 * interleavings of {slice merges, destroys, removes, pins, evictions,
 * pending intents} at the store and assert:
 *   I2 per-field monotonic (no field ever renders backwards — Rule M1)
 *   T2 no resurrection (a destroy's floor hides every pre-delete cell,
 *      in every delivery order, across eviction — the L2 counterexample
 *      generators)
 *   I3/I4 convergence (truth + drained intents == truth, exactly)
 *   I5 eviction safety (a pinned/mounted record is never evicted)
 *
 * Notification timing: listener callbacks coalesce per microtask (rev()
 * bumps stay synchronous) — tests that count callbacks await flush().
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  EntityStore, composeEntity, useEntity, useEntityStatus,
  lastSeenOf, isVisible, isGone, isCurrent, projFreshAt, visibleFields,
} from '../src/entity-store.js'

// Seeded LCG — deterministic adversary, reproducible failures.
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

/** Fisher–Yates over the SEEDED rng — reproducible shuffles. (Never
 *  `sort(() => rand() - 0.5)`: an inconsistent comparator's order is
 *  engine-defined, so a seed would not reproduce across engines.) */
const shuffle = <T,>(xs: T[], rand: () => number): T[] => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** Rethrow with the seed — the reproduction handle for any red run. */
const withSeed = (seed: number, f: () => void): void => {
  try { f() } catch (err) {
    throw new Error(
      `[seed ${seed}] ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/** Await the store's coalesced notification flush (one per microtask). */
const flush = () => new Promise<void>(r => queueMicrotask(r))

describe('unit contract', () => {
  it('merges SLICES into a union — two doors, one record', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'Acme', amount: '100.00' }, { version: 1000 })
    s.merge('Deal', 5, { stage: 'won' }, { version: 2000 })
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'Acme', amount: '100.00', stage: 'won' })
    expect(s.get('Deal', 5)!.version).toBe(2000)             // deprecated derived: max lastSeen
    expect(lastSeenOf(s.get('Deal', 5)!, 'name')).toBe(1000) // per-field truth (Rule M1)
    expect(lastSeenOf(s.get('Deal', 5)!, 'stage')).toBe(2000)
  })

  it('I2 (Rule M1): a stale slice is gated PER FIELD — fresh fields land, stale fields drop', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'new' }, { version: 2000 })
    // The slice is old, but `extra` is a novel cell (lastSeen = −∞): it lands.
    const applied = s.merge('Deal', 5, { name: 'old', extra: 'x' }, { version: 1000 })
    expect(applied).toBe(true)                                // something was admitted
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'new', extra: 'x' })
    expect(lastSeenOf(s.get('Deal', 5)!, 'name')).toBe(2000)  // never regressed
    expect(lastSeenOf(s.get('Deal', 5)!, 'extra')).toBe(1000)
    // A WHOLLY-stale slice returns false and does not tick.
    const tick = s.get('Deal', 5)!.tick
    expect(s.merge('Deal', 5, { name: 'older', extra: 'y' }, { version: 900 })).toBe(false)
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'new', extra: 'x' })
    expect(s.get('Deal', 5)!.tick).toBe(tick)
  })

  it('equal-token payloads APPLY (V ≥ lastSeen — agreement makes this sound)', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' }, { version: 7 })
    expect(s.merge('Deal', 5, { name: 'a', stage: 'won' }, { version: 7 })).toBe(true)
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'a', stage: 'won' })
  })

  it('unversioned merges are arrival-order (never worse than a document cache)', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    s.merge('Deal', 5, { name: 'b' })
    expect(s.get('Deal', 5)!.fields.name).toBe('b')
    // …even over a tracked cell — which the untracked write DEMOTES: the
    // old token must not stay attached to a value it was never read with
    // (T4), or a stale index row would become 304-certifiable at a
    // commit it never came from.
    s.merge('Deal', 5, { name: 'c' }, { version: 9 })
    s.merge('Deal', 5, { name: 'd' })
    expect(s.get('Deal', 5)!.fields.name).toBe('d')
    expect(lastSeenOf(s.get('Deal', 5)!, 'name')).toBe(null)  // demoted, not token 9
  })

  it('an untracked overwrite DEMOTES a tracked cell — never current, never 304-able, never certified (T4/T3)', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { amount: 100 }, { version: 20 })       // tokened detail merge
    s.mergeRows('Deal', [{ id: 5, amount: 50 }])               // lagging-replica index refetch, no token
    const e = s.get('Deal', 5)!
    expect(e.fields.amount).toBe(50)                           // arrival-order rendering kept…
    expect(lastSeenOf(e, 'amount')).toBe(null)                 // …but the cell is UNTRACKED now
    expect(isCurrent(e, 'amount')).toBe(false)
    expect(projFreshAt(e, ['amount'])).toBe(null)              // no If-None-Match goes out at 20
    expect(() => s.certify('Deal', 5, ['amount'], 25, 20))         // a 304 can never bless the stale value
      .toThrow(/never freshens a cell the client does not hold/)
  })

  it('an exact duplicate delivery (same values, same token) is a vacuous apply — no tick, no notify, same snapshot', async () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { a: 1, b: 'x' }, { version: 10 })
    await flush()
    const before = s.get('Deal', 5)!
    const seen = vi.fn()
    s.subscribe('Deal', 5, seen)
    expect(s.merge('Deal', 5, { a: 1, b: 'x' }, { version: 10 })).toBe(true)  // admitted (vacuously)
    await flush()
    expect(seen).not.toHaveBeenCalled()                        // 𝒞w duplicates must not pulse chrome
    expect(s.get('Deal', 5)).toBe(before)                      // same snapshot object, same tick
  })

  it('updatedAt is INERT DATA — never sniffed as a version token', () => {
    const s = new EntityStore()
    // The old fallback would have gated on these timestamps; Rule M does
    // not: both merges are untracked, arrival-order wins.
    s.merge('Deal', 5, { name: 'new', updatedAt: '2026-07-24T10:00:00Z' })
    const applied = s.merge('Deal', 5, { name: 'old', updatedAt: '2026-07-24T09:00:00Z' })
    expect(applied).toBe(true)
    expect(s.get('Deal', 5)!.fields.name).toBe('old')          // arrival order, not timestamp order
    expect(s.get('Deal', 5)!.fields.updatedAt).toBe('2026-07-24T09:00:00Z')
    expect(lastSeenOf(s.get('Deal', 5)!, 'name')).toBe(null)   // untracked, never 304-able
  })

  it('a non-numeric version token throws a TEACHING error in dev (landmine 12)', () => {
    const s = new EntityStore()
    expect(() => s.merge('Deal', 5, { name: 'x' }, { version: '2026-07-24T10:00:00Z' }))
      .toThrow(/lock int/i)
    expect(() => s.merge('Deal', 5, { name: 'x' }, { version: '2026-07-24T10:00:00Z' }))
      .toThrow(/DESIGN-transport-proof/)
  })

  it('pks are opaque — string/uuid keys work identically (non-PG future)', () => {
    const s = new EntityStore()
    s.merge('ApiThing', 'ab-12', { x: 1 })
    s.merge('ApiThing', 'ab-13', { x: 2 })
    expect(s.get('ApiThing', 'ab-12')!.fields.x).toBe(1)
    expect(s.get('ApiThing', 'ab-13')!.fields.x).toBe(2)
  })

  it('subscribe fires for ITS key only; remove notifies and clears', async () => {
    const s = new EntityStore()
    const a = vi.fn(); const b = vi.fn()
    s.subscribe('Deal', 1, a)
    s.subscribe('Deal', 2, b)
    s.merge('Deal', 1, { x: 1 })
    await flush()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    s.remove('Deal', 1)
    await flush()
    expect(a).toHaveBeenCalledTimes(2)
    expect(s.get('Deal', 1)).toBeUndefined()
  })

  it('a wholly-stale merge neither notifies nor rebuilds the entry', async () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { x: 'new' }, { version: 5 })
    await flush()
    const seen = vi.fn()
    s.subscribe('Deal', 1, seen)
    const before = s.get('Deal', 1)!
    expect(s.merge('Deal', 1, { x: 'old' }, { version: 1 })).toBe(false)
    await flush()
    expect(seen).not.toHaveBeenCalled()
    expect(s.get('Deal', 1)).toBe(before)                     // same snapshot object
  })

  it('useEntity re-renders on merge with a STABLE snapshot between writes', async () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    const seen: any[] = []
    function Probe() { seen.push(useEntity('Deal', 5, s)?.fields.name); return null }
    render(<Probe />)
    await act(async () => { s.merge('Deal', 5, { name: 'b' }) })
    expect(seen[0]).toBe('a')
    expect(seen[seen.length - 1]).toBe('b')
  })

  it('I3: composeEntity is PURE — intents never touch the store', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { stage: 'draft', name: 'Acme' }, { version: 1 })
    const entry = s.get('Deal', 5)!
    const rendered = composeEntity(entry, [{ stage: 'won' }])
    expect(rendered).toEqual({ stage: 'won', name: 'Acme' })
    expect(s.get('Deal', 5)!.fields.stage).toBe('draft')        // truth untouched
    expect(composeEntity(entry, [])).toBe(entry.fields)          // zero intents → the truth object itself
  })
})

describe('interpretation layer (pure over one entry)', () => {
  it('visible / current / projFreshAt over tracked cells', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { a: 1, b: 2 }, { version: 10 })
    s.merge('Deal', 1, { b: 3 }, { version: 20 })
    const e = s.get('Deal', 1)!
    expect(isVisible(e, 'a')).toBe(true)
    expect(isVisible(e, 'missing')).toBe(false)
    expect(isCurrent(e, 'a')).toBe(false)                     // knownVersion 20 > lastSeen(a) 10
    expect(isCurrent(e, 'b')).toBe(true)
    expect(projFreshAt(e, ['a', 'b'])).toBe(10)               // coverage watermark = min lastSeen
    expect(projFreshAt(e, ['b'])).toBe(20)
    expect(projFreshAt(e, ['a', 'missing'])).toBe(null)       // unheld ⇒ not 304-able
    expect(visibleFields(e)).toEqual({ a: 1, b: 3 })
    expect(isGone(e)).toBe(false)
  })

  it('untracked cells render but are never current, never 304-able', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { a: 1 })                              // untracked lane
    const e = s.get('Deal', 1)!
    expect(lastSeenOf(e, 'a')).toBe(null)
    expect(isVisible(e, 'a')).toBe(true)                      // no floor → still renders
    expect(isCurrent(e, 'a')).toBe(false)
    expect(projFreshAt(e, ['a'])).toBe(null)
  })
})

describe('Rule M: destroy floor, signal, certify (WS1 acceptance)', () => {
  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) =>
      permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))

  it('L2 counterexample: {a@10}·D15·{b@20} converges in ALL 6 orders to (floor 15, renders {b})', () => {
    const ops: Array<(s: EntityStore) => void> = [
      s => s.merge('Deal', 9, { a: 'a@10' }, { version: 10 }),
      s => s.destroy('Deal', 9, 15),
      s => s.merge('Deal', 9, { b: 'b@20' }, { version: 20 }),
    ]
    for (const order of permutations(ops)) {
      const s = new EntityStore()
      for (const op of order) op(s)
      const e = s.get('Deal', 9)!
      expect(e.floor).toBe(15)
      expect(visibleFields(e)).toEqual({ b: 'b@20' })          // a@10 invisible forever (10 ≤ 15)
      expect(isVisible(e, 'a')).toBe(false)
      expect(isGone(e)).toBe(false)
      expect(lastSeenOf(e, 'b')).toBe(20)
    }
  })

  it('D15·B20·A10: the pre-delete cell is NEVER visible at any step (no resurrection through recreation)', () => {
    const s = new EntityStore()
    s.destroy('Deal', 9, 15)
    expect(s.get('Deal', 9)).toBeUndefined()                   // no entry fabricated
    s.merge('Deal', 9, { b: 'b@20' }, { version: 20 })
    expect(isVisible(s.get('Deal', 9)!, 'a')).toBe(false)
    s.merge('Deal', 9, { a: 'a@10' }, { version: 10 })         // stale pre-delete payload arrives last
    const e = s.get('Deal', 9)!
    expect(isVisible(e, 'a')).toBe(false)
    expect(visibleFields(e)).toEqual({ b: 'b@20' })
  })

  it('a destroyed record with no post-delete cells renders GONE (interpretation, not a tombstone)', () => {
    const s = new EntityStore()
    s.merge('Deal', 9, { a: 1 }, { version: 10 })
    s.destroy('Deal', 9, 15)
    const e = s.get('Deal', 9)!
    expect(isGone(e)).toBe(true)
    expect(visibleFields(e)).toEqual({})
    expect(e.fields).toEqual({})                               // L3 GC swept the dead cell
  })

  it('untracked (token-less) cells are hidden once a floor exists — no legacy resurrection', () => {
    const s = new EntityStore()
    s.destroy('Deal', 9, 15)
    s.merge('Deal', 9, { a: 'legacy' })                        // untracked lane after a destroy
    const e = s.get('Deal', 9)!
    expect(isVisible(e, 'a')).toBe(false)
    expect(isGone(e)).toBe(true)
    expect(e.fields).toEqual({})                               // DISCARDED (L3 GC), not stored-but-hidden
  })

  it('the floor BOUNDARY: a cell at lastSeen exactly == floor is dead — both orders, GC agrees with visibility', () => {
    // Interpretation I is strict (`lastSeen > floor`); L2 says destroy at
    // D kills every cell with lastSeen ≤ D, the destroy's own token
    // included. Merge and destroy at the SAME token, in both orders.
    for (const destroyFirst of [true, false]) {
      const s = new EntityStore()
      if (destroyFirst) { s.destroy('Deal', 9, 15); s.merge('Deal', 9, { a: 'a@15' }, { version: 15 }) }
      else { s.merge('Deal', 9, { a: 'a@15' }, { version: 15 }); s.destroy('Deal', 9, 15) }
      const e = s.get('Deal', 9)!
      expect(isVisible(e, 'a')).toBe(false)                    // 15 > 15 is false — strict boundary
      expect(e.fields).toEqual({})                             // and L3 GC physically swept it
      expect(isGone(e)).toBe(true)
    }
  })

  it('the floor SURVIVES entry eviction (O12): evict the destroyed record, re-merge a pre-delete payload, still gone', () => {
    const s = new EntityStore({ capacity: 2 })
    s.merge('Deal', 'victim', { a: 1 }, { version: 10 })
    s.destroy('Deal', 'victim', 15)
    // Churn the LRU until the destroyed entry is evicted.
    for (let i = 0; i < 5; i++) s.merge('Deal', `churn-${i}`, { x: i }, { version: 1 })
    expect(s.get('Deal', 'victim')).toBeUndefined()            // entry gone…
    s.merge('Deal', 'victim', { a: 'stale pre-delete' }, { version: 12 })
    const e = s.get('Deal', 'victim')!
    expect(e.floor).toBe(15)                                   // …floor was not
    expect(isVisible(e, 'a')).toBe(false)
    expect(isGone(e)).toBe(true)
  })

  it('export/importFloors round-trip preserves no-resurrection (the IndexedDB-restore path)', () => {
    const a = new EntityStore()
    a.merge('Deal', 1, { x: 1 }, { version: 10 })
    a.destroy('Deal', 1, 15)
    a.destroy('Post', 'uuid-7', 40)
    const floors = a.exportFloors()
    expect(floors).toContainEqual(['Deal', 1, 15])
    expect(floors).toContainEqual(['Post', 'uuid-7', 40])

    const b = new EntityStore()
    b.importFloors(floors)                                     // MUST run before first merge
    b.merge('Deal', 1, { x: 'pre-delete' }, { version: 12 })
    b.merge('Post', 'uuid-7', { t: 'pre-delete' }, { version: 39 })
    expect(isGone(b.get('Deal', 1)!)).toBe(true)
    expect(isGone(b.get('Post', 'uuid-7')!)).toBe(true)
    b.merge('Deal', 1, { x: 'recreated' }, { version: 20 })    // post-floor lineage renders fine
    expect(visibleFields(b.get('Deal', 1)!)).toEqual({ x: 'recreated' })
  })

  it('importFloors JOINS (max) — a stale snapshot can never LOWER a floor learned live', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { x: 1 }, { version: 10 })
    s.destroy('Deal', 1, 15)                                   // live destroy…
    s.importFloors([['Deal', 1, 10]])                          // …then a stale snapshot restores floor 10
    expect(s.exportFloors()).toContainEqual(['Deal', 1, 15])   // join, not set
    s.merge('Deal', 1, { x: 'pre-delete' }, { version: 12 })
    expect(isGone(s.get('Deal', 1)!)).toBe(true)               // 12 ≤ 15 stays invisible
  })

  it('importFloors AFTER a merge reconciles the existing entry — the ordering rule is healed, not just documented', async () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { x: 'pre-delete' }, { version: 12 })   // restore raced: merge landed first
    await flush()
    const seen = vi.fn()
    s.subscribe('Deal', 1, seen)
    s.importFloors([['Deal', 1, 15]])                          // late import must still hide the cell
    const e = s.get('Deal', 1)!
    expect(e.floor).toBe(15)
    expect(isGone(e)).toBe(true)
    expect(e.fields).toEqual({})                               // reconciled + GC'd in the same call…
    await flush()
    expect(seen).toHaveBeenCalledTimes(1)                      // …and the mounted surface was told
  })

  it('signal (M3) raises ONLY knownVersion — a rumor, never a value; entry-less pks stay entry-less', () => {
    const s = new EntityStore()
    s.signal('Deal', 1, 99)                                    // never fetched: rumor only
    expect(s.get('Deal', 1)).toBeUndefined()
    s.merge('Deal', 1, { a: 1 }, { version: 50 })
    const e = s.get('Deal', 1)!
    expect(e.knownVersion).toBe(99)                            // rumor adopted at entry creation
    expect(isCurrent(e, 'a')).toBe(false)                      // stale against the rumor bound
    expect(e.fields).toEqual({ a: 1 })                         // value untouched by the signal

    s.signal('Deal', 1, 120)
    expect(s.get('Deal', 1)!.knownVersion).toBe(120)
    expect(s.get('Deal', 1)!.fields).toEqual({ a: 1 })
  })

  it('certify (M4/304) advances lastSeen for EXACTLY P — values untouched, cells outside P untouched', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { a: 1, b: 2 }, { version: 10 })
    s.signal('Deal', 1, 30)
    expect(isCurrent(s.get('Deal', 1)!, 'a')).toBe(false)
    s.certify('Deal', 1, ['a'], 30, 10)                            // 304 for projection {a} at 30
    const e = s.get('Deal', 1)!
    expect(lastSeenOf(e, 'a')).toBe(30)
    expect(lastSeenOf(e, 'b')).toBe(10)                        // outside P: untouched
    expect(e.fields).toEqual({ a: 1, b: 2 })                   // values untouched
    expect(isCurrent(e, 'a')).toBe(true)
    expect(isCurrent(e, 'b')).toBe(false)
  })

  it('certify dev-throws on an unheld or untracked cell — a 304 never freshens a cell the client does not hold', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { a: 1 }, { version: 10 })
    expect(() => s.certify('Deal', 1, ['a', 'ghost'], 20, 10))
      .toThrow(/never freshens a cell the client does not hold/)
    expect(lastSeenOf(s.get('Deal', 1)!, 'a')).toBe(10)        // ill-formed response refused WHOLE
    s.merge('Deal', 1, { u: 'untracked' })
    expect(() => s.certify('Deal', 1, ['u'], 20, 10))
      .toThrow(/never freshens a cell the client does not hold/)
  })

  it('a stale 304 (fresher payload raced it) is a no-op join, not a regression', () => {
    const s = new EntityStore()
    s.merge('Deal', 1, { a: 1 }, { version: 20 })
    s.certify('Deal', 1, ['a'], 15, 10)                            // 304 at 15 arrives late — legal on 𝒞r
    expect(lastSeenOf(s.get('Deal', 1)!, 'a')).toBe(20)
  })

  it('the O8 apply-time watermark guard: an in-flight 304 cannot certify a cell that fell below its issue watermark (TLC counterexample)', () => {
    const s = new EntityStore()
    s.merge('Deal', 7, { name: 'fresh' }, { version: 10 })
    const W = projFreshAt(s.get('Deal', 7)!, ['name'])!        // 10 — the If-None-Match that went out
    s.remove('Deal', 7)                                        // entry evicted while the 304 is in flight
    s.merge('Deal', 7, { name: 'stale' }, { version: 4 })      // re-merged from a lagging payload
    s.certify('Deal', 7, ['name'], 12, W)                      // the 304 lands: server certified name@W..12 — but THIS cell is name@4
    const e = s.get('Deal', 7)!
    expect(lastSeenOf(e, 'name')).toBe(4)                      // no certification: 'stale' is not the value at 12
    expect(isCurrent(e, 'name')).toBe(false)
    expect(e.knownVersion).toBe(12)                            // M3's join still happens — the rumor is real
  })

  it('certify refuses W > V whole — a 304 token is never below the watermark it validated', () => {
    const s = new EntityStore()
    s.merge('Deal', 8, { a: 1 }, { version: 10 })
    expect(() => s.certify('Deal', 8, ['a'], 9, 10)).toThrow(/watermark 10 exceeds the certified token 9/)
    const e = s.get('Deal', 8)!
    expect(lastSeenOf(e, 'a')).toBe(10)                        // refused whole: nothing moved
    expect(e.knownVersion).toBe(10)
  })
})

// ── WS1 acceptance properties (DESIGN-transport-work.md WS1) ─────────────────
//
// The six acceptance properties, run as seeded-random suites. Every
// randomized run goes through withSeed(): a failure rethrows with the
// seed in the message, so any red run is reproducible verbatim.

describe('WS1 acceptance properties (seeded; failures log the seed)', () => {
  const FIELDS = ['a', 'b', 'c', 'd'] as const

  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) =>
      permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))

  type Op =
    | { kind: 'merge'; token: number; fields: Record<string, unknown> }
    | { kind: 'destroy'; token: number }
    | { kind: 'signal'; token: number }

  const apply = (s: EntityStore, op: Op): void => {
    if (op.kind === 'merge') s.merge('Deal', 9, op.fields, { version: op.token })
    else if (op.kind === 'destroy') s.destroy('Deal', 9, op.token)
    else s.signal('Deal', 9, op.token)
  }

  const L2_OPS: Op[] = [
    { kind: 'merge', token: 10, fields: { a: 'a@10' } },
    { kind: 'destroy', token: 15 },
    { kind: 'merge', token: 20, fields: { b: 'b@20' } },
  ]

  /** The one convergence point every L2 delivery order must reach. */
  const expectL2Converged = (s: EntityStore): void => {
    const e = s.get('Deal', 9)!
    expect(e.floor).toBe(15)
    expect(visibleFields(e)).toEqual({ b: 'b@20' })            // a@10 invisible forever (10 ≤ 15)
    expect(isVisible(e, 'a')).toBe(false)
    expect(isGone(e)).toBe(false)
    expect(lastSeenOf(e, 'b')).toBe(20)
    expect(e.knownVersion).toBe(20)
  }

  it('1. L2 counterexample: {a@10}·D15·{b@20} in ALL 6 orders converges to (floor 15, renders {b@20})', () => {
    for (const order of permutations(L2_OPS)) {
      const s = new EntityStore()
      for (const op of order) apply(s, op)
      expectL2Converged(s)
    }
  })

  it('1. L2 with DUPLICATION: each payload delivered 2×, 200 seeded shuffles — same convergence point', () => {
    for (let seed = 1; seed <= 200; seed++) withSeed(seed, () => {
      const rand = rng(seed * 2654435761)
      const s = new EntityStore()
      for (const op of shuffle([...L2_OPS, ...L2_OPS], rand)) apply(s, op)
      expectL2Converged(s)
    })
  })

  it('2. resurrection: in EVERY order, once D15 has been applied, field a NEVER renders again — at any step', () => {
    for (const order of permutations(L2_OPS)) {
      const s = new EntityStore()
      let destroyed = false
      for (const op of order) {
        apply(s, op)
        if (op.kind === 'destroy') destroyed = true
        const e = s.get('Deal', 9)
        if (destroyed && e) {
          expect(isVisible(e, 'a')).toBe(false)                // never rendered, not even for a step
          expect('a' in visibleFields(e)).toBe(false)
        }
      }
      expect(isVisible(s.get('Deal', 9)!, 'a')).toBe(false)    // and never at the end
    }
  })

  it('3. certify (304 for P): 200 seeded runs — lastSeen joins for EXACTLY P; outside-P cells and ALL values untouched', () => {
    for (let seed = 1; seed <= 200; seed++) withSeed(seed, () => {
      const rand = rng(seed * 31337)
      const s = new EntityStore()
      for (const f of FIELDS) {                                // hold each field at its own token
        const tok = 1 + Math.floor(rand() * 10)
        s.merge('Deal', 9, { [f]: `${f}@${tok}` }, { version: tok })
      }
      const P = FIELDS.filter(() => rand() < 0.5)
      if (P.length === 0) P.push('a')
      const V = 1 + Math.floor(rand() * 15)                    // can land BELOW a lastSeen — must join, not regress

      const before = s.get('Deal', 9)!
      const beforeSeen = Object.fromEntries(FIELDS.map(f => [f, lastSeenOf(before, f)!]))
      const beforeFields = { ...before.fields }

      const W = Math.min(V, ...P.map(f => beforeSeen[f]!))   // issue-time projFreshAt, capped by V (V >= W always on a real 304)
      s.certify('Deal', 9, P, V, W)
      const e = s.get('Deal', 9)!
      for (const f of FIELDS) {
        expect(lastSeenOf(e, f)).toBe(
          P.includes(f) ? Math.max(beforeSeen[f]!, V) : beforeSeen[f]!)  // exactly P advances; a join, never a set
      }
      expect(e.fields).toEqual(beforeFields)                   // values untouched, no cell created
      expect(e.fieldTicks).toEqual(before.fieldTicks)          // no flash from a 304
      expect(e.tick).toBe(before.tick)
      expect(e.floor).toBe(before.floor)
      expect(e.knownVersion).toBe(Math.max(before.knownVersion, V))

      // A P naming an unheld cell is an ill-formed response: dev-throw,
      // refused WHOLE — the snapshot object is untouched.
      expect(() => s.certify('Deal', 9, [...P, 'ghost'], V + 100, W))
        .toThrow(/never freshens a cell the client does not hold/)
      expect(s.get('Deal', 9)).toBe(e)                         // same object — nothing moved
      expect('ghost' in e.fields).toBe(false)
    })
  })

  it('4. signal (M3) raises knownVersion ONLY — no cell, no floor, no lastSeen, no fieldTick, no tick', () => {
    const s = new EntityStore()
    s.merge('Deal', 9, { a: 1 }, { version: 10 })
    s.merge('Deal', 9, { a: 2, b: 'x' }, { version: 20 })      // a ticked once
    s.destroy('Deal', 9, 5)                                    // a real (cleared) floor to watch
    const before = s.get('Deal', 9)!

    s.signal('Deal', 9, 99)
    const e = s.get('Deal', 9)!
    expect(e.knownVersion).toBe(99)                            // the ONLY movement
    expect(e.fields).toEqual(before.fields)
    expect(e.floor).toBe(before.floor)
    expect(lastSeenOf(e, 'a')).toBe(lastSeenOf(before, 'a'))
    expect(lastSeenOf(e, 'b')).toBe(lastSeenOf(before, 'b'))
    expect(e.fieldTicks).toEqual(before.fieldTicks)
    expect(e.tick).toBe(before.tick)
    expect(isCurrent(e, 'a')).toBe(false)                      // a rumor makes cells stale, never fresh

    s.signal('Deal', 9, 99)                                    // DUPLICATE delivery of the same rumor
    expect(s.get('Deal', 9)).toBe(e)                           // equal token: pure no-op, no notify

    s.signal('Deal', 9, 50)                                    // stale rumor: pure no-op
    expect(s.get('Deal', 9)).toBe(e)                           // same snapshot object

    s.signal('Deal', 777, 42)                                  // never-fetched pk: rumor map only
    expect(s.get('Deal', 777)).toBeUndefined()                 // no entry fabricated
  })

  it('5. floor survives entry EVICTION: 50 seeded churns — a pre-floor re-merge stays invisible', () => {
    for (let seed = 1; seed <= 50; seed++) withSeed(seed, () => {
      const rand = rng(seed * 7919)
      const s = new EntityStore({ capacity: 2 })
      s.merge('Deal', 'victim', { a: 1 }, { version: 10 })
      s.destroy('Deal', 'victim', 15)
      for (let i = 0; i < 8; i++) {                            // churn the LRU until the victim is out
        s.merge('Deal', `churn-${Math.floor(rand() * 6)}`, { x: i }, { version: 1 + i })
      }
      expect(s.get('Deal', 'victim')).toBeUndefined()          // entry evicted…
      s.merge('Deal', 'victim', { a: 'stale pre-delete' }, { version: 10 + Math.floor(rand() * 5) })  // token ≤ 14
      const e = s.get('Deal', 'victim')!
      expect(e.floor).toBe(15)                                 // …its floor was not (O12)
      expect(isVisible(e, 'a')).toBe(false)
      expect(isGone(e)).toBe(true)
      s.merge('Deal', 'victim', { a: 'recreated@16' }, { version: 16 })  // post-floor lineage renders
      expect(visibleFields(s.get('Deal', 'victim')!)).toEqual({ a: 'recreated@16' })
    })
  })

  it('6. L3 GC invariance: 300 seeded {merge,destroy,signal} histories (with duplicates) — interpretation ≡ the no-GC reference', () => {
    for (let seed = 1; seed <= 300; seed++) withSeed(seed, () => {
      const rand = rng(seed * 48271)
      const s = new EntityStore()

      const ops: Op[] = []
      for (let t = 1; t <= 16; t++) {                          // tokens 1..16; destroys may COLLIDE with merges
        const roll = rand()
        if (roll < 0.2) {
          ops.push({ kind: 'destroy', token: t })
          // Boundary collisions on purpose: sometimes a merge shares the
          // destroy's exact token, so lastSeen == floor cells exist and
          // the strict `>` boundary is exercised (both mutant killers).
          if (rand() < 0.5) {
            const fields: Record<string, unknown> = {}
            for (const f of FIELDS) if (rand() < 0.5) fields[f] = `${f}@${t}`
            if (Object.keys(fields).length > 0) ops.push({ kind: 'merge', token: t, fields })
          }
        }
        else if (roll < 0.35) ops.push({ kind: 'signal', token: t })
        else {
          const fields: Record<string, unknown> = {}
          for (const f of FIELDS) if (rand() < 0.5) fields[f] = `${f}@${t}`
          if (Object.keys(fields).length > 0) ops.push({ kind: 'merge', token: t, fields })
        }
      }
      // Random delivery order + at-least-once duplication of a random subset.
      const order = shuffle([...ops, ...ops.filter(() => rand() < 0.3)], rand)
      for (const op of order) apply(s, op)

      // NO-GC REFERENCE (the naive per-field model): floor = max destroy,
      // lastSeen(f) = greatest merge token carrying f, kv = greatest token
      // ever heard through ANY door. Order-free by construction — the
      // store, which physically GCs dead cells (L3), must interpret
      // identically.
      const floor = Math.max(-Infinity, ...ops.filter(o => o.kind === 'destroy').map(o => o.token))
      const kv = Math.max(-Infinity, ...ops.map(o => o.token))
      const seen: Record<string, number> = {}
      const val: Record<string, unknown> = {}
      for (const op of ops) {
        if (op.kind !== 'merge') continue
        for (const [f, v] of Object.entries(op.fields)) {
          if (!(f in seen) || op.token >= seen[f]!) { seen[f] = op.token; val[f] = v }
        }
      }

      const e = s.get('Deal', 9)
      if (!e) {
        expect(ops.some(o => o.kind === 'merge')).toBe(false)  // only value-less histories fabricate nothing
        return
      }
      expect(e.floor).toBe(floor)
      expect(e.knownVersion).toBe(kv)
      let anyVisible = false
      for (const f of FIELDS) {
        const vis = f in seen && seen[f]! > floor
        expect(isVisible(e, f)).toBe(vis)                      // GC never changed what renders…
        if (vis) {
          anyVisible = true
          expect(e.fields[f]).toBe(val[f])                     // …or WHAT value renders
          expect(lastSeenOf(e, f)).toBe(seen[f]!)
          expect(isCurrent(e, f)).toBe(seen[f]! >= kv)         // …or its freshness verdict
        }
      }
      const expectBag = Object.fromEntries(
        Object.entries(seen).filter(([, v]) => v > floor).map(([f]) => [f, val[f]]))
      expect(visibleFields(e)).toEqual(expectBag)
      expect(isGone(e)).toBe(!anyVisible && floor > -Infinity)
      // And the GC actually HAPPENED: no held cell is dead under the floor.
      for (const f of Object.keys(e.fields)) {
        const ls = lastSeenOf(e, f)
        expect(ls !== null && ls > e.floor || e.floor === -Infinity).toBe(true)
      }
    })
  })
})

describe('notify coalescing (per microtask; rev() stays synchronous)', () => {
  it('mergeRows over a page fires each mounted key ONCE', async () => {
    const s = new EntityStore()
    const seen = vi.fn()
    s.subscribe('Deal', 1, seen)
    s.mergeRows('Deal', [
      { id: 1, x: 'a' }, { id: 2, x: 'b' }, { id: 1, x: 'c' }, { id: 1, x: 'd' },
    ])
    expect(seen).not.toHaveBeenCalled()                        // nothing synchronous
    await flush()
    expect(seen).toHaveBeenCalledTimes(1)                      // three writes, one callback
    expect(s.get('Deal', 1)!.fields.x).toBe('d')
  })

  it('rev() bumps synchronously at write time (snapshots never lag the flush)', () => {
    const s = new EntityStore()
    const before = s.rev('Deal', 1)
    s.merge('Deal', 1, { x: 1 })
    expect(s.rev('Deal', 1)).toBeGreaterThan(before)           // no await needed
  })
})

describe('eviction safety', () => {
  it('LRU evicts oldest UNPINNED, never pinned or mounted entities', () => {
    const s = new EntityStore({ capacity: 3 })
    s.merge('D', 1, { x: 1 })
    s.merge('D', 2, { x: 2 })
    const release = s.retain('D', [1])                            // 1 is a live query referent
    s.subscribe('D', 2, () => {})                                 // 2 is mounted
    s.merge('D', 3, { x: 3 })
    s.merge('D', 4, { x: 4 })
    s.merge('D', 5, { x: 5 })                                     // over capacity — 3 is the evictable oldest
    expect(s.get('D', 1)).toBeDefined()                           // pinned survives
    expect(s.get('D', 2)).toBeDefined()                           // mounted survives
    expect(s.get('D', 3)).toBeUndefined()                         // oldest unpinned went
    release()
    s.merge('D', 6, { x: 6 }); s.merge('D', 7, { x: 7 })
    expect(s.get('D', 2)).toBeDefined()                           // still mounted, still safe
  })
})

describe('floorRetention (finite) — the safety-inequality knob, pinned', () => {
  it('an untouched floor survives to revision-distance == retention and prunes strictly beyond it — pruning re-admits (the documented T2 trade)', () => {
    const s = new EntityStore({ floorRetention: 3 })
    s.destroy('Deal', 'victim', 15)                          // writeRev 1, touched 1
    s.destroy('Deal', 'o1', 1)                               // writeRev 2
    s.destroy('Deal', 'o2', 1)                               // writeRev 3
    s.destroy('Deal', 'o3', 1)                               // writeRev 4: distance 3 == retention → kept
    expect(s.exportFloors()).toContainEqual(['Deal', 'victim', 15])
    s.destroy('Deal', 'o4', 1)                               // writeRev 5: distance 4 > retention → pruned
    expect(s.exportFloors()).not.toContainEqual(['Deal', 'victim', 15])
    // The trade, exercised: a 𝒞w-legal late pre-delete payload now renders.
    // This is exactly why the DEFAULT retention is Infinity.
    s.merge('Deal', 'victim', { a: 'pre-delete@10' }, { version: 10 })
    expect(isVisible(s.get('Deal', 'victim')!, 'a')).toBe(true)
  })

  it("an ACTIVE record's floor never ages out — merge/signal/certify traffic all refresh the FloorRec", () => {
    const s = new EntityStore({ floorRetention: 3 })
    s.merge('Deal', 'victim', { a: 'a@20' }, { version: 20 })
    s.destroy('Deal', 'victim', 15)                          // floor 15; a@20 survives it
    for (let i = 0; i < 30; i++) {
      // Rotate every Rule-M op that consults floorOf, so each keep-alive
      // path is exercised; each round also destroys elsewhere, which is
      // what advances the prune horizon.
      if (i % 3 === 0) s.merge('Deal', 'victim', { a: `a@${21 + i}` }, { version: 21 + i })
      else if (i % 3 === 1) s.signal('Deal', 'victim', 100 + i)
      else s.certify('Deal', 'victim', ['a'], 200 + i, 20)
      s.destroy('Deal', `other-${i}`, 1)
    }
    expect(s.exportFloors()).toContainEqual(['Deal', 'victim', 15])
    s.merge('Deal', 'victim', { b: 'pre-delete@12' }, { version: 12 })
    expect(isVisible(s.get('Deal', 'victim')!, 'b')).toBe(false)  // the floor still enforces T2
  })

  it('evicting an entry whose FloorRec was pruned RE-SEEDS the authority map — eviction is never the event that loses a floor (O12)', () => {
    const s = new EntityStore({ capacity: 2, floorRetention: 2 })
    s.merge('Deal', 'victim', { a: 1 }, { version: 10 })     // writeRev 1
    s.destroy('Deal', 'victim', 15)                          // writeRev 2, touched 2
    s.destroy('Deal', 'x1', 1)                               // writeRev 3
    s.destroy('Deal', 'x2', 1)                               // writeRev 4
    s.destroy('Deal', 'x3', 1)                               // writeRev 5 → victim's FloorRec pruned
    expect(s.exportFloors().some(([, pk]) => pk === 'victim')).toBe(false)
    // Only the entry's denormalized render copy still knows floor 15.
    for (let i = 0; i < 6; i++) s.merge('Deal', `churn-${i}`, { x: i }, { version: 1 })
    expect(s.get('Deal', 'victim')).toBeUndefined()          // entry evicted…
    expect(s.exportFloors()).toContainEqual(['Deal', 'victim', 15])  // …after re-seeding its floor
    s.merge('Deal', 'victim', { a: 'stale pre-delete' }, { version: 12 })
    const e = s.get('Deal', 'victim')!
    expect(e.floor).toBe(15)
    expect(isVisible(e, 'a')).toBe(false)                    // resurrection stays closed
    expect(isGone(e)).toBe(true)
  })
})

// ── Jepsen-lite: seeded adversarial interleavings ────────────────────────────

describe('property suite (seeded adversary)', () => {
  const FIELDS = ['a', 'b', 'c', 'd'] as const

  it('I2 + convergence: 500 random versioned interleavings match the PER-FIELD join reference (Rule M1)', () => {
    for (let seed = 1; seed <= 500; seed++) withSeed(seed, () => {
      const rand = rng(seed)
      const store = new EntityStore()
      // generate versioned slices with unique versions, apply in RANDOM order
      const slices = Array.from({ length: 12 }, (_, i) => {
        const fields: Record<string, unknown> = {}
        for (const f of FIELDS) if (rand() < 0.5) fields[f] = `${f}@${i + 1}`
        return { version: i + 1, fields }
      }).filter(sl => Object.keys(sl.fields).length > 0)
      const order = shuffle(slices, rand)

      const seenFloor: Record<string, number> = {}
      for (const sl of order) {
        store.merge('Deal', 9, sl.fields, { version: sl.version })
        const e = store.get('Deal', 9)!
        for (const f of FIELDS) {
          const ls = lastSeenOf(e, f)
          if (ls === null) continue
          expect(ls).toBeGreaterThanOrEqual(seenFloor[f] ?? -Infinity)   // I2: no field renders backwards
          seenFloor[f] = ls
        }
      }

      // REFERENCE: the naive per-field join — for each field, the value
      // carried by the highest-token slice mentioning it (equal-token
      // cannot occur here; versions are unique).
      const ref: Record<string, { v: number; val: unknown }> = {}
      for (const sl of order) {
        for (const [f, val] of Object.entries(sl.fields)) {
          if (!(f in ref) || sl.version >= ref[f]!.v) ref[f] = { v: sl.version, val }
        }
      }
      const e = store.get('Deal', 9)!
      expect(e.fields).toEqual(Object.fromEntries(Object.entries(ref).map(([f, r]) => [f, r.val])))
      for (const [f, r] of Object.entries(ref)) expect(lastSeenOf(e, f)).toBe(r.v)
      expect(e.version).toBe(Math.max(...Object.values(ref).map(r => r.v)))  // deprecated derived: max lastSeen
    })
  })

  it('T2: 200 random {merge, destroy} interleavings match the (floor, cells) join reference', () => {
    for (let seed = 1; seed <= 200; seed++) withSeed(seed, () => {
      const rand = rng(seed * 104729)
      const store = new EntityStore()
      type Op = { kind: 'merge'; token: number; fields: Record<string, unknown> } | { kind: 'destroy'; token: number }
      const ops: Op[] = []
      for (let t = 1; t <= 14; t++) {
        if (rand() < 0.2) {
          ops.push({ kind: 'destroy', token: t })
          if (rand() >= 0.5) continue                          // …else fall through: a merge at the SAME
          // token as the destroy — the lastSeen == floor boundary exists
        }
        const fields: Record<string, unknown> = {}
        for (const f of FIELDS) if (rand() < 0.5) fields[f] = `${f}@${t}`
        if (Object.keys(fields).length > 0) ops.push({ kind: 'merge', token: t, fields })
      }
      const order = shuffle(ops, rand)
      for (const op of order) {
        if (op.kind === 'merge') store.merge('Deal', 9, op.fields, { version: op.token })
        else store.destroy('Deal', 9, op.token)
      }

      // REFERENCE: floor = max destroy token; per field, the highest-token
      // merge carrying it; visible iff lastSeen > floor.
      const floor = Math.max(-Infinity, ...ops.filter(o => o.kind === 'destroy').map(o => o.token))
      const ref: Record<string, { v: number; val: unknown }> = {}
      for (const op of ops) {
        if (op.kind !== 'merge') continue
        for (const [f, val] of Object.entries(op.fields)) {
          if (!(f in ref) || op.token >= ref[f]!.v) ref[f] = { v: op.token, val }
        }
      }
      const expectVisible = Object.fromEntries(
        Object.entries(ref).filter(([, r]) => r.v > floor).map(([f, r]) => [f, r.val]))

      const e = store.get('Deal', 9)
      if (!e) {
        expect(ops.some(o => o.kind === 'merge')).toBe(false)  // destroys alone fabricate no entry
        return
      }
      expect(visibleFields(e)).toEqual(expectVisible)
      expect(e.floor).toBe(floor)
      expect(isGone(e)).toBe(Object.keys(expectVisible).length === 0 && floor > -Infinity)
    })
  })

  it('I3/I4 convergence: truth + DRAINED intents == truth, across 200 runs', () => {
    for (let seed = 1; seed <= 200; seed++) withSeed(seed, () => {
      const rand = rng(seed * 7919)
      const store = new EntityStore()
      const pending: Array<Record<string, unknown>> = []
      for (let step = 0; step < 30; step++) {
        const roll = rand()
        if (roll < 0.5) {
          store.merge('Deal', 1, { [FIELDS[Math.floor(rand() * 4)]!]: `t${step}` }, { version: step })
        } else if (roll < 0.8) {
          pending.push({ [FIELDS[Math.floor(rand() * 4)]!]: `intent${step}` })
        } else if (pending.length) {
          pending.splice(Math.floor(rand() * pending.length), 1)   // settle/fail — intent drains
        }
      }
      const truth = { ...store.get('Deal', 1)?.fields }
      pending.length = 0                                            // everything settles eventually
      expect(composeEntity(store.get('Deal', 1), pending)).toEqual(truth)
      expect(store.get('Deal', 1)?.fields).toEqual(truth)           // and intents never wrote truth
    })
  })

  it('I5 under churn: pinned records survive 1000 merges over a tiny capacity', () => {
    const rand = rng(42)
    const store = new EntityStore({ capacity: 10 })
    store.merge('Deal', 'keep-1', { x: 1 })
    store.merge('Deal', 'keep-2', { x: 2 })
    const release = store.retain('Deal', ['keep-1', 'keep-2'])
    for (let i = 0; i < 1000; i++) {
      store.merge('Deal', `churn-${Math.floor(rand() * 500)}`, { x: i })
    }
    expect(store.get('Deal', 'keep-1')).toBeDefined()
    expect(store.get('Deal', 'keep-2')).toBeDefined()
    expect(store.size).toBeLessThanOrEqual(12)                      // capacity + pinned overflow only
    release()
  })
})

describe('bare-minimum status: pending + tick (Daniel 2026-07-24)', () => {
  it('markPending counts, stacks, releases idempotently, and notifies', async () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    await flush()
    const seen = vi.fn()
    s.subscribe('Deal', 5, seen)
    const r1 = s.markPending('Deal', 5)
    await flush()
    const r2 = s.markPending('Deal', 5)
    await flush()
    expect(s.isPending('Deal', 5)).toBe(true)
    r1(); r1()                                     // double-release is safe
    await flush()
    expect(s.isPending('Deal', 5)).toBe(true)      // second flight still up
    r2()
    await flush()
    expect(s.isPending('Deal', 5)).toBe(false)
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('tick bumps ONLY on applied merges — stale drops do not flash', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' }, { version: 2 })
    expect(s.get('Deal', 5)!.tick).toBe(1)
    s.merge('Deal', 5, { name: 'stale' }, { version: 1 })
    expect(s.get('Deal', 5)!.tick).toBe(1)          // no lie, no flash
    s.merge('Deal', 5, { name: 'b' }, { version: 3 })
    expect(s.get('Deal', 5)!.tick).toBe(2)
  })

  it('useEntityStatus re-renders on a pending flip (rev-based snapshot)', async () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    const seen: any[] = []
    function Probe() { const st = useEntityStatus('Deal', 5, s); seen.push(st.pending); return null }
    render(<Probe />)
    let release!: () => void
    await act(async () => { release = s.markPending('Deal', 5) })
    await act(async () => { release() })
    expect(seen).toContain(true)
    expect(seen[seen.length - 1]).toBe(false)
  })
})

describe('field-grain ticks (the presenter flash)', () => {
  it('only CHANGED fields tick — same-value re-sends stay silent', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a', amount: '10' }, { version: 1 })
    s.merge('Deal', 5, { name: 'a', amount: '20' }, { version: 2 })
    const e = s.get('Deal', 5)!
    expect(e.fieldTicks.amount).toBe(1)          // moved → ticks
    expect(e.fieldTicks.name).toBeUndefined()    // re-sent same value → silent
    expect(e.tick).toBe(2)                        // record-level chrome still counts merges
  })

  it('registerFieldKinds: jsonb/pkArray compare STRUCTURALLY — re-sent payloads do not flash', () => {
    const s = new EntityStore()
    s.registerFieldKinds('Deal', { meta: 'jsonb', tagIds: 'pkArray', name: 'scalar' })
    s.merge('Deal', 5, { meta: { a: 1 }, tagIds: [1, 2], name: 'x' }, { version: 1 })
    s.merge('Deal', 5, { meta: { a: 1 }, tagIds: [1, 2], name: 'x' }, { version: 2 })  // new identities, equal values
    const e = s.get('Deal', 5)!
    expect(e.fieldTicks.meta).toBeUndefined()
    expect(e.fieldTicks.tagIds).toBeUndefined()
    s.merge('Deal', 5, { meta: { a: 2 }, tagIds: [1, 2, 3] }, { version: 3 })
    expect(s.get('Deal', 5)!.fieldTicks.meta).toBe(1)
    expect(s.get('Deal', 5)!.fieldTicks.tagIds).toBe(1)
  })

  it('flat-row contract: a registered model dev-throws on an UNDECLARED object-valued field', () => {
    const s = new EntityStore()
    s.registerFieldKinds('Deal', { name: 'scalar' })
    expect(() => s.merge('Deal', 5, { contact: { id: 3, name: 'nested row' } }))
      .toThrow(/flat/i)
    // unregistered models keep today's behavior — no throw
    const s2 = new EntityStore()
    expect(() => s2.merge('Loose', 1, { blob: { any: 'thing' } })).not.toThrow()
  })
})
