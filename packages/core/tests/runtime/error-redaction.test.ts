/**
 * Values must never leave the process (design philosophy rule #4).
 *
 * Postgres embeds the offending value in its error text — `Key (email)=(ada@x.com)
 * already exists.` — which heads straight for Rollbar/Sentry. Once `.encrypt()`
 * ships, that same path can carry a plaintext PII search term.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  onError, reportError, clearErrorHandlers, scrubDbError, redactErrorValues,
  translateDbError,
} from '../../src/runtime/error-reporting.js'

/** A realistic node-postgres unique-violation error. */
function pgUniqueViolation(value = 'ada@example.com') {
  const e: any = new Error(`duplicate key value violates unique constraint "users_email_key"`)
  e.code = '23505'
  e.detail = `Key (email)=(${value}) already exists.`
  e.table = 'users'
  e.constraint = 'users_email_key'
  e.schema = 'public'
  return e
}

function captured(err: unknown) {
  clearErrorHandlers()
  const seen: Array<{ err: any; ctx: any }> = []
  const un = onError((e, ctx) => seen.push({ err: e, ctx }))
  reportError(err, { model: 'User', table: 'users', operation: 'insert' })
  un(); clearErrorHandlers()
  return seen[0]!
}

afterEach(() => clearErrorHandlers())

describe('redactErrorValues', () => {
  it('removes the value but keeps the column name', () => {
    expect(redactErrorValues('Key (email)=(ada@example.com) already exists.'))
      .toBe('Key (email)=(REDACTED) already exists.')
  })

  it('handles composite keys and multiple occurrences', () => {
    expect(redactErrorValues('Key (a, b)=(1, secret) conflicts with Key (c)=(x).'))
      .toBe('Key (a, b)=(REDACTED) conflicts with Key (c)=(REDACTED).')
  })

  it('leaves value-free text untouched', () => {
    const s = 'null value in column "email" violates not-null constraint'
    expect(redactErrorValues(s)).toBe(s)
  })
})

describe('scrubDbError', () => {
  it('redacts detail while preserving every debugging signal', () => {
    const scrubbed: any = scrubDbError(pgUniqueViolation())
    expect(scrubbed.detail).toBe('Key (email)=(REDACTED) already exists.')
    // everything you actually debug with survives:
    expect(scrubbed.code).toBe('23505')
    expect(scrubbed.constraint).toBe('users_email_key')
    expect(scrubbed.table).toBe('users')
    expect(scrubbed.schema).toBe('public')
  })

  it('stays a real Error — stack and instanceof intact', () => {
    const scrubbed = scrubDbError(pgUniqueViolation())
    expect(scrubbed).toBeInstanceOf(Error)
    expect((scrubbed as any).stack).toBeTruthy()
  })

  it('does NOT mutate the original error', () => {
    const original = pgUniqueViolation()
    scrubDbError(original)
    expect(original.detail).toContain('ada@example.com')   // caller's object untouched
  })

  it('redacts where/hint/message too', () => {
    const e: any = new Error('failed on Key (ssn)=(123-45-6789)')
    e.where = 'PL/pgSQL function f() line 3 at Key (ssn)=(123-45-6789)'
    e.hint = 'Key (ssn)=(123-45-6789) is taken'
    const s: any = scrubDbError(e)
    for (const f of ['message', 'where', 'hint']) expect(s[f]).not.toContain('123-45-6789')
  })

  it('passes through non-objects and clean errors unchanged', () => {
    expect(scrubDbError('a string')).toBe('a string')
    expect(scrubDbError(null)).toBeNull()
    const clean = new Error('nothing sensitive')
    expect(scrubDbError(clean)).toBe(clean)               // same reference — no needless clone
  })
})

describe('reportError is the choke point — every path is scrubbed', () => {
  it('handlers never receive the plaintext value', () => {
    const { err } = captured(pgUniqueViolation('ada@example.com'))
    expect(err.detail).not.toContain('ada@example.com')
    expect(err.detail).toContain('(REDACTED)')
    expect(JSON.stringify({ m: err.message, d: err.detail, w: err.where }))
      .not.toContain('ada@example.com')
  })

  it('would redact a plaintext PII search term the same way', () => {
    // The .encrypt() case: a deterministic where({ ssn }) puts the plaintext
    // into the query, and a constraint error would echo it back.
    const { err } = captured(pgUniqueViolation('123-45-6789'))
    expect(err.detail).not.toContain('123-45-6789')
  })

  it('still forwards the context untouched', () => {
    const { ctx } = captured(pgUniqueViolation())
    expect(ctx).toEqual({ model: 'User', table: 'users', operation: 'insert' })
  })

  it('does not leak values through the no-handler console fallback', () => {
    clearErrorHandlers()
    const logged: any[] = []
    const orig = console.error
    console.error = (...a: any[]) => { logged.push(a) }
    try { reportError(pgUniqueViolation('leaky@x.com'), {}) } finally { console.error = orig }
    expect(JSON.stringify(logged.map(a => a.map((x: any) => x?.detail ?? String(x)))))
      .not.toContain('leaky@x.com')
  })
})

describe('redaction does not break the user-facing translation', () => {
  it('translateDbError still extracts the FIELD name from a scrubbed detail', () => {
    // We redact the value but keep `Key (email)`, so field extraction survives.
    const scrubbed = scrubDbError(pgUniqueViolation())
    const t = translateDbError(scrubbed)
    expect(t?.field).toBe('email')
    expect(t?.message).toBe('has already been taken')
    expect(t?.friendly).toBe('email has already been taken')
    expect(JSON.stringify(t)).not.toContain('ada@example.com')
  })
})
