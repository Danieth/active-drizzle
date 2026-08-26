/**
 * The error-code taxonomy at the wire: every serialized error carries a
 * STABLE top-level `code`, and 422s carry per-field coded `details` beside
 * the unchanged `errors` message map. Clients branch on codes, never text.
 */
import { describe, it, expect } from 'vitest'
import { ValidationErrors } from '@active-drizzle/core'
import {
  BadRequest, Unauthorized, Forbidden, NotFound, Conflict, ValidationError,
  toValidationError, serializeError,
} from '../src/errors.js'

describe('every HttpError carries its stable code', () => {
  const table: Array<[InstanceType<any>, number, string]> = [
    [new BadRequest('nope'), 400, 'bad_request'],
    [new Unauthorized(), 401, 'unauthorized'],
    [new Forbidden('no'), 403, 'forbidden'],
    [new NotFound('Deal'), 404, 'not_found'],
    [new Conflict({ record: { id: 1 } }), 409, 'stale_record'],
    [new ValidationError({ name: ["can't be blank"] }), 422, 'validation_failed'],
  ]
  for (const [err, status, code] of table) {
    it(`${err.constructor.name} → ${status} code '${code}'`, () => {
      expect(err.code).toBe(code)
      const { status: s, body } = serializeError(err)
      expect(s).toBe(status)
      expect((body as any).code).toBe(code)
    })
  }
})

describe('422 wire shape', () => {
  it('details ride beside the unchanged errors map', () => {
    const err = new ValidationError(
      { email: ['has already been taken'] },
      { email: [{ code: 'taken', message: 'has already been taken' }] },
    )
    const { body } = serializeError(err)
    expect(body).toEqual({
      code: 'validation_failed',
      errors: { email: ['has already been taken'] },
      details: { email: [{ code: 'taken', message: 'has already been taken' }] },
    })
  })

  it('a details-less ValidationError serializes without the key (legacy callers unchanged)', () => {
    const { body } = serializeError(new ValidationError({ name: ['is invalid'] }))
    expect(body).toEqual({ code: 'validation_failed', errors: { name: ['is invalid'] } })
  })

  it("toValidationError lifts a REAL core errors bag's details onto the wire", () => {
    const bag = new ValidationErrors()
    bag.add('title', 'is too long (maximum is 80 characters)', { code: 'too_long', meta: { count: 80 } })
    const err = toValidationError(bag)
    expect(err.errors).toEqual({ title: ['is too long (maximum is 80 characters)'] })
    expect(err.details).toEqual({
      title: [{ code: 'too_long', message: 'is too long (maximum is 80 characters)', meta: { count: 80 } }],
    })
  })

  it('toValidationError still accepts a plain Record (no details emitted)', () => {
    const err = toValidationError({ name: ["can't be blank"] })
    expect(err.errors).toEqual({ name: ["can't be blank"] })
    expect(err.details).toBeUndefined()
  })
})
