/**
 * Pluggable error reporting + PG error translation.
 *
 * The contract: raw errors go to whatever handler the app registered
 * (Rollbar, Sentry, …) — the user gets a friendly, validation-shaped
 * message. Programming errors still throw; database errors never do
 * (outside transactions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  onError,
  reportError,
  clearErrorHandlers,
  translateDbError,
  GENERIC_DB_MESSAGE,
} from '../../src/runtime/error-reporting.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, transaction } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'

/** A node-postgres-shaped error: code + optional column/detail. */
function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg error ${code}`), { code, ...extra })
}

afterEach(() => clearErrorHandlers())

// ---------------------------------------------------------------------------
// The handler bus
// ---------------------------------------------------------------------------

describe('onError / reportError', () => {
  it('fans out to every handler with error and context', () => {
    const a = vi.fn()
    const b = vi.fn()
    onError(a)
    onError(b)
    const err = new Error('boom')
    reportError(err, { model: 'User' })
    expect(a).toHaveBeenCalledWith(err, { model: 'User' })
    expect(b).toHaveBeenCalledWith(err, { model: 'User' })
  })

  it('unsubscribe stops delivery', () => {
    const a = vi.fn()
    const off = onError(a)
    off()
    reportError(new Error('x'))
    expect(a).not.toHaveBeenCalled()
  })

  it('a throwing handler cannot break reporting', () => {
    const bad = vi.fn(() => { throw new Error('handler exploded') })
    const good = vi.fn()
    onError(bad)
    onError(good)
    expect(() => reportError(new Error('x'))).not.toThrow()
    expect(good).toHaveBeenCalled()
  })

  it('falls back to console.error when nothing is registered', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportError(new Error('lonely'))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// SQLSTATE translation
// ---------------------------------------------------------------------------

describe('translateDbError', () => {
  it('23502 not_null_violation → field-level blank error', () => {
    const t = translateDbError(pgError('23502', { column: 'email' }))
    expect(t).toMatchObject({ kind: 'constraint', field: 'email', message: "can't be blank" })
  })

  it('23505 unique_violation → parses the field from detail', () => {
    const t = translateDbError(pgError('23505', { detail: 'Key (email)=(a@b.co) already exists.' }))
    expect(t).toMatchObject({ field: 'email', message: 'has already been taken' })
  })

  it('23503 / 23514 / 22001 / 22003 / 22P02 map to their messages', () => {
    expect(translateDbError(pgError('23503'))!.message).toBe('refers to something that no longer exists')
    expect(translateDbError(pgError('23514'))!.message).toBe('is invalid')
    expect(translateDbError(pgError('22001'))!.message).toBe('is too long')
    expect(translateDbError(pgError('22003'))!.message).toBe('is out of range')
    expect(translateDbError(pgError('22P02'))!.message).toBe('is invalid')
  })

  it('deadlocks and serialization failures are retryable', () => {
    expect(translateDbError(pgError('40P01'))!.kind).toBe('retryable')
    expect(translateDbError(pgError('40001'))!.kind).toBe('retryable')
  })

  it('connection-class errors are unavailable', () => {
    expect(translateDbError(pgError('08006'))!.kind).toBe('unavailable')
    expect(translateDbError(pgError('53300'))!.kind).toBe('unavailable')
    expect(translateDbError(pgError('57P01'))!.kind).toBe('unavailable')
  })

  it('friendly falls back to the generic sentence without a field', () => {
    expect(translateDbError(pgError('23514'))!.friendly).toBe(GENERIC_DB_MESSAGE)
  })

  it('non-DB errors return null — programming bugs are not translated', () => {
    expect(translateDbError(new TypeError('x is not a function'))).toBeNull()
    expect(translateDbError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBeNull()
    expect(translateDbError(null)).toBeNull()
    expect(translateDbError('string')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// save()/destroy() integration
// ---------------------------------------------------------------------------

function makeThrowingDb(err: unknown) {
  return {
    insert: () => ({ values: () => ({ returning: () => Promise.reject(err) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.reject(err) }) }) }),
    delete: () => ({ where: () => Promise.reject(err) }),
    transaction: async (fn: any) => fn(makeThrowingDb(err)),
  } as any
}

const fakeTable = {} // save() only needs the table to exist in the schema

@model('gadgets')
class Gadget extends ApplicationRecord {}

describe('save() catches database errors', () => {
  beforeEach(() => clearErrorHandlers())

  it('unique violation → field error + false, raw error reported', async () => {
    const seen: any[] = []
    onError((e, ctx) => seen.push([e, ctx]))
    boot(makeThrowingDb(pgError('23505', { detail: 'Key (serial)=(x1) already exists.' })), { gadgets: fakeTable })

    const g = new (Gadget as any)({ serial: 'x1' }, true)
    expect(await g.save()).toBe(false)
    expect(g.errors.on('serial')).toEqual(['has already been taken'])
    expect(seen).toHaveLength(1)
    expect((seen[0][0] as any).code).toBe('23505')
    expect(seen[0][1]).toMatchObject({ model: 'Gadget', operation: 'insert' })
  })

  it('field-less DB error → base error with the generic sentence', async () => {
    boot(makeThrowingDb(pgError('53300')), { gadgets: fakeTable })
    const g = new (Gadget as any)({}, true)
    expect(await g.save()).toBe(false)
    expect(g.errors.on('base')).toEqual(['The service is temporarily unavailable. Please try again shortly.'])
  })

  it('non-DB errors still throw — bugs never become banners', async () => {
    boot(makeThrowingDb(new TypeError('cannot read x of undefined')), { gadgets: fakeTable })
    const g = new (Gadget as any)({}, true)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(g.save()).rejects.toThrow('cannot read x of undefined')
    spy.mockRestore()
  })

  it('inside a transaction the error rethrows so the tx rolls back', async () => {
    const err = pgError('23505', { detail: 'Key (serial)=(x1) already exists.' })
    boot(makeThrowingDb(err), { gadgets: fakeTable })
    onError(() => {})
    await expect(
      transaction(async () => {
        const g = new (Gadget as any)({ serial: 'x1' }, true)
        await g.save()
      })
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('destroy() gets the same treatment', async () => {
    boot(makeThrowingDb(pgError('23503', { detail: 'Key (id)=(7) is still referenced from table "orders".' })), { gadgets: fakeTable })
    const g = new (Gadget as any)({ id: 7 }, false)
    onError(() => {})
    expect(await g.destroy()).toBe(false)
    expect(g.errors.on('id')).toEqual(['refers to something that no longer exists'])
  })
})
