import type { AttrConfig } from './application-record.js'

/**
 * A parsed Postgres range. Mirrors the wire format `[lower,upper)`:
 * null bounds mean unbounded, `isEmpty` mirrors PG's 'empty' ranges.
 */
export interface PgRange<T = number> {
  lower: T | null
  upper: T | null
  lowerInclusive: boolean
  upperInclusive: boolean
  isEmpty?: boolean
}

/** Parses a Postgres range literal: '[1,10)', '(,5]', 'empty'. */
export function parsePgRange<T>(raw: string, parseBound: (s: string) => T): PgRange<T> {
  const s = raw.trim()
  if (s === 'empty') {
    return { lower: null, upper: null, lowerInclusive: false, upperInclusive: false, isEmpty: true }
  }
  const m = s.match(/^([[(])(.*),(.*)([\])])$/)
  if (!m) throw new Error(`Invalid Postgres range literal: ${JSON.stringify(raw)}`)
  const [, lb, lo = '', hi = '', ub] = m
  const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1')
  return {
    lower: lo === '' ? null : parseBound(unquote(lo)),
    upper: hi === '' ? null : parseBound(unquote(hi)),
    lowerInclusive: lb === '[',
    upperInclusive: ub === ']',
  }
}

/** Serializes a PgRange back to the Postgres literal format. */
export function serializePgRange<T>(range: PgRange<T>, formatBound: (v: T) => string): string {
  if (range.isEmpty) return 'empty'
  const lb = range.lowerInclusive ? '[' : '('
  const ub = range.upperInclusive ? ']' : ')'
  const lo = range.lower === null ? '' : formatBound(range.lower)
  const hi = range.upper === null ? '' : formatBound(range.upper)
  return `${lb}${lo},${hi}${ub}`
}

/** Does the range contain the value? Respects bound inclusivity. */
export function rangeIncludes<T extends number | Date>(range: PgRange<T>, value: T): boolean {
  if (range.isEmpty) return false
  const v = value instanceof Date ? value.getTime() : value
  const lo = range.lower instanceof Date ? range.lower.getTime() : range.lower
  const hi = range.upper instanceof Date ? range.upper.getTime() : range.upper
  if (lo !== null && (range.lowerInclusive ? v < lo : v <= lo)) return false
  if (hi !== null && (range.upperInclusive ? v > hi : v >= hi)) return false
  return true
}

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
 * A single legal move in an Attr.state machine.
 * `from: '*'` means the event is legal from every state.
 * `if` is a pure guard over the record — return false to block the event.
 * `message` customises the error shown when the guard (or state) blocks a save.
 */
export interface StateTransition<S extends string = string> {
  from: readonly S[] | '*'
  to: S
  if?: (record: any) => boolean
  message?: string
}

/**
 * Extended config for Attr.state — an enum plus a transition graph.
 * The Proxy synthesises is<Label>(), can<Event>() and <event>() methods,
 * and ApplicationRecord.validate() enforces transition legality on save.
 */
export type AttrStateConfig = AttrConfig & {
  readonly _isAttr: true
  readonly _type: 'state'
  readonly values: Record<string, number | string>
  readonly initial?: string
  readonly transitions: Record<string, StateTransition>
}

/** Labels of a states declaration — array form or hash form. */
type StateLabel<S> = S extends readonly string[] ? S[number] : keyof S & string

/**
 * Instance members that a transition event may never shadow.
 * Attr.state() throws at definition time on collision — fail-closed, so a
 * transition named `save` can't silently become unreachable behind the
 * prototype method of the same name.
 */
const RESERVED_EVENT_NAMES = new Set([
  'save', 'update', 'destroy', 'delete', 'validate', 'isValid', 'isInvalid',
  'reload', 'toJSON', 'inspect', 'errors', 'attributes', 'changes',
  'previousChanges', 'restoreAttributes', 'isChanged', 'changedFields',
  'can', 'advance', 'attach', 'detach', 'replace', 'reorder',
  'isNewRecord', 'constructor', 'then',
])

/**
 * Can `event` fire from `fromLabel` on `record` right now?
 * Returns a reason string when blocked (used for save-time error messages).
 */
export function stateCanFire(
  config: AttrStateConfig,
  fromLabel: string | null | undefined,
  event: string,
  record: any,
): { ok: true } | { ok: false; reason: string } {
  const t = config.transitions[event]
  if (!t) return { ok: false, reason: `unknown event '${event}'` }
  if (fromLabel !== null && fromLabel !== undefined && t.from !== '*' && !t.from.includes(fromLabel)) {
    return { ok: false, reason: t.message ?? `cannot ${event} from '${fromLabel}'` }
  }
  if (t.if && !t.if(record)) {
    return { ok: false, reason: t.message ?? `${event} is not allowed right now` }
  }
  return { ok: true }
}

/**
 * Is the move `fromLabel → toLabel` legal via ANY event on `record`?
 * Used by save-time validation to police direct assignment
 * (`record.status = 'approved'` without calling an event method).
 */
export function stateLegalMove(
  config: AttrStateConfig,
  fromLabel: string | null | undefined,
  toLabel: string,
  record: any,
): { ok: true } | { ok: false; reason: string } {
  // Records that predate the machine (null state) may enter it anywhere.
  if (fromLabel === null || fromLabel === undefined) return { ok: true }
  if (fromLabel === toLabel) return { ok: true }
  let blockedReason: string | null = null
  for (const [event, t] of Object.entries(config.transitions)) {
    if (t.to !== toLabel) continue
    const res = stateCanFire(config, fromLabel, event, record)
    if (res.ok) return { ok: true }
    blockedReason = res.reason
  }
  return {
    ok: false,
    reason: blockedReason ?? `cannot transition from '${fromLabel}' to '${toLabel}'`,
  }
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
   * State machine attr — an enum with a transition graph.
   *
   * States map labels to stored values (integer hash like Attr.enum, or an
   * array of strings for text columns). Transitions name the legal moves;
   * guards (`if`) are pure predicates over the record.
   *
   *   static status = Attr.state({
   *     states: { draft: 0, submitted: 1, approved: 2, rejected: 3 } as const,
   *     initial: 'draft',
   *     transitions: {
   *       submit:  { from: ['draft'],     to: 'submitted' },
   *       approve: { from: ['submitted'], to: 'approved', if: r => r.amount != null },
   *       reject:  { from: ['submitted'], to: 'rejected' },
   *       reopen:  { from: '*',           to: 'draft' },
   *     },
   *   })
   *
   * What the record gains (all synthesized — nothing to write):
   *
   *   loan.status               // → 'draft' (label, like Attr.enum)
   *   loan.isDraft()            // → true
   *   loan.can('submit')        // → boolean (state ∈ from AND guard passes)
   *   loan.canSubmit()          // → same, per-event sugar
   *   loan.submit()             // assigns 'submitted' if legal → true, else false (no save)
   *   await loan.advance('submit')  // submit() + save() in one call → boolean
   *
   * Direct assignment stays legal (`loan.status = 'approved'`) — the Attr
   * contract is assign-anything-validate-on-save. validate() rejects moves
   * with no legal transition path, so an illegal jump can never persist.
   *
   * `initial` doubles as the column default on INSERT. New records skip
   * transition validation (creation may start in any state, e.g. imports).
   */
  state<
    const S extends Record<string, number | string> | readonly string[],
    const T extends Record<string, StateTransition<StateLabel<S>>>,
  >(
    config: {
      states: S
      initial?: StateLabel<S>
      transitions: T
    } & Partial<Omit<AttrConfig, '_isAttr'>>
  ): AttrStateConfig {
    const { states, initial, transitions, ...rest } = config

    // Normalize: array form → identity mapping (label stored as itself)
    const values: Record<string, number | string> = Array.isArray(states)
      ? Object.fromEntries((states as readonly string[]).map(s => [s, s]))
      : { ...(states as Record<string, number | string>) }

    const labels = new Set(Object.keys(values))

    // ── Definition-time validation — fail loudly at class-load, not at runtime
    if (labels.size === 0) {
      throw new Error(`Attr.state: 'states' must declare at least one state`)
    }
    if (initial !== undefined && !labels.has(initial)) {
      throw new Error(`Attr.state: initial '${initial}' is not a declared state`)
    }
    for (const [event, t] of Object.entries(transitions as Record<string, StateTransition>)) {
      if (RESERVED_EVENT_NAMES.has(event)) {
        throw new Error(`Attr.state: event '${event}' collides with a built-in record member — rename the transition`)
      }
      if (!labels.has(t.to)) {
        throw new Error(`Attr.state: transition '${event}' targets unknown state '${t.to}'`)
      }
      if (t.from !== '*') {
        for (const f of t.from) {
          if (!labels.has(f)) {
            throw new Error(`Attr.state: transition '${event}' allows unknown state '${f}' in 'from'`)
          }
        }
      }
    }

    const inverse: Record<string | number, string> = {}
    for (const [k, v] of Object.entries(values)) inverse[v] = k

    return {
      _isAttr: true as const,
      _type: 'state' as const,
      values,
      ...(initial !== undefined ? { initial, default: initial } : {}),
      transitions: transitions as Record<string, StateTransition>,
      get: (raw: number | string | null | undefined) =>
        raw === null || raw === undefined ? null : (inverse[raw] ?? raw),
      set: (val: string | number | null | undefined) => {
        if (val === null || val === undefined) return null
        const stored = values[val as string]
        return stored !== undefined ? stored : val
      },
      ...rest,
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
  for(column: string, config: Pick<AttrConfig, 'get' | 'set' | 'default' | 'validate' | 'validates' | 'serverValidate' | 'serverValidates'>): AttrConfig & { _column: string } {
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
   * Strict integer attr — REJECTS non-integers instead of silently coercing.
   *
   * Unlike Attr.integer (lenient Number() coercion), Attr.int guarantees the
   * stored value passed Number.isSafeInteger. Assigning 3.5 or 'abc' throws
   * immediately at the assignment site, so a float can never reach an
   * integer column.
   *
   *   static quantity = Attr.int()
   *   order.quantity = 3      // ✓
   *   order.quantity = 3.5    // ✗ throws TypeError
   *   order.quantity = '12'   // ✓ numeric strings accepted → 12
   */
  int(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig {
    return {
      _isAttr: true,
      get: (raw) => (raw === null || raw === undefined ? null : Number(raw)),
      set: (val) => {
        if (val === null || val === undefined) return null
        const n = typeof val === 'string' ? Number(val) : val
        if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
          throw new TypeError(`Attr.int: ${JSON.stringify(val)} is not a safe integer`)
        }
        return n
      },
      ...config,
    }
  },

  /**
   * Money attr — integer cents in the database, decimal dollars on the model.
   *
   * The column stores integer minor units (the classic no-float-drift rule).
   * Reads give you major units as a number; writes accept major units and
   * round to the nearest cent. Assigning a non-finite value throws.
   *
   *   // schema: priceCents: integer('price_cents')
   *   static price = Attr.money('priceCents')
   *   product.price = 19.99      // stored as 1999
   *   product.price              // → 19.99
   *   product.priceCents         // → 1999 (raw column still accessible)
   *
   * With a currency column, the record gains an automatic `<prop>Formatted()`
   * helper that reads the row's own currency:
   *
   *   // schema: priceCents: integer(), currency: varchar()
   *   static price = Attr.money('priceCents', { currency: 'currency' })
   *   product.currency = 'EUR'
   *   product.priceFormatted()          // → '19,99 €' (uses row currency)
   *   product.priceFormatted('en-US')   // → '€19.99'
   *
   * Without a column argument it transforms in place (for a column that
   * already holds cents under the same name).
   */
  money(
    column?: string,
    config: Partial<Omit<AttrConfig, '_isAttr'>> & { currency?: string } = {}
  ): AttrConfig & { _column?: string; _type: 'money'; _currencyColumn?: string } {
    const { currency: currencyColumn, ...rest } = config
    return {
      _isAttr: true,
      _type: 'money' as const,
      ...(column ? { _column: column } : {}),
      ...(currencyColumn ? { _currencyColumn: currencyColumn } : {}),
      get: (raw): number | null => {
        if (raw === null || raw === undefined) return null
        return Number(raw) / 100
      },
      set: (val): number | null => {
        if (val === null || val === undefined) return null
        const n = typeof val === 'string' ? Number(val) : val
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          throw new TypeError(`Attr.money: ${JSON.stringify(val)} is not a finite number`)
        }
        // Epsilon-nudge: 1.005 * 100 is 100.4999... in binary floats
        const sign = n < 0 ? -1 : 1
        const c = sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)
        if (!Number.isSafeInteger(c)) {
          throw new TypeError(`Attr.money: ${n} exceeds safe integer cents`)
        }
        return c
      },
      ...rest,
    }
  },

  /**
   * Percent attr — the DB stores a FRACTION (float 0–1, the mathematically
   * honest representation), the model speaks PERCENT (0–100, the human one).
   *
   *   // schema: conversionRate: doublePrecision('conversion_rate')
   *   static conversionRate = Attr.percent()
   *   funnel.conversionRate = 15.3   // stored as 0.153
   *   funnel.conversionRate          // → 15.3
   *
   * So SQL aggregation stays fraction-math (`avg(conversion_rate)`) while
   * every read/write at the model layer is already in display units.
   */
  percent(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'percent' } {
    return {
      _isAttr: true,
      _type: 'percent' as const,
      get: (raw): number | null => {
        if (raw === null || raw === undefined) return null
        return Number(raw) * 100
      },
      set: (val): number | null => {
        if (val === null || val === undefined) return null
        const n = typeof val === 'string' ? Number(val) : val
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          throw new TypeError(`Attr.percent: ${JSON.stringify(val)} is not a finite number`)
        }
        return n / 100
      },
      ...config,
    }
  },

  /**
   * Basis-points attr — integer bps in the database (no float drift), the
   * same integer on the model. A kind marker for presenters ('250 bps'),
   * with strict-integer coercion.
   *
   *   static spread = Attr.bps()
   *   loan.spread = 250        // stored as 250
   */
  bps(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'bps' } {
    return {
      _isAttr: true,
      _type: 'bps' as const,
      get: (raw) => (raw === null || raw === undefined ? null : Number(raw)),
      set: (val) => {
        if (val === null || val === undefined) return null
        const n = typeof val === 'string' ? Number(val) : val
        if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
          throw new TypeError(`Attr.bps: ${JSON.stringify(val)} is not a safe integer`)
        }
        return n
      },
      ...config,
    }
  },

  /**
   * Multiple attr — a ratio like '2.5x'. Stored as a string-backed numeric
   * (full precision), read as a number. Kind marker for presenters.
   *
   *   static leverage = Attr.multiple()
   *   deal.leverage = 2.5
   */
  multiple(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'multiple' } {
    return {
      _isAttr: true,
      _type: 'multiple' as const,
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

  /**
   * Days attr — an integer count of days. Kind marker for presenters
   * ('90 days'), strict-integer coercion.
   *
   *   static termDays = Attr.days()
   */
  days(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'days' } {
    return {
      _isAttr: true,
      _type: 'days' as const,
      get: (raw) => (raw === null || raw === undefined ? null : Number(raw)),
      set: (val) => {
        if (val === null || val === undefined) return null
        const n = typeof val === 'string' ? Number(val) : val
        if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
          throw new TypeError(`Attr.days: ${JSON.stringify(val)} is not a safe integer`)
        }
        return n
      },
      ...config,
    }
  },

  /**
   * Postgres range attr (`int4range`, `int8range`, `numrange`).
   * The driver returns range columns as literals like '[1,10)'; this parses
   * them into a structured object and serializes on write.
   *
   *   // schema: seats: customType numrange
   *   static seats = Attr.range()
   *   venue.seats               // → { lower: 1, upper: 10, lowerInclusive: true, upperInclusive: false }
   *   venue.seats = { lower: 5, upper: 20, lowerInclusive: true, upperInclusive: false }
   */
  range(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'range' } {
    return {
      _isAttr: true,
      _type: 'range' as const,
      get: (raw): PgRange | null => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'object') return raw as PgRange // already parsed
        return parsePgRange(String(raw), Number)
      },
      set: (val): string | null => {
        if (val === null || val === undefined) return null
        if (typeof val === 'string') return val // raw literal passthrough
        return serializePgRange(val as PgRange, String)
      },
      ...config,
    }
  },

  /**
   * Postgres timestamp range attr (`tstzrange`). Bounds are JS Dates.
   *
   *   static bookedDuring = Attr.dateRange()
   *   booking.bookedDuring   // → { lower: Date, upper: Date, ... }
   */
  dateRange(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'range' } {
    return {
      _isAttr: true,
      _type: 'range' as const,
      get: (raw): PgRange<Date> | null => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'object') return raw as PgRange<Date>
        return parsePgRange(String(raw), (s) => new Date(s))
      },
      set: (val): string | null => {
        if (val === null || val === undefined) return null
        if (typeof val === 'string') return val
        return serializePgRange(val as PgRange<Date>, (d) => `"${d.toISOString()}"`)
      },
      ...config,
    }
  },

  /**
   * Percent range — a Postgres `numrange` of FRACTIONS (0–1) exposed as a
   * range of PERCENTS (0–100) on the model. The "% range" type:
   *
   *   // schema: targetRate: customType numrange
   *   static targetRate = Attr.percentRange()
   *   campaign.targetRate = { lower: 2.5, upper: 10, lowerInclusive: true, upperInclusive: false }
   *   // stored as '[0.025,0.1)' — fraction math in SQL, percent at the model
   *   campaign.targetRate.upper   // → 10
   */
  percentRange(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'range' } {
    return {
      _isAttr: true,
      _type: 'range' as const,
      get: (raw): PgRange | null => {
        if (raw === null || raw === undefined) return null
        const r = typeof raw === 'object' ? (raw as PgRange) : parsePgRange(String(raw), Number)
        return {
          ...r,
          lower: r.lower === null ? null : r.lower * 100,
          upper: r.upper === null ? null : r.upper * 100,
        }
      },
      set: (val): string | null => {
        if (val === null || val === undefined) return null
        if (typeof val === 'string') return val
        const r = val as PgRange
        const scaled: PgRange = {
          ...r,
          lower: r.lower === null ? null : r.lower / 100,
          upper: r.upper === null ? null : r.upper / 100,
        }
        return serializePgRange(scaled, String)
      },
      ...config,
    }
  },

  /**
   * Postgres multirange attr (`nummultirange`, `int4multirange` — PG 14+).
   * Literal '{[1,3),[5,8)}' ↔ PgRange[].
   *
   *   static availability = Attr.multirange()
   *   room.availability   // → [{ lower: 1, upper: 3, ... }, { lower: 5, upper: 8, ... }]
   */
  multirange(config: Partial<Omit<AttrConfig, '_isAttr'>> = {}): AttrConfig & { _type: 'multirange' } {
    return {
      _isAttr: true,
      _type: 'multirange' as const,
      get: (raw): PgRange[] | null => {
        if (raw === null || raw === undefined) return null
        if (Array.isArray(raw)) return raw as PgRange[]
        const s = String(raw).trim()
        if (!s.startsWith('{') || !s.endsWith('}')) {
          throw new Error(`Invalid Postgres multirange literal: ${JSON.stringify(raw)}`)
        }
        const inner = s.slice(1, -1).trim()
        if (inner === '') return []
        // Split on commas BETWEEN ranges (after a closing bracket)
        return inner
          .split(/(?<=[\])]),/)
          .map((part) => parsePgRange(part.trim(), Number))
      },
      set: (val): string | null => {
        if (val === null || val === undefined) return null
        if (typeof val === 'string') return val
        const ranges = val as PgRange[]
        return `{${ranges.map((r) => serializePgRange(r, String)).join(',')}}`
      },
      ...config,
    }
  },

  /**
   * Postgres array attr (`text[]`, `integer[]`, ...). node-postgres already
   * parses most array columns to JS arrays — this attr normalizes both
   * directions and optionally transforms each element.
   *
   *   static tags = Attr.array()                       // string[] passthrough
   *   static scores = Attr.array({ element: Number }) // '{"1","2"}' → [1, 2]
   */
  array(
    config: Partial<Omit<AttrConfig, '_isAttr'>> & { element?: (v: any) => any } = {}
  ): AttrConfig & { _type: 'array' } {
    const { element, ...rest } = config
    return {
      _isAttr: true,
      _type: 'array' as const,
      get: (raw): unknown[] | null => {
        if (raw === null || raw === undefined) return null
        let arr: unknown[]
        if (Array.isArray(raw)) {
          arr = raw
        } else {
          // Fallback literal parse: '{a,b,"c d"}'
          const s = String(raw).trim()
          if (!s.startsWith('{') || !s.endsWith('}')) {
            throw new Error(`Invalid Postgres array literal: ${JSON.stringify(raw)}`)
          }
          const inner = s.slice(1, -1)
          arr = inner === '' ? [] : inner
            .match(/("([^"\\]|\\.)*"|[^,]+)/g)!
            .map((p) => p.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1'))
        }
        return element ? arr.map(element) : arr
      },
      set: (val): unknown[] | null => {
        if (val === null || val === undefined) return null
        if (!Array.isArray(val)) {
          throw new TypeError(`Attr.array: expected an array, got ${JSON.stringify(val)}`)
        }
        return val // drizzle/node-postgres serialize JS arrays natively
      },
      ...rest,
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
