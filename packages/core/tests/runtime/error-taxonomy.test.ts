/**
 * The error-code taxonomy — every framework-emitted failure carries a STABLE
 * machine-readable code beside its message (Rails' errors.details shape).
 * The law under test: `message:` overrides change the TEXT a user reads;
 * the code NEVER moves. Clients branch on codes, not message text.
 */
import { describe, it, expect } from 'vitest'
import { Validates } from '../../src/runtime/validators.js'
import {
  ValidationErrors,
  runValidatorsDetailed,
  runAsyncValidatorsDetailed,
  type AttrValidator,
} from '../../src/runtime/validation-errors.js'
import { translateDbError } from '../../src/runtime/error-reporting.js'

const detailed = (fn: AttrValidator) => (fn as any).detailed as (v: any, r?: any, k?: string) => any

describe('every Validates factory carries its taxonomy code on the .detailed lane', () => {
  // [factory result, failing value, expected code, expected meta subset]
  const table: Array<[string, AttrValidator, any, string, Record<string, unknown>?]> = [
    ['presence',            Validates.presence(),                       '',       'blank'],
    ['absence',             Validates.absence(),                        'x',      'present'],
    ['length is',           Validates.length({ is: 2 }),                'abc',    'wrong_length', { count: 2 }],
    ['length min',          Validates.length({ min: 3 }),               'ab',     'too_short',    { count: 3 }],
    ['length max',          Validates.length({ max: 3 }),               'abcd',   'too_long',     { count: 3 }],
    ['numericality NaN',    Validates.numericality(),                   'nope',   'not_a_number'],
    ['onlyInteger',         Validates.numericality({ onlyInteger: true }), 1.5,   'not_an_integer'],
    ['greaterThan',         Validates.numericality({ greaterThan: 5 }), 5,        'greater_than', { count: 5 }],
    ['gte',                 Validates.numericality({ greaterThanOrEqualTo: 5 }), 4, 'greater_than_or_equal_to', { count: 5 }],
    ['lessThan',            Validates.numericality({ lessThan: 5 }),    5,        'less_than',    { count: 5 }],
    ['lte',                 Validates.numericality({ lessThanOrEqualTo: 5 }), 6,  'less_than_or_equal_to', { count: 5 }],
    ['equalTo',             Validates.numericality({ equalTo: 5 }),     4,        'equal_to',     { count: 5 }],
    ['otherThan',           Validates.numericality({ otherThan: 5 }),   5,        'other_than',   { count: 5 }],
    ['odd',                 Validates.numericality({ odd: true }),      2,        'odd'],
    ['even',                Validates.numericality({ even: true }),     3,        'even'],
    ['numericality in',     Validates.numericality({ in: [1, 5] }),     9,        'inclusion',    { in: [1, 5] }],
    ['format with',         Validates.format({ with: /^a/ }),           'b',      'invalid'],
    ['format without',      Validates.format({ without: /x/ }),         'x',      'invalid'],
    ['inclusion',           Validates.inclusion({ in: ['a', 'b'] }),    'c',      'inclusion',    { in: ['a', 'b'] }],
    ['exclusion',           Validates.exclusion({ in: ['a'] }),         'a',      'exclusion'],
    ['comparison gt',       Validates.comparison({ greaterThan: 5 }),   4,        'greater_than'],
    ['acceptance',          Validates.acceptance(),                     false,    'accepted'],
    ['email',               Validates.email(),                          'nope',   'invalid_email'],
    ['url',                 Validates.url(),                            'nope',   'invalid_url'],
    ['uuid',                Validates.uuid(),                           'nope',   'invalid_uuid'],
    ['timezone',            Validates.timezone(),                       'nope',   'invalid_timezone'],
  ]

  for (const [name, fn, bad, code, meta] of table) {
    it(`${name} → '${code}'`, () => {
      const f = detailed(fn)(bad)
      expect(f).not.toBeNull()
      expect(f.code).toBe(code)
      expect(typeof f.message).toBe('string')
      // the string lane projects the SAME failure's message
      expect(fn(bad)).toBe(f.message)
      if (meta) expect(f.meta).toMatchObject(meta)
    })
  }

  it('confirmation → confirmation (needs record + key)', () => {
    const rec = { passwordConfirmation: 'aaa' }
    const f = detailed(Validates.confirmation())('bbb', rec, 'password')
    expect(f.code).toBe('confirmation')
    expect(f.meta).toMatchObject({ attribute: 'passwordConfirmation' })
  })

  it("message: overrides the TEXT and never the code — the law", () => {
    const fn = Validates.length({ max: 3, message: 'is way too wordy' })
    const f = detailed(fn)('abcd')
    expect(f).toMatchObject({ code: 'too_long', message: 'is way too wordy', meta: { count: 3 } })
    expect(fn('abcd')).toBe('is way too wordy')
  })

  it('the gates (allowBlank / if / on) apply identically to both lanes', () => {
    const fn = Validates.length({ min: 3, allowBlank: true })
    expect(fn('')).toBeNull()
    expect(detailed(fn)('')).toBeNull()
    const gated = Validates.presence({ if: (r: any) => r.strict })
    expect(detailed(gated)('', { strict: false })).toBeNull()
    expect(detailed(gated)('', { strict: true })!.code).toBe('blank')
  })
})

describe('runValidatorsDetailed', () => {
  it('mixes coded factories with bare-string hand validators (code: invalid)', () => {
    const hand: AttrValidator = v => (v === 'bad' ? 'smells funny' : null)
    const failures = runValidatorsDetailed([Validates.presence(), hand], 'bad')
    expect(failures).toEqual([{ code: 'invalid', message: 'smells funny' }])
    const both = runValidatorsDetailed([Validates.presence(), hand], '')
    expect(both.map(f => f.code)).toEqual(['blank'])
  })

  it('async: uniqueness carries taken through the detailed lane', async () => {
    const record = { constructor: { where: () => ({ first: async () => ({ id: 99 }) }) }, id: 1, isNewRecord: false }
    const failures = await runAsyncValidatorsDetailed(Validates.uniqueness(), 'dupe', record, 'slug')
    expect(failures).toEqual([{ code: 'taken', message: 'has already been taken' }])
  })
})

describe('the errors bag stores details as the truth; messages are projections', () => {
  it('add() defaults code invalid; coded adds carry through every view', () => {
    const bag = new ValidationErrors()
    bag.add('email', 'has already been taken', { code: 'taken' })
    bag.add('email', 'looks odd')
    bag.add('name', "can't be blank", { code: 'blank' })
    expect(bag.all()).toEqual({ email: ['has already been taken', 'looks odd'], name: ["can't be blank"] })
    expect(bag.on('email')).toEqual(['has already been taken', 'looks odd'])
    expect(bag.details()).toEqual({
      email: [{ code: 'taken', message: 'has already been taken' }, { code: 'invalid', message: 'looks odd' }],
      name: [{ code: 'blank', message: "can't be blank" }],
    })
    expect(bag.detailsFor('name')[0]!.code).toBe('blank')
    expect(bag.full()).toContain('email has already been taken')
    expect(bag.toJSON()).toEqual(bag.all())
  })

  it('meta rides the detail and stays JSON-plain', () => {
    const bag = new ValidationErrors()
    bag.add('title', 'is too long (maximum is 80 characters)', { code: 'too_long', meta: { count: 80 } })
    expect(JSON.parse(JSON.stringify(bag.details()))).toEqual({
      title: [{ code: 'too_long', message: 'is too long (maximum is 80 characters)', meta: { count: 80 } }],
    })
  })
})

describe('translateDbError carries the taxonomy code beside the SQLSTATE', () => {
  const cases: Array<[string, string]> = [
    ['23502', 'blank'], ['23505', 'taken'], ['23503', 'foreign_key'],
    ['22001', 'too_long'], ['23514', 'invalid'],
  ]
  for (const [sqlstate, code] of cases) {
    it(`${sqlstate} → '${code}'`, () => {
      const t = translateDbError({ code: sqlstate, detail: 'Key (email)=(x) already exists.' })
      expect(t).not.toBeNull()
      expect(t!.errorCode).toBe(code)
      expect(t!.code).toBe(sqlstate)
    })
  }
})
