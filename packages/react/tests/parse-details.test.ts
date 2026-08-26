/**
 * parseControllerError understands the coded wire: per-field `details`
 * (stable machine codes) and the top-level server `code`, additively —
 * everything pre-taxonomy still parses identically.
 */
import { describe, it, expect } from 'vitest'
import { parseControllerError } from '../src/errors.js'

const orpcError = (code: string, data: Record<string, unknown>) => ({
  code, message: 'boom', data,
})

describe('parseControllerError — coded details', () => {
  it('surfaces details and serverCode from a 422 payload', () => {
    const parsed = parseControllerError(orpcError('UNPROCESSABLE_ENTITY', {
      code: 'validation_failed',
      errors: { email: ['has already been taken'] },
      details: { email: [{ code: 'taken', message: 'has already been taken' }] },
    }))
    expect(parsed).not.toBeNull()
    expect(parsed!.isValidation).toBe(true)
    expect(parsed!.fields).toEqual({ email: ['has already been taken'] })
    expect(parsed!.details).toEqual({ email: [{ code: 'taken', message: 'has already been taken' }] })
    expect(parsed!.serverCode).toBe('validation_failed')
  })

  it('meta rides through untouched', () => {
    const parsed = parseControllerError(orpcError('UNPROCESSABLE_ENTITY', {
      details: { title: [{ code: 'too_long', message: 'is too long', meta: { count: 80 } }] },
    }))
    expect(parsed!.details!['title']![0]).toEqual({ code: 'too_long', message: 'is too long', meta: { count: 80 } })
  })

  it('a pre-taxonomy payload (no details, no code) parses exactly as before', () => {
    const parsed = parseControllerError(orpcError('UNPROCESSABLE_ENTITY', {
      errors: { name: ["can't be blank"] },
    }))
    expect(parsed!.fields).toEqual({ name: ["can't be blank"] })
    expect(parsed!.details).toBeUndefined()
    expect(parsed!.serverCode).toBeUndefined()
    expect(parsed!.isValidation).toBe(true)
  })

  it('409 carries serverCode stale_record beside the envelope', () => {
    const parsed = parseControllerError(orpcError('CONFLICT', {
      code: 'stale_record',
      envelope: { record: { id: 7 }, version: '4' },
    }))
    expect(parsed!.isConflict).toBe(true)
    expect(parsed!.serverCode).toBe('stale_record')
    expect(parsed!.envelope).toEqual({ record: { id: 7 }, version: '4' })
  })
})
