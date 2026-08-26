/**
 * ActiveModel-style errors bag.
 *
 * Every error MUST carry a non-empty message string. Empty / whitespace-only
 * messages are rejected — silent failures are not allowed.
 *
 * Every error ALSO carries a stable machine-readable `code` (Rails'
 * errors.details, e.g. 'blank' | 'too_long' | 'taken'). The DETAIL is the
 * stored truth; the message views (`all()`, `on()`, `full()`, `toJSON()`)
 * are projections of it, so message text and code can never drift apart.
 * `message:` overrides on validators change the TEXT a user reads — the
 * code survives custom copy and i18n, which is the entire point of having it.
 */

const utilInspect = Symbol.for('nodejs.util.inspect.custom')

/** One recorded failure: stable code + human message (+ i18n-ready meta). */
export interface ErrorDetail {
  code: string
  message: string
  meta?: Record<string, unknown>
}

/**
 * The framework's own codes (Rails names where Rails has them). The set is
 * OPEN — apps add their own codes via `errors.add(f, msg, { code })` — but
 * everything the framework emits comes from this list.
 */
export type KnownValidationCode =
  | 'blank' | 'present'
  | 'too_short' | 'too_long' | 'wrong_length'
  | 'not_a_number' | 'not_an_integer'
  | 'greater_than' | 'greater_than_or_equal_to'
  | 'less_than' | 'less_than_or_equal_to'
  | 'equal_to' | 'other_than' | 'odd' | 'even'
  | 'inclusion' | 'exclusion'
  | 'confirmation' | 'accepted'
  | 'invalid' | 'invalid_email' | 'invalid_url' | 'invalid_uuid' | 'invalid_timezone'
  | 'taken' | 'foreign_key'
  | 'invalid_event' | 'invalid_transition' | 'nested_invalid'

export class ValidationErrors {
  private _details: Record<string, ErrorDetail[]> = {}

  /**
   * Add an error for `field`. Message must be a non-empty string.
   * `opts.code` defaults to 'invalid' — a bare-string error is still a
   * machine-readable one, just an unspecific one.
   */
  add(field: string, message: string, opts: { code?: string; meta?: Record<string, unknown> } = {}): void {
    const msg = normalizeMessage(message)
    if (msg === null) {
      throw new TypeError(
        `ValidationErrors.add("${field}", …): every error must include a non-empty message`
      )
    }
    const detail: ErrorDetail = { code: opts.code ?? 'invalid', message: msg }
    if (opts.meta) detail.meta = opts.meta
    ;(this._details[field] ??= []).push(detail)
  }

  /** Add a fully-formed detail (validator pipelines that already carry codes). */
  addDetail(field: string, detail: ErrorDetail): void {
    this.add(field, detail.message, { code: detail.code, ...(detail.meta ? { meta: detail.meta } : {}) })
  }

  /** Messages for one field (empty array if none). */
  on(field: string): string[] {
    return this._details[field] ? this._details[field]!.map(d => d.message) : []
  }

  /** Details for one field (empty array if none). */
  detailsFor(field: string): ErrorDetail[] {
    return this._details[field] ? this._details[field]!.map(d => ({ ...d })) : []
  }

  /** Full bag as a plain object (copy). */
  all(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(this._details)) out[k] = v.map(d => d.message)
    return out
  }

  /** Full detail bag as a plain object (copy) — the wire's `details` key. */
  details(): Record<string, ErrorDetail[]> {
    const out: Record<string, ErrorDetail[]> = {}
    for (const [k, v] of Object.entries(this._details)) out[k] = v.map(d => ({ ...d }))
    return out
  }

  /** Rails-style full messages: `['email must be valid', ...]`. */
  full(): string[] {
    const out: string[] = []
    for (const [field, details] of Object.entries(this._details)) {
      for (const d of details) {
        out.push(field === 'base' ? d.message : `${field} ${d.message}`)
      }
    }
    return out
  }

  clear(): void {
    this._details = {}
  }

  /** Replace all messages for a field (used by legacy `errors[field] = [...]`). */
  replace(field: string, messages: string[]): void {
    const normalized: ErrorDetail[] = []
    for (const m of messages) {
      const msg = normalizeMessage(m)
      if (msg === null) {
        throw new TypeError(
          `ValidationErrors.replace("${field}", …): every error must include a non-empty message`
        )
      }
      normalized.push({ code: 'invalid', message: msg })
    }
    if (normalized.length === 0) delete this._details[field]
    else this._details[field] = normalized
  }

  isEmpty(): boolean {
    return Object.keys(this._details).length === 0
  }

  get size(): number {
    return Object.keys(this._details).length
  }

  /** True if any errors are present. */
  any(): boolean {
    return !this.isEmpty()
  }

  /** JSON / console — looks like the old Record shape. */
  toJSON(): Record<string, string[]> {
    return this.all()
  }

  [utilInspect](): Record<string, string[]> {
    return this.all()
  }

  /** Plain-object view for APIs that still expect Record<field, string[]>. */
  asRecord(): Record<string, string[]> {
    return this.all()
  }
}

/**
 * Creates a ValidationErrors bag that ALSO supports legacy bracket access:
 *   errors.add('email', 'is invalid')
 *   errors['email']                      // → string[]
 *   errors['email'] = ['is invalid']     // → calls add for each
 */
export function createValidationErrors(): ValidationErrors {
  const bag = new ValidationErrors()
  return new Proxy(bag, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target) && prop !== 'then') {
        return target.on(prop)
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value, receiver) {
      if (typeof prop === 'string' && !(prop in target)) {
        if (Array.isArray(value)) {
          target.replace(prop, value)
          return true
        }
        if (typeof value === 'string') {
          target.add(prop, value)
          return true
        }
      }
      return Reflect.set(target, prop, value, receiver)
    },
    ownKeys(target) {
      return Reflect.ownKeys(target.all())
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && target.on(prop).length > 0) {
        return { configurable: true, enumerable: true, writable: true, value: target.on(prop) }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })
}

/** Returns trimmed message, or null if empty / not a string. */
export function normalizeMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Runs one or many validators. Each must return a non-empty string to record
 * an error, or null/undefined/'' to pass. Empty strings are treated as "no
 * error" (same as null) — callers who want to signal failure must write a message.
 *
 * Validators also receive the record and the attr key, so declarative
 * validators (Validates.presence({ if: r => r.isDraft() }), confirmation,
 * uniqueness) can see model state. Plain (value) => … validators just
 * ignore the extra arguments.
 */
export type AttrValidator = (val: any, record?: any, key?: string) => string | null | undefined

export function runValidators(
  validators: AttrValidator | AttrValidator[] | undefined,
  value: any,
  record?: any,
  key?: string,
): string[] {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const errors: string[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const result = fn(value, record, key)
    const msg = normalizeMessage(result)
    if (msg !== null) errors.push(msg)
  }
  return errors
}

export type AsyncAttrValidator = (
  val: any,
  record?: any,
  key?: string,
) => Promise<string | null | undefined> | string | null | undefined

export async function runAsyncValidators(
  validators: AsyncAttrValidator | AsyncAttrValidator[] | undefined,
  value: any,
  record?: any,
  key?: string,
): Promise<string[]> {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const errors: string[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const result = await fn(value, record, key)
    const msg = normalizeMessage(result)
    if (msg !== null) errors.push(msg)
  }
  return errors
}

// ── The detailed (coded) lane ──────────────────────────────────────────────
//
// Validators are plain `(value) => string | null` functions everywhere —
// tests call them bare, the generated client validate() pushes their string
// returns, hand-written app validators return strings. That surface stays.
// Framework factories (Validates.*) ADDITIONALLY attach a `.detailed`
// sibling on the same function returning the full { code, message, meta }
// failure. These runners prefer that lane and wrap bare strings as
// code 'invalid', so the errors bag records a code for every failure
// without any caller changing shape.

/** One validator failure with its stable code (same shape as ErrorDetail). */
export type ValidationFailure = ErrorDetail

type Detailed = { detailed?: (val: any, record?: any, key?: string) => ValidationFailure | null | undefined }
type DetailedAsync = { detailed?: (val: any, record?: any, key?: string) => Promise<ValidationFailure | null | undefined> | ValidationFailure | null | undefined }

function wrapBare(result: unknown): ValidationFailure | null {
  const msg = normalizeMessage(result)
  return msg === null ? null : { code: 'invalid', message: msg }
}

export function runValidatorsDetailed(
  validators: AttrValidator | AttrValidator[] | undefined,
  value: any,
  record?: any,
  key?: string,
): ValidationFailure[] {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const failures: ValidationFailure[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const detailed = (fn as AttrValidator & Detailed).detailed
    if (typeof detailed === 'function') {
      const f = detailed(value, record, key)
      if (f && normalizeMessage(f.message) !== null) failures.push(f)
    } else {
      const f = wrapBare(fn(value, record, key))
      if (f) failures.push(f)
    }
  }
  return failures
}

export async function runAsyncValidatorsDetailed(
  validators: AsyncAttrValidator | AsyncAttrValidator[] | undefined,
  value: any,
  record?: any,
  key?: string,
): Promise<ValidationFailure[]> {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const failures: ValidationFailure[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const detailed = (fn as AsyncAttrValidator & DetailedAsync).detailed
    if (typeof detailed === 'function') {
      const f = await detailed(value, record, key)
      if (f && normalizeMessage(f.message) !== null) failures.push(f)
    } else {
      const f = wrapBare(await fn(value, record, key))
      if (f) failures.push(f)
    }
  }
  return failures
}
