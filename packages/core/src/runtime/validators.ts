/**
 * Rails-style declarative validators — ActiveRecord's basics, as composable
 * validator factories for Attr configs:
 *
 *   import { Attr, Validates } from '@active-drizzle/core'
 *
 *   static title = Attr.string({
 *     validates: [
 *       Validates.presence({ if: (r) => r.isDraft() }),
 *       Validates.length({ min: 3, max: 80 }),
 *     ],
 *   })
 *   static email  = Attr.string({ validates: Validates.email() })
 *   static amount = Attr.money('amountCents', {
 *     validates: Validates.numericality({ greaterThan: 0 }),
 *   })
 *   static slug   = Attr.string({ serverValidates: Validates.uniqueness() })
 *
 * Every factory takes the shared options (message / if / unless / allowNull /
 * allowBlank / on) and returns a plain AttrValidator — `(value, record, key)`
 * — so hand-written validators mix freely in the same array.
 *
 * Divergence from Rails worth knowing: validators SKIP null/undefined values
 * (presence/absence/acceptance excepted). Requiredness is presence()'s job —
 * compose it explicitly instead of every validator failing on nil.
 */

import type { AsyncAttrValidator, AttrValidator, ValidationFailure } from './validation-errors.js'
import { isValidTimezone } from './timezone.js'

/** Options every validator accepts, mirroring Rails' common options. */
export interface ValidatorOptions {
  /** Override the default error message. */
  message?: string
  /** Only validate when this record predicate returns true. */
  if?: (record: any) => boolean
  /** Skip validation when this record predicate returns true. */
  unless?: (record: any) => boolean
  /** Skip when the value is null/undefined (Rails allow_nil). */
  allowNull?: boolean
  /** Skip when the value is blank — null, '', whitespace, [] (Rails allow_blank). */
  allowBlank?: boolean
  /** Only run on INSERT ('create') or UPDATE ('update'). */
  on?: 'create' | 'update'
}

/** Rails-blank: null/undefined, ''/whitespace strings, empty arrays. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/** A coded failure — shorthand constructor keeping call sites terse. */
function fail(code: string, message: string, meta?: Record<string, unknown>): ValidationFailure {
  return meta ? { code, message, meta } : { code, message }
}

/**
 * Wraps a coded check with the shared option gates and builds BOTH lanes of
 * the validator: the public `(value) => string | null` (what tests, the
 * generated client validate(), and hand-written validators all speak) and a
 * `.detailed` sibling returning the full { code, message, meta } failure.
 * The code is born HERE, beside the default message; a `message:` override
 * replaces the TEXT alone — the code survives custom copy and i18n.
 * When invoked without a record (bare `fn(value)` call), the
 * record-dependent gates (if/unless/on) are skipped and the check still runs.
 */
function coded(
  opts: ValidatorOptions,
  check: (value: any, record: any, key: string | undefined) => ValidationFailure | null,
): AttrValidator {
  const detailed = (value: any, record?: any, key?: string): ValidationFailure | null => {
    if (record !== undefined && record !== null) {
      if (opts.if && !opts.if(record)) return null
      if (opts.unless && opts.unless(record)) return null
      if (opts.on === 'create' && !record.isNewRecord) return null
      if (opts.on === 'update' && record.isNewRecord) return null
    }
    if (opts.allowNull && (value === null || value === undefined)) return null
    if (opts.allowBlank && isBlank(value)) return null
    const f = check(value, record, key)
    if (!f) return null
    return opts.message ? { ...f, message: opts.message } : f
  }
  const fn = ((value: any, record?: any, key?: string) =>
    detailed(value, record, key)?.message ?? null) as AttrValidator
  ;(fn as AttrValidator & { detailed: typeof detailed }).detailed = detailed
  return fn
}

/** Most validators skip nil — presence is the one that demands values. */
function skipNil(
  opts: ValidatorOptions,
  check: (value: any, record: any, key: string | undefined) => ValidationFailure | null,
): AttrValidator {
  return coded(opts, (value, record, key) =>
    value === null || value === undefined ? null : check(value, record, key)
  )
}

// ── Rails core validators ──────────────────────────────────────────────────

/** Value must be present: not null, '', whitespace, or []. */
function presence(opts: ValidatorOptions = {}): AttrValidator {
  return coded(opts, (v) => (isBlank(v) ? fail('blank', "can't be blank") : null))
}

/** Value must be blank — the inverse of presence. */
function absence(opts: ValidatorOptions = {}): AttrValidator {
  return coded(opts, (v) => (isBlank(v) ? null : fail('present', 'must be blank')))
}

export interface LengthOptions extends ValidatorOptions {
  min?: number
  max?: number
  /** Exact length (Rails `is:`). */
  is?: number
}

/** String/array length constraints. Skips nil — compose with presence(). */
function length(opts: LengthOptions = {}): AttrValidator {
  return skipNil(opts, (v) => {
    const len = typeof v === 'string' || Array.isArray(v) ? v.length : String(v).length
    if (opts.is !== undefined && len !== opts.is) {
      return fail('wrong_length', `is the wrong length (should be ${opts.is} characters)`, { count: opts.is })
    }
    if (opts.min !== undefined && len < opts.min) {
      return fail('too_short', `is too short (minimum is ${opts.min} characters)`, { count: opts.min })
    }
    if (opts.max !== undefined && len > opts.max) {
      return fail('too_long', `is too long (maximum is ${opts.max} characters)`, { count: opts.max })
    }
    return null
  })
}

export interface NumericalityOptions extends ValidatorOptions {
  onlyInteger?: boolean
  greaterThan?: number
  greaterThanOrEqualTo?: number
  lessThan?: number
  lessThanOrEqualTo?: number
  equalTo?: number
  otherThan?: number
  odd?: boolean
  even?: boolean
  /** Inclusive range shorthand (Rails `in:`). */
  in?: readonly [number, number]
}

/** Numeric constraints. Attr casts guarantee numbers reach here finite. */
function numericality(opts: NumericalityOptions = {}): AttrValidator {
  return skipNil(opts, (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
    if (!Number.isFinite(n)) return fail('not_a_number', 'is not a number')
    if (opts.onlyInteger && !Number.isInteger(n)) return fail('not_an_integer', 'must be an integer')
    if (opts.greaterThan !== undefined && !(n > opts.greaterThan)) {
      return fail('greater_than', `must be greater than ${opts.greaterThan}`, { count: opts.greaterThan })
    }
    if (opts.greaterThanOrEqualTo !== undefined && !(n >= opts.greaterThanOrEqualTo)) {
      return fail('greater_than_or_equal_to', `must be greater than or equal to ${opts.greaterThanOrEqualTo}`, { count: opts.greaterThanOrEqualTo })
    }
    if (opts.lessThan !== undefined && !(n < opts.lessThan)) {
      return fail('less_than', `must be less than ${opts.lessThan}`, { count: opts.lessThan })
    }
    if (opts.lessThanOrEqualTo !== undefined && !(n <= opts.lessThanOrEqualTo)) {
      return fail('less_than_or_equal_to', `must be less than or equal to ${opts.lessThanOrEqualTo}`, { count: opts.lessThanOrEqualTo })
    }
    if (opts.equalTo !== undefined && n !== opts.equalTo) {
      return fail('equal_to', `must be equal to ${opts.equalTo}`, { count: opts.equalTo })
    }
    if (opts.otherThan !== undefined && n === opts.otherThan) {
      return fail('other_than', `must be other than ${opts.otherThan}`, { count: opts.otherThan })
    }
    if (opts.odd && Math.abs(n % 2) !== 1) return fail('odd', 'must be odd')
    if (opts.even && n % 2 !== 0) return fail('even', 'must be even')
    if (opts.in && (n < opts.in[0] || n > opts.in[1])) {
      return fail('inclusion', `must be in ${opts.in[0]}..${opts.in[1]}`, { in: [opts.in[0], opts.in[1]] })
    }
    return null
  })
}

export interface FormatOptions extends ValidatorOptions {
  /** Value must match. */
  with?: RegExp
  /** Value must NOT match. */
  without?: RegExp
}

/** Regex format constraints on the string form of the value. */
function format(opts: FormatOptions = {}): AttrValidator {
  return skipNil(opts, (v) => {
    const s = String(v)
    // Reset lastIndex so /g or /y flags can't make .test() stateful.
    if (opts.with) {
      opts.with.lastIndex = 0
      if (!opts.with.test(s)) return fail('invalid', 'is invalid')
    }
    if (opts.without) {
      opts.without.lastIndex = 0
      if (opts.without.test(s)) return fail('invalid', 'is invalid')
    }
    return null
  })
}

export interface InclusionOptions extends ValidatorOptions {
  in: readonly any[] | ((record: any) => readonly any[])
}

/** Value must be one of the given set (SameValueZero comparison). */
function inclusion(opts: InclusionOptions): AttrValidator {
  return skipNil(opts, (v, record) => {
    const list = typeof opts.in === 'function' ? opts.in(record) : opts.in
    if (list.includes(v)) return null
    const meta = Array.isArray(opts.in) && opts.in.length <= 25 ? { in: [...opts.in] } : undefined
    return fail('inclusion', 'is not included in the list', meta)
  })
}

/** Value must NOT be one of the given set. */
function exclusion(opts: InclusionOptions): AttrValidator {
  return skipNil(opts, (v, record) => {
    const list = typeof opts.in === 'function' ? opts.in(record) : opts.in
    return list.includes(v) ? fail('exclusion', 'is reserved') : null
  })
}

/**
 * Value must equal `<key>Confirmation` on the record
 * (`password` ↔ `passwordConfirmation`). Passes when the confirmation
 * field was never assigned — matching Rails, which only checks when the
 * confirmation attribute is present.
 */
function confirmation(opts: ValidatorOptions = {}): AttrValidator {
  return skipNil(opts, (v, record, key) => {
    if (!record || !key) return null
    const other = record[`${key}Confirmation`]
    if (other === undefined || other === null) return null
    return Object.is(other, v) ? null : fail('confirmation', `doesn't match ${key}`, { attribute: `${key}Confirmation` })
  })
}

type ComparisonOperand = number | Date | ((record: any) => number | Date)

export interface ComparisonOptions extends ValidatorOptions {
  greaterThan?: ComparisonOperand
  greaterThanOrEqualTo?: ComparisonOperand
  lessThan?: ComparisonOperand
  lessThanOrEqualTo?: ComparisonOperand
}

/**
 * Rails 7 comparison validator — works on anything `<`/`>` orders sensibly
 * (numbers, Dates). Operands may be literals or record functions:
 *
 *   Validates.comparison({ greaterThan: (r) => r.startsAt })
 */
function comparison(opts: ComparisonOptions): AttrValidator {
  const resolve = (op: ComparisonOperand, record: any) =>
    typeof op === 'function' ? op(record) : op
  const describe = (x: any) => (x instanceof Date ? x.toISOString() : String(x))
  return skipNil(opts, (v, record) => {
    for (const [name, phrase, ok] of [
      ['greaterThan', 'greater than', (a: any, b: any) => a > b],
      ['greaterThanOrEqualTo', 'greater than or equal to', (a: any, b: any) => a >= b],
      ['lessThan', 'less than', (a: any, b: any) => a < b],
      ['lessThanOrEqualTo', 'less than or equal to', (a: any, b: any) => a <= b],
    ] as const) {
      const op = opts[name]
      if (op === undefined) continue
      const bound = resolve(op, record)
      if (bound === null || bound === undefined) continue
      if (!ok(v, bound)) {
        const CODES = {
          greaterThan: 'greater_than', greaterThanOrEqualTo: 'greater_than_or_equal_to',
          lessThan: 'less_than', lessThanOrEqualTo: 'less_than_or_equal_to',
        } as const
        return fail(CODES[name], `must be ${phrase} ${describe(bound)}`, { count: describe(bound) })
      }
    }
    return null
  })
}

export interface AcceptanceOptions extends ValidatorOptions {
  /** Values that count as accepted. Default: true, 'true', 1, '1', 'yes', 'on'. */
  accept?: readonly any[]
}

/** Checkbox acceptance (terms of service). Nil passes, per Rails. */
function acceptance(opts: AcceptanceOptions = {}): AttrValidator {
  const accepted = opts.accept ?? [true, 'true', 1, '1', 'yes', 'on']
  return skipNil(opts, (v) => (accepted.includes(v) ? null : fail('accepted', 'must be accepted')))
}

// ── fnando/validators-style extras ─────────────────────────────────────────

/** Pragmatic email shape: one @, no whitespace, dotted domain. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function email(opts: ValidatorOptions = {}): AttrValidator {
  return skipNil(opts, (v) =>
    typeof v === 'string' && EMAIL_RE.test(v.trim()) ? null : fail('invalid_email', 'is not a valid email')
  )
}

export interface UrlOptions extends ValidatorOptions {
  /** Allowed protocols. Default: http, https. */
  protocols?: readonly string[]
}

function url(opts: UrlOptions = {}): AttrValidator {
  const protocols = opts.protocols ?? ['http', 'https']
  return skipNil(opts, (v) => {
    if (typeof v !== 'string') return fail('invalid_url', 'is not a valid URL')
    try {
      const u = new URL(v)
      return protocols.includes(u.protocol.replace(/:$/, ''))
        ? null
        : fail('invalid_url', 'is not a valid URL')
    } catch {
      return fail('invalid_url', 'is not a valid URL')
    }
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuid(opts: ValidatorOptions = {}): AttrValidator {
  return skipNil(opts, (v) =>
    typeof v === 'string' && UUID_RE.test(v) ? null : fail('invalid_uuid', 'is not a valid UUID')
  )
}

/** IANA timezone id (canonical, alias, or offset — anything Intl accepts). */
function timezone(opts: ValidatorOptions = {}): AttrValidator {
  return skipNil(opts, (v) =>
    isValidTimezone(v) ? null : fail('invalid_timezone', 'is not a valid timezone')
  )
}

// ── Async / DB-backed ──────────────────────────────────────────────────────

export interface UniquenessOptions extends ValidatorOptions {
  /** Additional record fields that scope the uniqueness constraint. */
  scope?: string | string[]
}

/**
 * DB-backed uniqueness — async, so it belongs in `serverValidates`:
 *
 *   static slug = Attr.string({ serverValidates: Validates.uniqueness() })
 *   static email = Attr.string({
 *     serverValidates: Validates.uniqueness({ scope: 'tenantId' }),
 *   })
 *
 * Queries `Model.where({ [key]: value, ...scopes }).first()` and passes when
 * nothing matches or the match is this record. Like Rails, this is a
 * race-prone application check — keep the real UNIQUE index in the schema.
 */
function uniqueness(opts: UniquenessOptions = {}): AsyncAttrValidator {
  const scopes = opts.scope === undefined ? [] : Array.isArray(opts.scope) ? opts.scope : [opts.scope]
  const detailed = async (value: any, record?: any, key?: string): Promise<ValidationFailure | null> => {
    if (isBlank(value) || !record || !key) return null
    if (record !== undefined && record !== null) {
      if (opts.if && !opts.if(record)) return null
      if (opts.unless && opts.unless(record)) return null
      if (opts.on === 'create' && !record.isNewRecord) return null
      if (opts.on === 'update' && record.isNewRecord) return null
    }
    const Model = record.constructor as any
    const where: Record<string, any> = { [key]: value }
    for (const s of scopes) where[s] = record[s]
    const existing = await Model.where(where).first()
    if (!existing) return null
    const ownId = record.id ?? record._attributes?.id
    if (ownId !== null && ownId !== undefined && existing.id === ownId) return null
    return fail('taken', opts.message ?? 'has already been taken')
  }
  const fn = (async (value: any, record?: any, key?: string) =>
    (await detailed(value, record, key))?.message ?? null) as AsyncAttrValidator
  ;(fn as AsyncAttrValidator & { detailed: typeof detailed }).detailed = detailed
  return fn
}

/**
 * The validator namespace — Rails names, Rails default messages.
 * Import the bag or the individual factories, whichever reads better.
 */
export const Validates = {
  presence,
  absence,
  length,
  numericality,
  format,
  inclusion,
  exclusion,
  confirmation,
  comparison,
  acceptance,
  email,
  url,
  uuid,
  timezone,
  uniqueness,
} as const

export {
  presence,
  absence,
  length,
  numericality,
  format,
  inclusion,
  exclusion,
  confirmation,
  comparison,
  acceptance,
  email,
  url,
  uuid,
  timezone,
  uniqueness,
}
