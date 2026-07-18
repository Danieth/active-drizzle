import { Temporal as TemporalPolyfill } from 'temporal-polyfill'

/**
 * Zone-aware time — Rails' `Time.zone` for TypeScript, built on Temporal
 * (the ECMAScript standard). Uses the native `Temporal` global when the
 * runtime has it (Node 26+, Chrome 144+, Firefox 139+), the polyfill
 * otherwise. Identical behavior either way.
 *
 * The mental model (this is the whole thing):
 *
 *   1. The database stores INSTANTS (Postgres `timestamptz`) — points on the
 *      physical timeline, no zone. JS `Date` is also an instant. Never worry
 *      about "what zone is the DB in" — instants don't have one.
 *   2. Humans see ZONED time. Convert at the edge with `zoned()`, do your
 *      display math there.
 *   3. Calendar dates with no time-of-day (birthdays, due dates — Postgres
 *      `date`) are PLAIN DATES. Never store them as instants; that's how
 *      "off by one day" bugs happen. Use `plainDate()`.
 *
 * Ultra-simple API:
 *
 *   setDefaultTimeZone('America/New_York')   // once, at boot (like Time.zone=)
 *
 *   zonedNow()                       // current time in the app zone
 *   zoned(user.createdAt)            // Date → ZonedDateTime in app zone
 *   zoned(user.createdAt, 'Asia/Tokyo')  // ...or any IANA zone
 *   toDate(zdt)                      // back to a JS Date for the DB / APIs
 *
 *   plainDate('2026-03-03')          // calendar date, no zone, no time
 *   plainDateToday()                 // today in the app zone
 */

// Native Temporal when available, polyfill otherwise
export const Temporal: typeof TemporalPolyfill =
  ((globalThis as any).Temporal as typeof TemporalPolyfill) ?? TemporalPolyfill

export type ZonedDateTime = TemporalPolyfill.ZonedDateTime
export type PlainDate = TemporalPolyfill.PlainDate
export type Instant = TemporalPolyfill.Instant
export type Duration = TemporalPolyfill.Duration

// ── App time zone (Rails' Time.zone) ─────────────────────────────────────────

let _defaultTimeZone: string | null = null

/** Set once at boot: `setDefaultTimeZone('America/New_York')`. */
export function setDefaultTimeZone(tz: string): void {
  // Validate eagerly — throws on unknown zones
  Temporal.Now.zonedDateTimeISO(tz)
  _defaultTimeZone = tz
}

/** The configured app zone, falling back to the runtime's zone. */
export function getDefaultTimeZone(): string {
  return _defaultTimeZone ?? Temporal.Now.timeZoneId()
}

// ── Zoned time ───────────────────────────────────────────────────────────────

/** Current time in the app zone (or the given zone). */
export function zonedNow(tz?: string): ZonedDateTime {
  return Temporal.Now.zonedDateTimeISO(tz ?? getDefaultTimeZone())
}

/**
 * Convert anything time-like to a ZonedDateTime in the app zone (or given zone).
 * Accepts: JS Date, epoch millis, ISO string (with or without offset),
 * Temporal.Instant, or another ZonedDateTime.
 */
export function zoned(value: Date | number | string | Instant | ZonedDateTime, tz?: string): ZonedDateTime {
  const zone = tz ?? getDefaultTimeZone()

  if (value instanceof Date) {
    return Temporal.Instant.fromEpochMilliseconds(value.getTime()).toZonedDateTimeISO(zone)
  }
  if (typeof value === 'number') {
    return Temporal.Instant.fromEpochMilliseconds(value).toZonedDateTimeISO(zone)
  }
  if (typeof value === 'string') {
    return Temporal.Instant.from(value).toZonedDateTimeISO(zone)
  }
  if (value instanceof Temporal.Instant || (value as any)?.epochMilliseconds !== undefined && !(value as any)?.timeZoneId) {
    return (value as Instant).toZonedDateTimeISO(zone)
  }
  return (value as ZonedDateTime).withTimeZone(zone)
}

/** ZonedDateTime (or Instant) → plain JS Date, for the DB driver or JSON. */
export function toDate(value: ZonedDateTime | Instant): Date {
  return new Date(value.epochMilliseconds)
}

// ── Plain dates (Postgres `date` columns) ────────────────────────────────────

/**
 * A calendar date with no time and no zone.
 * Accepts 'YYYY-MM-DD' strings (what Postgres `date` gives you) or a
 * ZonedDateTime (takes its calendar date).
 */
export function plainDate(value: string | PlainDate | ZonedDateTime): PlainDate {
  if (typeof value === 'string') return Temporal.PlainDate.from(value)
  if ((value as ZonedDateTime).timeZoneId !== undefined) return (value as ZonedDateTime).toPlainDate()
  return value as PlainDate
}

/** Today's calendar date in the app zone. */
export function plainDateToday(tz?: string): PlainDate {
  return zonedNow(tz).toPlainDate()
}

// ── Durations ────────────────────────────────────────────────────────────────

/**
 * `duration({ days: 3 })` or `duration(3, 'days')` → Temporal.Duration.
 * Real calendar-aware durations (unlike millisecond math, `zdt.add(duration({ months: 1 }))`
 * handles DST and month lengths correctly).
 */
export function duration(like: Partial<Record<DurationUnit, number>>): Duration
export function duration(amount: number, unit: DurationUnit): Duration
export function duration(
  a: Partial<Record<DurationUnit, number>> | number,
  unit?: DurationUnit
): Duration {
  if (typeof a === 'number') return Temporal.Duration.from({ [unit!]: a })
  return Temporal.Duration.from(a)
}

export type DurationUnit =
  | 'years' | 'months' | 'weeks' | 'days'
  | 'hours' | 'minutes' | 'seconds' | 'milliseconds'

// ── Postgres bridge ──────────────────────────────────────────────────────────

/**
 * The complete Postgres mapping — this is all you ever need to know:
 *
 *   timestamptz column  → driver gives you a JS Date → `zoned(date)` to display
 *   writing timestamptz → store a JS Date (or `toDate(zdt)`) — always correct
 *   date column         → driver gives 'YYYY-MM-DD' or Date → `pgDate(...)` 
 *   writing date        → `pgDateString(plainDate)` → 'YYYY-MM-DD'
 */

/** Parse a Postgres `date` column value (string or Date) as a PlainDate. */
export function pgDate(value: string | Date): PlainDate {
  if (value instanceof Date) {
    // node-postgres parses `date` columns as Date at local midnight — take the
    // calendar components directly to avoid off-by-one-day zone bugs.
    return Temporal.PlainDate.from({
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
    })
  }
  return Temporal.PlainDate.from(value)
}

/** Serialize a PlainDate for a Postgres `date` column: 'YYYY-MM-DD'. */
export function pgDateString(date: PlainDate): string {
  return date.toString()
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Locale-aware formatting via Intl (no format-string micro-language needed):
 *
 *   formatZoned(zdt)                          // 'Jul 18, 2026, 2:30 PM'
 *   formatZoned(zdt, { dateStyle: 'full' })   // 'Saturday, July 18, 2026'
 *   formatZoned(zdt, { timeStyle: 'short' })  // '2:30 PM'
 */
export function formatZoned(
  zdt: ZonedDateTime,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale = 'en-US'
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: zdt.timeZoneId })
    .format(new Date(zdt.epochMilliseconds))
}
