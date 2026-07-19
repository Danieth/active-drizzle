/**
 * Optimistic concurrency — the client half of update.optimisticLock.
 *
 * The envelope's version token rides every submit as `_version`; a 409
 * parks the session in 'conflict' (draft untouched, autosave paused) and
 * resolveConflict() offers the two honest exits: reload (server wins) or
 * overwrite (adopt the fresh token, resubmit mine).
 */
import { describe, it, expect, vi } from 'vitest'
import { FormSession, type SubmitResult, type ServerEnvelope } from '../src/form-session.js'

const V1 = '1700000000000'
const V2 = '1700000099999'

function conflictResult(envelope?: ServerEnvelope): SubmitResult {
  return { ok: false, status: 409, ...(envelope ? { envelope } : {}) }
}

function makeSession(submit: (p: any) => Promise<SubmitResult>, version: string | null = V1) {
  return new FormSession({
    draft: { id: 1, name: 'mine' },
    mode: 'edit',
    abilities: null,
    version,
    submit,
  })
}

describe('version echo', () => {
  it('submit carries _version from the envelope token', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const s = makeSession(submit)
    s.setValue('name', 'edited')
    await s.submit()
    expect(submit.mock.calls[0]![0]._version).toBe(V1)
  })

  it('no version (un-versioned controller) → no _version key', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const s = makeSession(submit, null)
    s.setValue('name', 'edited')
    await s.submit()
    expect(submit.mock.calls[0]![0]).not.toHaveProperty('_version')
  })

  it('a success envelope rotates the token for the next submit', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, envelope: { record: { id: 1, name: 'edited' }, version: V2 } })
    const s = makeSession(submit)
    s.setValue('name', 'edited')
    await s.submit()
    s.setValue('name', 'edited again')
    await s.submit()
    expect(submit.mock.calls[1]![0]._version).toBe(V2)
  })
})

describe('409 → conflict state', () => {
  it('parks in conflict, draft untouched, envelope retained, base error visible', async () => {
    const fresh: ServerEnvelope = { record: { id: 1, name: 'theirs' }, version: V2 }
    const s = makeSession(vi.fn().mockResolvedValue(conflictResult(fresh)))
    s.setValue('name', 'mine edited')
    expect(await s.submit()).toBe(false)
    expect(s.getStatus()).toBe('conflict')
    expect((s.draft as any).name).toBe('mine edited')          // never clobbered
    expect(s.getConflict()).toEqual(fresh)
    expect(s.baseErrors().join(' ')).toContain('changed elsewhere')
  })

  it('autoFlush is PAUSED while in conflict (no stale-token retry loop)', async () => {
    const submit = vi.fn().mockResolvedValue(conflictResult())
    const s = makeSession(submit)
    s.setValue('name', 'mine edited')
    await s.submit()                     // enter conflict
    expect(s.getStatus()).toBe('conflict')
    const flushed = await s.autoFlush()
    expect(flushed).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)   // no second attempt
  })

  it('field-level autosave 409 keeps the optimistic value and parks the session', async () => {
    const s = makeSession(vi.fn().mockResolvedValue(conflictResult()))
    s.setValue('name', 'typed live')
    expect(await s.commitField('name', 'autosave')).toBe(false)
    expect(s.getStatus()).toBe('conflict')
    expect((s.draft as any).name).toBe('typed live')   // NOT rolled back
  })
})

describe('resolveConflict', () => {
  it("'reload' takes the server's truth: draft folds, version adopts, session clean", async () => {
    const fresh: ServerEnvelope = { record: { id: 1, name: 'theirs' }, version: V2 }
    const submit = vi.fn().mockResolvedValue(conflictResult(fresh))
    const s = makeSession(submit)
    s.setValue('name', 'mine edited')
    await s.submit()
    expect(await s.resolveConflict('reload')).toBe(true)
    expect((s.draft as any).name).toBe('theirs')
    expect(s.getVersion()).toBe(V2)
    expect(s.getStatus()).toBe('ready')
    expect(s.isDirty()).toBe(false)
    expect(s.getConflict()).toBeNull()
  })

  it("'overwrite' adopts the fresh token and resubmits MY diff", async () => {
    const fresh: ServerEnvelope = { record: { id: 1, name: 'theirs' }, version: V2 }
    const submit = vi.fn()
      .mockResolvedValueOnce(conflictResult(fresh))
      .mockResolvedValue({ ok: true, envelope: { record: { id: 1, name: 'mine edited' }, version: '1700000123456' } })
    const s = makeSession(submit)
    s.setValue('name', 'mine edited')
    await s.submit()                                    // 409
    expect(await s.resolveConflict('overwrite')).toBe(true)
    // The resubmit carried MY value under THEIR fresh token
    const resubmit = submit.mock.calls[1]![0]
    expect(resubmit.data.name).toBe('mine edited')
    expect(resubmit._version).toBe(V2)
    expect(s.getStatus()).toBe('saved')
    expect(s.getConflict()).toBeNull()
  })
})
