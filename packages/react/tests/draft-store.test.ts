/**
 * DraftStore + FormSession park/restore — navigation stops eating drafts
 * (DESIGN-cache-coherence §G2). The restore is the three-way merge in
 * reverse: server unmoved → replay; server moved → replay MINE but keep
 * the STALE token so the next submit 409s.
 */
import { describe, it, expect, vi } from 'vitest'
import { FormSession } from '../src/form-session.js'
import { DraftStore } from '../src/draft-store.js'
import { NestedArrayManager } from '../src/nested.js'

const V1 = '1000'
const V2 = '2000'

function session(draft: Record<string, any>, version: string | null = V1) {
  return new FormSession({ draft: { ...draft }, mode: 'edit', abilities: null, version })
}

describe('parkableState', () => {
  it('captures the diff + baselines of dirty fields + version; null when clean', () => {
    const s = session({ id: 1, name: 'a', amount: '10' })
    expect(s.parkableState()).toBeNull()
    s.setValue('name', 'MINE')
    expect(s.parkableState()).toEqual({
      data: { name: 'MINE' },
      baseline: { name: 'a' },
      version: V1,
    })
  })

  it('includes nested payloads (no baselines for them)', () => {
    const s = session({ id: 1, name: 'a', notes: [{ id: 7, body: 'x' }] })
    const m = new NestedArrayManager(s, 'notes', [{ id: 7, body: 'x' }])
    s.registerNested('notes', m)
    m.visible()[0]!.session.setValue('body', 'edited')
    const p = s.parkableState()!
    expect(p.data['notesAttributes']).toEqual([{ id: 7, body: 'edited' }])
    expect(p.baseline).not.toHaveProperty('notesAttributes')
  })
})

describe('restoreParked', () => {
  it('replays edits when the server did not move; version stays fresh', () => {
    const before = session({ id: 1, name: 'a', amount: '10' })
    before.setValue('name', 'MINE')
    const parked = before.parkableState()!

    // "come back later": fresh session from an unchanged envelope, newer token
    const after = session({ id: 1, name: 'a', amount: '10' }, V2)
    after.restoreParked(parked)
    expect((after.draft as any).name).toBe('MINE')
    expect(after.changedData()).toEqual({ name: 'MINE' })
    expect(after.getVersion()).toBe(V2)                    // no conflict → fresh token
  })

  it('server moved the SAME field while away → replay mine + keep the STALE token', () => {
    const before = session({ id: 1, name: 'a' })
    before.setValue('name', 'MINE')
    const parked = before.parkableState()!

    const after = session({ id: 1, name: 'THEIRS' }, V2)   // server moved it
    after.restoreParked(parked)
    expect((after.draft as any).name).toBe('MINE')         // never lose the edit
    expect(after.getVersion()).toBe(V1)                    // stale on purpose → 409 path
  })

  it('converged while away → nothing to replay, no conflict', () => {
    const before = session({ id: 1, name: 'a' })
    before.setValue('name', 'same')
    const parked = before.parkableState()!
    const after = session({ id: 1, name: 'same' }, V2)
    after.restoreParked(parked)
    expect(after.isDirty()).toBe(false)
    expect(after.getVersion()).toBe(V2)
  })

  it('nested payloads replay through the managers (staged, id-matched, new rows re-created)', () => {
    const before = session({ id: 1, name: 'a' })
    const mBefore = new NestedArrayManager(before, 'notes', [{ id: 7, body: 'x' }])
    before.registerNested('notes', mBefore)
    mBefore.visible()[0]!.session.setValue('body', 'edited')
    mBefore.add({ body: 'brand new' })
    const parked = before.parkableState()!

    const after = session({ id: 1, name: 'a', notes: [{ id: 7, body: 'x' }] }, V2)
    const mAfter = new NestedArrayManager(after, 'notes', [{ id: 7, body: 'x' }])
    after.registerNested('notes', mAfter)
    after.restoreParked(parked)

    const bodies = mAfter.visible().map(c => (c.session.draft as any).body).sort()
    expect(bodies).toEqual(['brand new', 'edited'])
    // and the replayed state folds into the next submit payload
    expect(after.changedData()['notesAttributes']).toEqual([
      { id: 7, body: 'edited' },
      expect.objectContaining({ body: 'brand new' }),
    ])
  })
})

describe('the store itself', () => {
  it('park/take round-trips; clean park clears; TTL expires; LRU caps', () => {
    vi.useFakeTimers()
    const store = new DraftStore(2, 1000)
    store.park('a', { data: { x: 1 }, baseline: { x: 0 }, version: '1' })
    expect(store.take('a')?.data).toEqual({ x: 1 })
    store.park('a', null)                                  // clean → clears
    expect(store.take('a')).toBeNull()

    store.park('a', { data: { x: 1 }, baseline: {}, version: null })
    vi.advanceTimersByTime(1500)                           // TTL
    expect(store.take('a')).toBeNull()

    store.park('1', { data: {}, baseline: {}, version: null })
    store.park('2', { data: {}, baseline: {}, version: null })
    store.park('3', { data: {}, baseline: {}, version: null })   // evicts '1'
    expect(store.size()).toBe(2)
    expect(store.take('1')).toBeNull()
    vi.useRealTimers()
  })
})
