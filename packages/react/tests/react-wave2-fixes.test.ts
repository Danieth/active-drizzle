/**
 * Regression suite for the wave-2 `react` findings.
 *
 * Each test FAILS against the pre-fix behavior:
 *
 *   - the autoFlush tail's requestAutoFlush(0) must not re-race a submit
 *     that already awaited the in-flight flush (self-inflicted 409)
 *   - an autoflush armed while the submit PATCH is on the wire must defer,
 *     not send a concurrent PATCH under the same version token
 *   - an in-flight instant nested create must not ALSO ride the parent
 *     payload as an id-less create (double-created DB row)
 *   - a flush success on an UNVERSIONED form must not wipe the standing
 *     changed-elsewhere record for fields the flush did not touch
 */
import { describe, it, expect, vi } from 'vitest'
import { FormSession, type SubmitResult, type SubmitPayload } from '../src/form-session.js'
import { NestedArrayManager, type NestedTransport } from '../src/nested.js'

const V1 = '1700000000000'
const V2 = '1700000099999'
const V3 = '1700000199999'

// A promise you resolve by hand — models an in-flight request.
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// ── Bug: the flush tail re-arms an autoflush that races the submit PATCH ─────

describe('submit vs the autoFlush tail re-arm', () => {
  it('a mid-flight edit does not re-arm a flush that races the submit PATCH', async () => {
    const flushGate = deferred<SubmitResult>()
    const submitGate = deferred<SubmitResult>()
    const payloads: SubmitPayload[] = []
    const submit = vi.fn((payload: SubmitPayload) => {
      payloads.push(payload)
      if (payloads.length === 1) return flushGate.promise
      if (payloads.length === 2) return submitGate.promise
      return Promise.resolve({ ok: true } as SubmitResult)
    })
    const s = new FormSession({ draft: { id: 1, a: 'x', b: 'y' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'a-edited')
    const flushP = s.autoFlush()        // PATCH #1 (field a) in flight
    s.setValue('b', 'b-edited')         // mid-flight edit → the tail wants a follow-up
    const submitP = s.submit()          // cancels timers, awaits the in-flight flush

    flushGate.resolve({ ok: true, envelope: { record: { id: 1, a: 'a-edited', b: 'y' }, version: V2 } })
    await flushP
    // Give the tail's would-be 0ms follow-up timer a chance to fire while
    // submit's own PATCH (call #2) is still on the wire.
    await tick()

    // Exactly TWO requests: the flush and the submit — never a third
    // concurrent PATCH under the same token (the self-inflicted 409).
    expect(submit).toHaveBeenCalledTimes(2)
    expect(payloads[1]!._version).toBe(V2)          // submit rode the ADVANCED token
    expect(payloads[1]!.data).toEqual({ b: 'b-edited' })

    submitGate.resolve({ ok: true, envelope: { record: { id: 1, a: 'a-edited', b: 'b-edited' }, version: V3 } })
    await submitP
    expect(submit).toHaveBeenCalledTimes(2)
    expect(s.getStatus()).toBe('saved')
  })

  it('an autoflush requested while the submit PATCH is on the wire defers instead of racing it', async () => {
    const submitGate = deferred<SubmitResult>()
    const submit = vi.fn()
      .mockImplementationOnce(() => submitGate.promise)
      .mockImplementation(async () => ({ ok: true } as SubmitResult))
    const s = new FormSession({ draft: { id: 1, a: 'x', b: 'y' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'a2')
    const submitP = s.submit()          // PATCH #1 in flight (no flush involved)
    s.setValue('b', 'b2')               // user keeps typing during the flight
    s.requestAutoFlush(0)               // the handle's debounce fires mid-submit
    await tick()

    expect(submit).toHaveBeenCalledTimes(1)   // no concurrent PATCH under V1

    submitGate.resolve({ ok: true, envelope: { record: { id: 1, a: 'a2', b: 'b2' }, version: V2 } })
    await submitP
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

// ── Bug: instant nested create racing a parent save double-creates the row ───

describe('instant nested create vs parent save', () => {
  function harness() {
    const createGate = deferred<{ ok: boolean; row?: Record<string, any> }>()
    const transport: NestedTransport = {
      create: vi.fn(() => createGate.promise),
      update: vi.fn(async () => ({ ok: true })),
      destroy: vi.fn(async () => ({ ok: true })),
    }
    const submit = vi.fn(async () => ({ ok: true, envelope: { record: { id: 1, title: 'T2' } } } as SubmitResult))
    const parent = new FormSession({ draft: { id: 1, title: 'T' }, mode: 'edit', abilities: null, submit })
    const mgr = new NestedArrayManager(parent, 'items', [], { instant: true, transport, foreignKey: 'parentId' })
    parent.registerNested('items', mgr)
    return { createGate, transport, submit, parent, mgr }
  }

  it('a parent submit during the in-flight create does not restage the row (double-create)', async () => {
    const { createGate, transport, submit, parent, mgr } = harness()

    mgr.add({ kind: 'like' })                       // instant POST in flight
    expect(transport.create).toHaveBeenCalledTimes(1)
    // The instant op owns this row — it is not parent-save dirt
    expect(parent.isDirty()).toBe(false)

    parent.setValue('title', 'T2')
    await parent.submit()                           // Save inside the POST round-trip

    // The pending row must NOT ride the payload as an id-less nested create.
    const sent = (submit.mock.calls[0]![0] as SubmitPayload).data
    expect(sent.itemsAttributes).toBeUndefined()

    // The instant create settles: exactly ONE row, wearing the server id.
    createGate.resolve({ ok: true, row: { id: 42, kind: 'like' } })
    await tick(0)
    expect(mgr.visible()).toHaveLength(1)
    expect((mgr.visible()[0]!.session.draft as any).id).toBe(42)
  })

  it('a server sync during the in-flight create keeps the optimistic row', async () => {
    const { createGate, parent, mgr } = harness()

    mgr.add({ kind: 'like' })
    // A parent-save echo lands while the POST is out — its rows predate the
    // create, so they carry no verdict on the optimistic row.
    parent.applyEnvelope({ record: { id: 1, title: 'T2', items: [] } })
    expect(mgr.visible()).toHaveLength(1)

    createGate.resolve({ ok: true, row: { id: 42, kind: 'like' } })
    await tick(0)
    expect(mgr.visible()).toHaveLength(1)
    expect((mgr.visible()[0]!.session.draft as any).id).toBe(42)
  })

  it('an echo that already contains the created row does not duplicate it', async () => {
    const { createGate, parent, mgr } = harness()

    mgr.add({ kind: 'like' })
    // The server committed the create before answering the POST, and a parent
    // refetch echoed the fresh row first.
    parent.applyEnvelope({ record: { id: 1, title: 'T2', items: [{ id: 42, kind: 'like' }] } })

    createGate.resolve({ ok: true, row: { id: 42, kind: 'like' } })
    await tick(0)
    expect(mgr.visible()).toHaveLength(1)
    expect((mgr.visible()[0]!.session.draft as any).id).toBe(42)
  })

  it('the in-flight guard lifts once the create settles (later edits still ride the parent save)', async () => {
    const { createGate, mgr } = harness()

    mgr.add({ kind: 'like' })
    expect(mgr.attributesPayload()).toBeNull()      // pending → nothing staged

    createGate.resolve({ ok: true, row: { id: 42, kind: 'like' } })
    await tick(0)

    // Persisted now — a plain (staged) edit folds in as an id-bearing diff.
    mgr.visible()[0]!.session.setValue('kind', 'love')
    expect(mgr.attributesPayload()).toEqual([{ id: 42, kind: 'love' }])
  })
})

// ── Bug: unversioned flush success wipes the standing elsewhere record ───────

describe('conflict bookkeeping on UNVERSIONED forms', () => {
  it('a per-field autosave of an unrelated field keeps the standing incoming record', async () => {
    // No `version` anywhere — the form is not optimistically locked.
    const submit = vi.fn(async () => (
      { ok: true, envelope: { record: { id: 1, a: 'theirs-a', b: 'b2' } } } as SubmitResult
    ))
    const s = new FormSession({ draft: { id: 1, a: 'base-a', b: 'base-b' }, mode: 'edit', abilities: null, submit })

    // A poll rehydrate detects a TRUE conflict on a: mine, base, theirs all differ.
    s.setValue('a', 'mine-a')
    s.rehydrate({ record: { id: 1, a: 'theirs-a', b: 'base-b', updatedByName: 'Mel' } })
    expect(s.getIncomingFor('a')?.value).toBe('theirs-a')

    // Autosave an UNRELATED field — no token can advance, no 409 is possible.
    s.setValue('b', 'b2')
    await s.commitField('b', 'autosave')

    // Field a is still contested: the elsewhere record (and its who) survive.
    expect(s.getIncomingFor('a')?.value).toBe('theirs-a')
    expect(s.getIncomingFor('a')?.by).toBe('Mel')
    expect((s.draft as any).a).toBe('mine-a')       // mine still on the draft
  })

  it('a VERSIONED flush success still clears the bookkeeping (the token advanced)', async () => {
    const submit = vi.fn(async () => (
      { ok: true, envelope: { record: { id: 1, b: 'b2' }, version: V3 } } as SubmitResult
    ))
    const s = new FormSession({ draft: { id: 1, a: 'base-a', b: 'base-b' }, mode: 'edit', abilities: null, version: V1, submit })

    s.setValue('a', 'mine-a')
    s.rehydrate({ record: { id: 1, a: 'theirs-a' }, version: V2 })   // withholds V2
    expect(s.getVersion()).toBe(V1)

    s.setValue('b', 'b2')
    await s.commitField('b', 'autosave')

    expect(s.getIncoming()).toEqual({})
    // A stray late adopt must not roll the token back to the withheld V2.
    s.adoptIncoming('a')
    expect(s.getVersion()).toBe(V3)
  })
})
