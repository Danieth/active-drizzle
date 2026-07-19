/**
 * rehydrate() — the three-way merge (DESIGN-cache-coherence §B + appendix H).
 *
 * T1/T2/T3/T5 exercised at the unit level: clean fields adopt, dirty fields
 * survive, true conflicts withhold the version token (→ the next submit
 * 409s), converged values settle, old payloads are ignored, and nested
 * children merge by id through their own sessions.
 */
import { describe, it, expect, vi } from 'vitest'
import { FormSession, type ServerEnvelope } from '../src/form-session.js'
import { NestedArrayManager, NestedOneManager } from '../src/nested.js'

const V1 = '1000'
const V2 = '2000'

function makeSession(draft: Record<string, any>, version: string | null = V1) {
  return new FormSession({ draft: { ...draft }, mode: 'edit', abilities: null, version })
}

describe('flat three-way merge', () => {
  it('clean fields adopt the incoming value (draft AND baseline)', () => {
    const s = makeSession({ id: 1, name: 'a', amount: '10' })
    const conflict = s.rehydrate({ record: { id: 1, name: 'b', amount: '10' }, version: V2 })
    expect(conflict).toBe(false)
    expect((s.draft as any).name).toBe('b')
    expect(s.isDirty()).toBe(false)
    expect(s.getVersion()).toBe(V2)
  })

  it('dirty fields survive when the server did not move them', () => {
    const s = makeSession({ id: 1, name: 'a', amount: '10' })
    s.setValue('name', 'MINE')
    const conflict = s.rehydrate({ record: { id: 1, name: 'a', amount: '99' }, version: V2 })
    expect(conflict).toBe(false)
    expect((s.draft as any).name).toBe('MINE')      // my edit stands
    expect((s.draft as any).amount).toBe('99')      // their clean-field change adopted
    expect(s.getVersion()).toBe(V2)                 // no conflict → token adopted
    // my edit still rides the next diff
    expect(s.changedData()).toEqual({ name: 'MINE' })
  })

  it('TRUE CONFLICT: keeps mine, withholds the version token', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'MINE')
    const conflict = s.rehydrate({ record: { id: 1, name: 'THEIRS' }, version: V2 })
    expect(conflict).toBe(true)
    expect((s.draft as any).name).toBe('MINE')      // never eat a keystroke
    expect(s.getVersion()).toBe(V1)                 // WITHHELD → next submit 409s
  })

  it('convergence: both sides arrived at the same value → settles silently', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'same')
    const conflict = s.rehydrate({ record: { id: 1, name: 'same' }, version: V2 })
    expect(conflict).toBe(false)
    expect(s.isDirty()).toBe(false)
    expect(s.getVersion()).toBe(V2)
  })

  it('T5 ordering: an OLDER payload is ignored entirely', () => {
    const s = makeSession({ id: 1, name: 'fresh' }, V2)
    const conflict = s.rehydrate({ record: { id: 1, name: 'stale' }, version: V1 })
    expect(conflict).toBe(false)
    expect((s.draft as any).name).toBe('fresh')
    expect(s.getVersion()).toBe(V2)
  })

  it('abilities and can refresh on rehydrate', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.rehydrate({ record: { id: 1, name: 'a' }, abilities: { name: 'view' }, can: { go: true }, version: V2 })
    expect(s.canEdit('name')).toBe(false)
    expect(s.can('go')).toBe(true)
  })
})

describe('nested merge by id — array manager', () => {
  function withNotes(notes: any[]) {
    const s = makeSession({ id: 1, name: 'deal' })
    const m = new NestedArrayManager(s, 'notes', notes)
    s.registerNested('notes', m)
    return { s, m }
  }

  it('a clean child updated elsewhere merges in place (session identity kept)', () => {
    const { s, m } = withNotes([{ id: 7, body: 'old' }])
    const before = m.visible()[0]!.session
    const conflict = s.rehydrate({ record: { id: 1, name: 'deal', notes: [{ id: 7, body: 'NEW' }] }, version: V2 })
    expect(conflict).toBe(false)
    expect(m.visible()[0]!.session).toBe(before)
    expect((m.visible()[0]!.session.draft as any).body).toBe('NEW')
  })

  it('a DIRTY child field survives; other children still adopt', () => {
    const { s, m } = withNotes([{ id: 7, body: 'a' }, { id: 8, body: 'b' }])
    m.visible()[0]!.session.setValue('body', 'MINE')
    const conflict = s.rehydrate({
      record: { id: 1, name: 'deal', notes: [{ id: 7, body: 'a' }, { id: 8, body: 'ELSEWHERE' }] },
      version: V2,
    })
    expect(conflict).toBe(false)
    expect((m.visible()[0]!.session.draft as any).body).toBe('MINE')
    expect((m.visible()[1]!.session.draft as any).body).toBe('ELSEWHERE')
  })

  it('a child that appeared elsewhere inserts; my locally-new row stays', () => {
    const { s, m } = withNotes([{ id: 7, body: 'a' }])
    m.add({ body: 'my new row' })
    s.rehydrate({ record: { id: 1, name: 'deal', notes: [{ id: 7, body: 'a' }, { id: 9, body: 'from elsewhere' }] }, version: V2 })
    const bodies = m.visible().map(c => (c.session.draft as any).body).sort()
    expect(bodies).toEqual(['a', 'from elsewhere', 'my new row'])
  })

  it('deleted elsewhere: clean child drops; dirty child stays and conflicts', () => {
    const { s, m } = withNotes([{ id: 7, body: 'clean' }, { id: 8, body: 'dirty' }])
    m.visible()[1]!.session.setValue('body', 'EDITED')
    const conflict = s.rehydrate({ record: { id: 1, name: 'deal', notes: [] }, version: V2 })
    expect(conflict).toBe(true)                          // structural conflict reported
    expect(m.visible()).toHaveLength(1)                  // clean one dropped
    expect((m.visible()[0]!.session.draft as any).body).toBe('EDITED')
    expect(s.getVersion()).toBe(V1)                      // token withheld
  })

  it('a child conflict propagates: token withheld at the parent', () => {
    const { s, m } = withNotes([{ id: 7, body: 'a' }])
    m.visible()[0]!.session.setValue('body', 'MINE')
    const conflict = s.rehydrate({ record: { id: 1, name: 'deal', notes: [{ id: 7, body: 'THEIRS' }] }, version: V2 })
    expect(conflict).toBe(true)
    expect((m.visible()[0]!.session.draft as any).body).toBe('MINE')
    expect(s.getVersion()).toBe(V1)
  })
})

describe('nested merge — singular manager', () => {
  function withBrief(brief: any) {
    const s = makeSession({ id: 1, name: 'deal' })
    const m = new NestedOneManager(s, 'brief', brief)
    s.registerNested('brief', m)
    return { s, m }
  }

  it('clean child merges; dirty field survives + conflicts', () => {
    const { s, m } = withBrief({ id: 3, summary: 'a', nextStep: 'x' })
    const c1 = s.rehydrate({ record: { id: 1, name: 'deal', brief: { id: 3, summary: 'b', nextStep: 'x' } }, version: V2 })
    expect(c1).toBe(false)
    expect((m.current()!.session.draft as any).summary).toBe('b')

    m.current()!.session.setValue('summary', 'MINE')
    const c2 = s.rehydrate({ record: { id: 1, name: 'deal', brief: { id: 3, summary: 'THEIRS', nextStep: 'x' } }, version: '3000' })
    expect(c2).toBe(true)
    expect((m.current()!.session.draft as any).summary).toBe('MINE')
  })

  it('appeared elsewhere inserts; deleted elsewhere drops a clean child', () => {
    const { s, m } = withBrief(undefined)
    s.rehydrate({ record: { id: 1, name: 'deal', brief: { id: 5, summary: 'new' } }, version: V2 })
    expect(m.current()).not.toBeNull()
    s.rehydrate({ record: { id: 1, name: 'deal', brief: null }, version: '3000' })
    expect(m.current()).toBeNull()
  })
})

describe('"changes have happened" — the affordance + event bus', async () => {
  const { onFormEvents } = await import('../src/form-session.js')

  it('rehydrate records adopted fields; dismiss clears; no record when nothing changed', () => {
    const s = makeSession({ id: 1, name: 'a', amount: '10' })
    s.rehydrate({ record: { id: 1, name: 'b', amount: '10' }, version: V2 })
    expect(s.getRecentChanges()).toEqual(['name'])          // amount didn't change → not listed
    s.rehydrate({ record: { id: 1, name: 'b', amount: '10' }, version: '3000' })
    expect(s.getRecentChanges()).toEqual(['name'])          // no-op refetch adds nothing
    s.dismissRecentChanges()
    expect(s.getRecentChanges()).toEqual([])
  })

  it('nested structural changes list the association name', () => {
    const s = makeSession({ id: 1, name: 'deal' })
    const m = new NestedArrayManager(s, 'notes', [{ id: 7, body: 'a' }])
    s.registerNested('notes', m)
    s.rehydrate({ record: { id: 1, name: 'deal', notes: [{ id: 7, body: 'a' }, { id: 9, body: 'new elsewhere' }] }, version: V2 })
    expect(s.getRecentChanges()).toEqual(['notes'])
  })

  it('the event bus reports rehydrated/conflict/saved with fields', async () => {
    const events: any[] = []
    const off = onFormEvents(e => events.push({ type: e.type, fields: e.fields }))
    try {
      const submit = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 409 } as any)
        .mockResolvedValue({ ok: true })
      const s = new FormSession({ draft: { id: 1, name: 'a' }, mode: 'edit', abilities: null, version: V1, submit })
      s.rehydrate({ record: { id: 1, name: 'elsewhere' }, version: V2 })   // → rehydrated
      s.setValue('name', 'mine')
      await s.submit()                                                     // 409 → conflict
      await s.resolveConflict('overwrite')                                 // resubmit ok → saved
      expect(events.map(e => e.type)).toEqual(['rehydrated', 'conflict', 'saved'])
      expect(events[0].fields).toEqual(['name'])
    } finally { off() }
  })
})

describe('incoming map — the `elsewhere` source (value + at, adopt, token release)', () => {
  it('a TRUE CONFLICT records {value: theirs, at: updatedAt} in the incoming map', () => {
    const s = makeSession({ id: 1, name: 'a', amount: '10' })
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS', amount: '10', updatedAt: '2026-07-19T10:00:00Z' }, version: V2 })
    expect(s.getIncoming()).toEqual({ name: { value: 'THEIRS', at: '2026-07-19T10:00:00Z', by: null } })
    expect(s.getIncomingFor('name')).toEqual({ value: 'THEIRS', at: '2026-07-19T10:00:00Z', by: null })
    expect(s.getIncomingFor('amount')).toBeUndefined()   // clean adopt — not a divergence
  })

  it('without updatedAt the stamp falls back to the version token', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS' }, version: V2 })
    expect(s.getIncomingFor('name')!.at).toBe(V2)
  })

  it('adoptIncoming = fine-grained take-theirs: field settles AND the withheld token releases', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS' }, version: V2 })
    expect(s.getVersion()).toBe(V1)                      // withheld
    s.adoptIncoming('name')
    expect((s.draft as any).name).toBe('THEIRS')
    expect(s.isDirty()).toBe(false)                      // baseline moved with it
    expect(s.getIncoming()).toEqual({})
    expect(s.getVersion()).toBe(V2)                      // last conflict adopted → fully settled
  })

  it('partial adopt keeps the token withheld until the LAST conflict is taken', () => {
    const s = makeSession({ id: 1, name: 'a', amount: '10' })
    s.setValue('name', 'MINE'); s.setValue('amount', '99')
    s.rehydrate({ record: { id: 1, name: 'T1', amount: '55' }, version: V2 })
    expect(Object.keys(s.getIncoming()).sort()).toEqual(['amount', 'name'])
    s.adoptIncoming('name')
    expect(s.getVersion()).toBe(V1)                      // amount still stands
    s.adoptAllIncoming()
    expect(s.getVersion()).toBe(V2)
  })

  it('entries clear when the divergence disappears (converged / server rolled back)', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS' }, version: V2 })
    expect(s.getIncomingFor('name')).toBeDefined()
    s.rehydrate({ record: { id: 1, name: 'MINE' }, version: '3000' })   // server converged on mine
    expect(s.getIncomingFor('name')).toBeUndefined()
    expect(s.getVersion()).toBe('3000')
  })

  it('dismissIncoming is presentation-only: notice clears, the stale token still 409s', () => {
    const s = makeSession({ id: 1, name: 'a' })
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS' }, version: V2 })
    s.dismissIncoming()
    expect(s.getIncoming()).toEqual({})
    expect(s.getVersion()).toBe(V1)                      // safety intact
  })
})
