/**
 * Regression suite for the `react` boundary-correctness cluster.
 *
 * Each test FAILS against the pre-fix behavior and asserts the correct
 * behavior from the launch-tracker scenario:
 *
 *   - per-field autosave success must not clobber concurrent edits
 *   - commitField failure rollback must not erase mid-flight keystrokes
 *   - submit() must not race an in-flight autoFlush (self-409)
 *   - conflict bookkeeping must not survive resolution (backward token roll)
 *   - nested new-row ids must adopt by _key, not array position
 *   - parked nested edits must survive lazy manager registration
 */
import { describe, it, expect, vi } from 'vitest'
import { FormSession, type SubmitResult, type ServerEnvelope } from '../src/form-session.js'
import { NestedArrayManager } from '../src/nested.js'

const V1 = '1700000000000'
const V2 = '1700000099999'
const V3 = '1700000199999'

// A promise you resolve by hand — models an in-flight request.
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// ── Bug: per-field autosave clobbers concurrent edits (commitField) ──────────

describe('commitField autosave — narrow success application', () => {
  it('does not clobber a sibling field edited DURING the flight', async () => {
    const gate = deferred<void>()
    const submit = vi.fn(async () => {
      await gate.promise
      return { ok: true, envelope: { record: { id: 1, a: 'A_SERVER', b: 'B_SERVER' }, version: V2 } } as SubmitResult
    })
    const s = new FormSession({ draft: { id: 1, a: 'x', b: 'y' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'a-edited')
    const p = s.commitField('a', 'autosave')   // in flight, awaiting the gate
    // The user keeps typing in a DIFFERENT field while the PATCH is out
    s.setValue('b', 'b-edited')
    gate.resolve()
    await p

    // The saved field adopts the server's value (it was unchanged since flush)…
    expect((s.draft as any).a).toBe('A_SERVER')
    // …but the concurrently-edited sibling KEEPS the user's keystrokes.
    expect((s.draft as any).b).toBe('b-edited')
  })

  it('does not clobber the saved field itself when re-typed during the flight', async () => {
    const gate = deferred<void>()
    const submit = vi.fn(async () => {
      await gate.promise
      return { ok: true, envelope: { record: { id: 1, a: 'A_SERVER' }, version: V2 } } as SubmitResult
    })
    const s = new FormSession({ draft: { id: 1, a: 'x' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'a1')
    const p = s.commitField('a', 'autosave')
    s.setValue('a', 'a2')   // re-typed mid-flight
    gate.resolve()
    await p

    expect((s.draft as any).a).toBe('a2')   // server value did NOT overwrite the newer keystroke
  })
})

// ── Bug: commitField failure rollback erases mid-flight keystrokes ───────────

describe('commitField autosave — rollback preserves mid-flight keystrokes', () => {
  it('a rejected PATCH keeps a value typed during the flight instead of rolling it back', async () => {
    const gate = deferred<void>()
    const submit = vi.fn(async () => {
      await gate.promise
      return { ok: false, status: 422, errors: { a: ['bad'] } } as SubmitResult
    })
    const s = new FormSession({ draft: { id: 1, a: 'orig' }, mode: 'edit', abilities: null, submit })

    s.setValue('a', 'a1')
    const p = s.commitField('a', 'autosave')
    s.setValue('a', 'a2')   // typed more while the save was out
    gate.resolve()
    await p

    // The newer keystroke stands — it was never the value the server rejected.
    expect((s.draft as any).a).toBe('a2')
  })

  it('a rejected PATCH still rolls back when the user did NOT re-type', async () => {
    const submit = vi.fn(async () => ({ ok: false, status: 422, errors: { a: ['bad'] } } as SubmitResult))
    const s = new FormSession({ draft: { id: 1, a: 'orig' }, mode: 'edit', abilities: null, submit })

    s.setValue('a', 'a1')
    await s.commitField('a', 'autosave')

    expect((s.draft as any).a).toBe('orig')   // untouched during flight → server truth restored
  })
})

// ── Bug: submit() races an in-flight autoFlush (self-inflicted 409) ──────────

describe('submit vs autoFlush', () => {
  it('waits for an in-flight autoFlush and submits under the ADVANCED token', async () => {
    const flush = deferred<SubmitResult>()
    const submit = vi.fn()
      .mockImplementationOnce(() => flush.promise)                                   // the autoFlush
      .mockImplementation(async () => ({ ok: true, envelope: { record: { id: 1 }, version: V3 } } as SubmitResult))
    const s = new FormSession({ draft: { id: 1, a: 'x' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'edited')
    const flushP = s.autoFlush()   // in flight (submitFn call #0 pending)
    const submitP = s.submit()     // must AWAIT the flush before sending

    // The flush lands and rotates the token to V2.
    flush.resolve({ ok: true, envelope: { record: { id: 1, a: 'edited' }, version: V2 } })
    await flushP
    await submitP

    // Two calls total; the manual submit rode the flush's advanced token (V2),
    // never colliding with the flush under the original V1.
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1]![0]._version).toBe(V2)
  })
})

// ── Bug: conflict bookkeeping survives resolution (backward token roll) ──────

describe('conflict bookkeeping is cleared on resolution', () => {
  it('a successful submit clears incoming/withheld so a later adopt cannot roll the token back', async () => {
    const submit = vi.fn(async () => ({ ok: true, envelope: { record: { id: 1, name: 'mine' }, version: V3 } } as SubmitResult))
    const s = new FormSession({ draft: { id: 1, name: 'a' }, mode: 'edit', abilities: null, version: V1, submit })

    // Enter a true conflict via rehydrate: mine != base, theirs != base, all differ.
    s.setValue('name', 'mine')
    s.rehydrate({ record: { id: 1, name: 'theirs' }, version: V2 })
    expect(s.getIncomingFor('name')).toBeDefined()
    expect(s.getVersion()).toBe(V1)                     // withheld

    // Resolve by saving mine — the server advances the token to V3.
    await s.submit()
    expect(s.getVersion()).toBe(V3)
    expect(s.getIncoming()).toEqual({})                 // bookkeeping cleared

    // A stray late adopt must be a no-op, NOT a rollback to the withheld V2.
    s.adoptIncoming('name')
    expect(s.getVersion()).toBe(V3)
  })

  it('applyEnvelope clears a standing withheld token', () => {
    const s = new FormSession({ draft: { id: 1, name: 'a' }, mode: 'edit', abilities: null, version: V1 })
    s.setValue('name', 'mine')
    s.rehydrate({ record: { id: 1, name: 'theirs' }, version: V2 })   // withholds V2
    s.applyEnvelope({ record: { id: 1, name: 'server' }, version: V3 })
    expect(s.getVersion()).toBe(V3)
    s.adoptIncoming('name')
    expect(s.getVersion()).toBe(V3)                     // no backward roll to V2
  })
})

// ── Bug: nested new-row ids adopted POSITIONALLY (should match by _key) ──────

describe('NestedArrayManager.commitBaselines — _key matching', () => {
  it('adopts server ids by _key even when the echo order diverges', () => {
    const parent = new FormSession({ draft: { id: 1 }, mode: 'edit', abilities: null })
    const mgr = new NestedArrayManager(parent, 'items', [], {})
    parent.registerNested('items', mgr)

    mgr.add({ title: 'first' })    // new:1
    mgr.add({ title: 'second' })   // new:2

    const payload = mgr.attributesPayload()!
    const keys = (payload as any[]).map((p) => p._key)
    expect(keys).toEqual(['new:1', 'new:2'])

    // Server responds with the rows in REVERSED order, each carrying its _key.
    mgr.commitBaselines([
      { id: 200, _key: 'new:2', title: 'second' },
      { id: 100, _key: 'new:1', title: 'first' },
    ])

    const byTitle = Object.fromEntries(
      mgr.visible().map((c) => [(c.session.draft as any).title, (c.session.draft as any).id]),
    )
    expect(byTitle.first).toBe(100)
    expect(byTitle.second).toBe(200)
  })

  it('falls back to positional adoption when the echo carries no _key', () => {
    const parent = new FormSession({ draft: { id: 1 }, mode: 'edit', abilities: null })
    const mgr = new NestedArrayManager(parent, 'items', [], {})
    parent.registerNested('items', mgr)
    mgr.add({ title: 'first' })
    mgr.add({ title: 'second' })

    mgr.commitBaselines([{ id: 100, title: 'first' }, { id: 200, title: 'second' }])

    const rows = mgr.visible()
    expect((rows[0]!.session.draft as any).id).toBe(100)
    expect((rows[1]!.session.draft as any).id).toBe(200)
  })
})

// ── Bug: parked nested edits dropped (restore before lazy registration) ──────

describe('restoreParked — deferred nested restore', () => {
  it('replays a parked nested payload once the manager registers', () => {
    const s = new FormSession({ draft: { id: 1, name: 'p' }, mode: 'edit', abilities: null })

    // Restore runs at build time — BEFORE any nested manager exists.
    s.restoreParked({
      data: { itemsAttributes: [{ _key: 'new:9', title: 'parked-edit' }] },
      baseline: {},
      version: null,
    })

    // The manager registers lazily, on first render.
    const mgr = new NestedArrayManager(s, 'items', [], {})
    s.registerNested('items', mgr)

    const rows = mgr.visible()
    expect(rows).toHaveLength(1)
    expect((rows[0]!.session.draft as any).title).toBe('parked-edit')
  })

  it('still applies immediately when the manager is already registered', () => {
    const s = new FormSession({ draft: { id: 1, name: 'p' }, mode: 'edit', abilities: null })
    const mgr = new NestedArrayManager(s, 'items', [], {})
    s.registerNested('items', mgr)

    s.restoreParked({
      data: { itemsAttributes: [{ _key: 'new:1', title: 'live' }] },
      baseline: {},
      version: null,
    })

    expect(mgr.visible()).toHaveLength(1)
    expect((mgr.visible()[0]!.session.draft as any).title).toBe('live')
  })
})
