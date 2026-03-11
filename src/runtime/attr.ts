import type { AttrConfig } from './application-record.js'

/**
 * Extended config for Attr.enum — carries the raw values map so the Proxy
 * can synthesise is<Label>() / to<Label>() methods at runtime.
 */
export type AttrEnumConfig<T extends Record<string, number> = Record<string, number>> = AttrConfig & {
  readonly _isAttr: true
  readonly _type: 'enum'
  readonly values: T
}

/**
 * Attr — the declarative field transformation system.
 *
 * Each Attr.* call returns a plain config object that the ApplicationRecord
 * Proxy reads to intercept get/set, apply defaults, and run validations.
 *
 * Usage on a model class:
 *
 *   static status   = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)
 *   static content  = Attr.string({ validate: v => v ? null : 'required' })
 *   static metadata = Attr.json<{ tags: string[] }>()
 *   static price    = Attr.new({ get: v => v / 100, set: v => Math.round(v * 100) })
 */
export const Attr = {
  /**
   * Maps an integer/smallint column ↔ descriptive string labels.
   * Powers is<Label>() predicates and to<Label>() bang setters on instances.
   *
   *   static assetType = Attr.enum({ jpg: 116, png: 125, gif: 111 } as const)
   *   asset.assetType          // → 'jpg'
   *   asset.isJpg()            // → true
   *   asset.toJpg()            // sets assetType = 'jpg', returns instance
   */
  enum<T extends Record<string, number>>(values: T): AttrEnumConfig<T> {
    const inverse: Record<number, string> = {}
    for (const [k, v] of Object.entries(values)) inverse[v] = k
    return {
      _isAttr: true as const,
      _type: 'enum',
      values,
      get: (raw: number | null | undefined) =>
        raw === null || raw === undefined ? null : (inverse[raw] ?? raw),
      set: (val: string | number | null | undefined) => {
        if (val === null || val === undefined) return null
        if (typeof val === 'number') return val
        const numeric = (values as Record<string, number>)[val as string]
        return numeric !== undefined ? numeric : val
      },
    }
  },

  /**
   * Full-control virtual field or column transform.
   *
   *   static price = Attr.new({
   *     get: v => v / 100,
   *     set: v => Math.round(v * 100),
   *     default: 0,
   *     validate: v => v >= 0 ? null : 'must be non-negative',
   *   })
   */
  new(config: Omit<AttrConfig, '_isAttr'>): AttrConfig {
    return { ...config, _isAttr: true }
  },

  /**
   * Bridges an arbitrary property name to a differently-named schema column.
   *
   *   static displayName = Attr.for('full_name', {
   *     get: v => v?.trim(),
   *     set: v => v?.trim(),
   *   })
   */
  for(column: string, config: Pick<AttrConfig, 'get' | 'set' | 'default' | 'validate'>): AttrConfig & { _column: string } {
    return { ...config, _isAttr: true, _column: column }
  },

  /**
   * Explicit string attr — trims on write, coerces null-safely on read.
   */
  string(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw) => (raw === null || raw === undefined ? null : String(raw)),
      set: (val) => (val === null || val === undefined ? null : String(val).trim()),
      ...config,
    }
  },

  /**
   * Explicit integer attr — Number() coercion on both sides.
   */
  integer(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw) => (raw === null || raw === undefined ? null : Number(raw)),
      set: (val) => (val === null || val === undefined ? null : Number(val)),
      ...config,
    }
  },

  /**
   * Explicit boolean attr.
   */
  boolean(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw) => (raw === null || raw === undefined ? null : Boolean(raw)),
      set: (val) => (val === null || val === undefined ? null : Boolean(val)),
      ...config,
    }
  },

  /**
   * JSON serialization attr. Stores as string in TEXT/VARCHAR columns,
   * deserialises on read. Pass a JSONB column and the driver handles it —
   * the transform is a no-op passthrough for already-parsed objects.
   */
  json<T = unknown>(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw): T | null => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'string') {
          try { return JSON.parse(raw) as T } catch { return raw as unknown as T }
        }
        return raw as T
      },
      set: (val) => {
        if (val === null || val === undefined) return null
        if (typeof val === 'string') return val
        return JSON.stringify(val)
      },
      ...config,
    }
  },

  /**
   * Date coercion attr. Accepts Date objects, ISO strings, or timestamps.
   * Reads as a JavaScript `Date`; writes as an ISO string (for TEXT/VARCHAR
   * columns) or passes through a Date object (for DATE/TIMESTAMP columns).
   *
   *   static publishedAt = Attr.date()
   *   post.publishedAt          // → Date object
   *   post.publishedAt = '2024-01-15'  // coerced to Date on read
   */
  date(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw): Date | null => {
        if (raw === null || raw === undefined) return null
        if (raw instanceof Date) return raw
        const d = new Date(raw as string | number)
        return isNaN(d.getTime()) ? null : d
      },
      set: (val): Date | string | null => {
        if (val === null || val === undefined) return null
        if (val instanceof Date) return val
        const d = new Date(val as string | number)
        return isNaN(d.getTime()) ? null : d
      },
      ...config,
    }
  },

  /**
   * Decimal/numeric attr — stores as string (full precision), reads as number.
   * Use for money, rates, or any column that must avoid floating-point drift.
   *
   *   static taxRate = Attr.decimal()
   *   product.taxRate   // → 0.2 (number, read-safe)
   *   product.taxRate = 0.2  // stored as '0.2' string
   */
  decimal(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw): number | null => {
        if (raw === null || raw === undefined) return null
        const n = Number(raw)
        return isNaN(n) ? null : n
      },
      set: (val): string | null => {
        if (val === null || val === undefined) return null
        return String(val)
      },
      ...config,
    }
  },
} as const
