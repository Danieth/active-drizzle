/**
 * ActiveModel-style errors bag.
 *
 * Every error MUST carry a non-empty message string. Empty / whitespace-only
 * messages are rejected — silent failures are not allowed.
 */

const utilInspect = Symbol.for('nodejs.util.inspect.custom')

export class ValidationErrors {
  private _messages: Record<string, string[]> = {}

  /** Add an error for `field`. Message must be a non-empty string. */
  add(field: string, message: string): void {
    const msg = normalizeMessage(message)
    if (msg === null) {
      throw new TypeError(
        `ValidationErrors.add("${field}", …): every error must include a non-empty message`
      )
    }
    ;(this._messages[field] ??= []).push(msg)
  }

  /** Messages for one field (empty array if none). */
  on(field: string): string[] {
    return this._messages[field] ? [...this._messages[field]!] : []
  }

  /** Full bag as a plain object (copy). */
  all(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(this._messages)) out[k] = [...v]
    return out
  }

  /** Rails-style full messages: `['email must be valid', ...]`. */
  full(): string[] {
    const out: string[] = []
    for (const [field, messages] of Object.entries(this._messages)) {
      for (const msg of messages) {
        out.push(field === 'base' ? msg : `${field} ${msg}`)
      }
    }
    return out
  }

  clear(): void {
    this._messages = {}
  }

  /** Replace all messages for a field (used by legacy `errors[field] = [...]`). */
  replace(field: string, messages: string[]): void {
    const normalized: string[] = []
    for (const m of messages) {
      const msg = normalizeMessage(m)
      if (msg === null) {
        throw new TypeError(
          `ValidationErrors.replace("${field}", …): every error must include a non-empty message`
        )
      }
      normalized.push(msg)
    }
    if (normalized.length === 0) delete this._messages[field]
    else this._messages[field] = normalized
  }

  isEmpty(): boolean {
    return Object.keys(this._messages).length === 0
  }

  get size(): number {
    return Object.keys(this._messages).length
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
 */
export type AttrValidator = (val: any) => string | null | undefined

export function runValidators(
  validators: AttrValidator | AttrValidator[] | undefined,
  value: any,
): string[] {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const errors: string[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const result = fn(value)
    const msg = normalizeMessage(result)
    if (msg !== null) errors.push(msg)
  }
  return errors
}

export async function runAsyncValidators(
  validators:
    | ((val: any) => Promise<string | null | undefined>)
    | Array<(val: any) => Promise<string | null | undefined>>
    | undefined,
  value: any,
): Promise<string[]> {
  if (!validators) return []
  const list = Array.isArray(validators) ? validators : [validators]
  const errors: string[] = []
  for (const fn of list) {
    if (typeof fn !== 'function') continue
    const result = await fn(value)
    const msg = normalizeMessage(result)
    if (msg !== null) errors.push(msg)
  }
  return errors
}
