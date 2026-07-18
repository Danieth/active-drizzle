import { camelize, underscore } from './string.js'

/**
 * Rails ActiveSupport-style object/hash helpers. Pure functions only —
 * we do NOT extend Object.prototype (that way lies madness).
 */

// ── Presence (universal) ─────────────────────────────────────────────────────

/**
 * Rails' `blank?` for any value:
 * null/undefined, '', '  ', [], {}, empty Map/Set → true. false → true (like Rails).
 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'boolean') return value === false
  if (typeof value === 'string') return value.trim().length === 0
  if (typeof value === 'number') return Number.isNaN(value)
  if (Array.isArray(value)) return value.length === 0
  if (value instanceof Map || value instanceof Set) return value.size === 0
  if (value instanceof Date) return false
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

export function isPresent(value: unknown): boolean {
  return !isBlank(value)
}

/** Returns the value when present, otherwise undefined. Rails' `presence`. */
export function presence<T>(value: T): NonNullable<T> | undefined {
  return isBlank(value) ? undefined : (value as NonNullable<T>)
}

// ── Hash slicing ─────────────────────────────────────────────────────────────

export function slice<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const k of keys) {
    if (k in obj) out[k] = obj[k]
  }
  return out
}

export function except<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const excluded = new Set<PropertyKey>(keys)
  const out = {} as Record<PropertyKey, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (!excluded.has(k)) out[k] = v
  }
  return out as Omit<T, K>
}

/** Removes keys whose value is null or undefined. Rails' `compact`. */
export function compactObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out = {} as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/** Removes keys whose value is blank (Rails' `compact_blank`). */
export function compactBlank<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out = {} as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (!isBlank(v)) out[k] = v
  }
  return out as Partial<T>
}

// ── Key transformation ───────────────────────────────────────────────────────

export function transformKeys<T = unknown>(
  obj: Record<string, T>,
  fn: (key: string) => string
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) out[fn(k)] = v
  return out
}

/** Deep-transforms all keys in nested objects/arrays. */
export function deepTransformKeys(value: unknown, fn: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map(v => deepTransformKeys(v, fn))
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[fn(k)] = deepTransformKeys(v, fn)
    return out
  }
  return value
}

export function camelizeKeys<T = unknown>(obj: Record<string, T>): Record<string, T> {
  return transformKeys(obj, k => camelize(k))
}

export function underscoreKeys<T = unknown>(obj: Record<string, T>): Record<string, T> {
  return transformKeys(obj, underscore)
}

export function deepCamelizeKeys(value: unknown): unknown {
  return deepTransformKeys(value, k => camelize(k))
}

export function deepUnderscoreKeys(value: unknown): unknown {
  return deepTransformKeys(value, underscore)
}

// ── Merging / digging ────────────────────────────────────────────────────────

/** Recursive merge — objects merge, everything else overwrites. Rails' `deep_merge`. */
export function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const out: Record<string, any> = { ...target }
  for (const [k, v] of Object.entries(source)) {
    const existing = out[k]
    if (
      existing !== null && typeof existing === 'object' && existing.constructor === Object &&
      v !== null && typeof v === 'object' && v.constructor === Object
    ) {
      out[k] = deepMerge(existing, v)
    } else {
      out[k] = v
    }
  }
  return out as T
}

/** Safe nested access: `dig(obj, 'a', 'b', 0, 'c')`. Ruby's `dig`. */
export function dig(obj: unknown, ...keys: (string | number)[]): unknown {
  let current: any = obj
  for (const k of keys) {
    if (current === null || current === undefined) return undefined
    current = current[k]
  }
  return current
}
