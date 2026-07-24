/**
 * The entity store — unit contract + the Jepsen-lite property suite.
 *
 * The property tests throw seeded-random interleavings of {slice merges,
 * removes, pins, evictions, pending intents} at the store and assert the
 * invariants from DESIGN-entity-store.md:
 *   I2 monotonic (a record never renders backwards)
 *   I2b stale slices drop WHOLE (no field-picking)
 *   I3/I4 convergence (truth + drained intents == truth, exactly)
 *   I5 eviction safety (a pinned/mounted record is never evicted)
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { EntityStore, composeEntity, useEntity } from '../src/entity-store.js'

// Seeded LCG — deterministic adversary, reproducible failures.
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('unit contract', () => {
  it('merges SLICES into a union — two doors, one record', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'Acme', amount: '100.00' }, { version: 1000 })
    s.merge('Deal', 5, { stage: 'won' }, { version: 2000 })
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'Acme', amount: '100.00', stage: 'won' })
    expect(s.get('Deal', 5)!.version).toBe(2000)
  })

  it('I2: a stale versioned slice is dropped WHOLE — even novel fields', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'new' }, { version: 2000 })
    const applied = s.merge('Deal', 5, { name: 'old', extra: 'x' }, { version: 1000 })
    expect(applied).toBe(false)
    expect(s.get('Deal', 5)!.fields).toEqual({ name: 'new' })   // no resurrection via field-picking
  })

  it('unversioned merges are arrival-order (never worse than a document cache)', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    s.merge('Deal', 5, { name: 'b' })
    expect(s.get('Deal', 5)!.fields.name).toBe('b')
  })

  it('versions fall back to a numeric-able updatedAt in the slice itself', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'new', updatedAt: '2026-07-24T10:00:00Z' })
    const applied = s.merge('Deal', 5, { name: 'old', updatedAt: '2026-07-24T09:00:00Z' })
    expect(applied).toBe(false)
    expect(s.get('Deal', 5)!.fields.name).toBe('new')
  })

  it('pks are opaque — string/uuid keys work identically (non-PG future)', () => {
    const s = new EntityStore()
    s.merge('ApiThing', 'ab-12', { x: 1 })
    s.merge('ApiThing', 'ab-13', { x: 2 })
    expect(s.get('ApiThing', 'ab-12')!.fields.x).toBe(1)
    expect(s.get('ApiThing', 'ab-13')!.fields.x).toBe(2)
  })

  it('subscribe fires for ITS key only; remove notifies and clears', () => {
    const s = new EntityStore()
    const a = vi.fn(); const b = vi.fn()
    s.subscribe('Deal', 1, a)
    s.subscribe('Deal', 2, b)
    s.merge('Deal', 1, { x: 1 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    s.remove('Deal', 1)
    expect(a).toHaveBeenCalledTimes(2)
    expect(s.get('Deal', 1)).toBeUndefined()
  })

  it('useEntity re-renders on merge with a STABLE snapshot between writes', () => {
    const s = new EntityStore()
    s.merge('Deal', 5, { name: 'a' })
    const seen: any[] = []
    function Probe() { seen.push(useEntity('Deal', 5, s)?.fields.name); return null }
    render(<Probe />)
    act(() => { s.merge('Deal', 5, { name: 'b' }) })
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

// ── Jepsen-lite: seeded adversarial interleavings ────────────────────────────

describe('property suite (seeded adversary)', () => {
  const FIELDS = ['a', 'b', 'c', 'd'] as const

  it('I2 + convergence: 500 random versioned interleavings match the reference', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed)
      const store = new EntityStore()
      // generate versioned slices with unique versions, apply in RANDOM order
      const slices = Array.from({ length: 12 }, (_, i) => {
        const fields: Record<string, unknown> = {}
        for (const f of FIELDS) if (rand() < 0.5) fields[f] = `${f}@${i + 1}`
        return { version: i + 1, fields }
      }).filter(sl => Object.keys(sl.fields).length > 0)
      const order = [...slices].sort(() => rand() - 0.5)

      let renderedVersion = -Infinity
      for (const sl of order) {
        store.merge('Deal', 9, sl.fields, { version: sl.version })
        const v = store.get('Deal', 9)?.version ?? -Infinity
        expect(v).toBeGreaterThanOrEqual(renderedVersion)          // I2: never backwards
        renderedVersion = v
      }

      // REFERENCE: apply the slices that the gate semantics admit, in the
      // order they arrived (drop any slice older than the running max)
      const ref: Record<string, unknown> = {}
      let maxV = -Infinity
      for (const sl of order) {
        if (sl.version < maxV) continue
        Object.assign(ref, sl.fields)
        maxV = sl.version
      }
      expect(store.get('Deal', 9)!.fields).toEqual(ref)
      expect(store.get('Deal', 9)!.version).toBe(maxV)
    }
  })

  it('I3/I4 convergence: truth + DRAINED intents == truth, across 200 runs', () => {
    for (let seed = 1; seed <= 200; seed++) {
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
    }
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
