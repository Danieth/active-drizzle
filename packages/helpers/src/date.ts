/**
 * ActiveSupport-style Date/Time extensions.
 *
 * All functions are immutable — they return new Date instances and never
 * mutate their argument. Calculations use local time (like Rails' Time.zone
 * defaults to the app zone; here the JS runtime's zone).
 */

const DAY_MS = 86_400_000

// ── Boundaries ───────────────────────────────────────────────────────────────

export function beginningOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

export function endOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(23, 59, 59, 999)
  return out
}

export function beginningOfHour(d: Date): Date {
  const out = new Date(d)
  out.setMinutes(0, 0, 0)
  return out
}

export function endOfHour(d: Date): Date {
  const out = new Date(d)
  out.setMinutes(59, 59, 999)
  return out
}

export function beginningOfMinute(d: Date): Date {
  const out = new Date(d)
  out.setSeconds(0, 0)
  return out
}

export function endOfMinute(d: Date): Date {
  const out = new Date(d)
  out.setSeconds(59, 999)
  return out
}

/** Monday-start week, like Rails' default `beginning_of_week`. */
export function beginningOfWeek(d: Date, weekStart: 'monday' | 'sunday' = 'monday'): Date {
  const out = beginningOfDay(d)
  const day = out.getDay() // 0 = Sunday
  const offset = weekStart === 'monday' ? (day === 0 ? 6 : day - 1) : day
  out.setDate(out.getDate() - offset)
  return out
}

export function endOfWeek(d: Date, weekStart: 'monday' | 'sunday' = 'monday'): Date {
  const start = beginningOfWeek(d, weekStart)
  start.setDate(start.getDate() + 6)
  return endOfDay(start)
}

export function beginningOfMonth(d: Date): Date {
  const out = beginningOfDay(d)
  out.setDate(1)
  return out
}

export function endOfMonth(d: Date): Date {
  const out = beginningOfDay(d)
  out.setMonth(out.getMonth() + 1, 0) // day 0 of next month = last day of this month
  return endOfDay(out)
}

export function beginningOfQuarter(d: Date): Date {
  const out = beginningOfMonth(d)
  out.setMonth(Math.floor(out.getMonth() / 3) * 3)
  return out
}

export function endOfQuarter(d: Date): Date {
  const start = beginningOfQuarter(d)
  start.setMonth(start.getMonth() + 3, 0)
  return endOfDay(start)
}

export function beginningOfYear(d: Date): Date {
  const out = beginningOfDay(d)
  out.setMonth(0, 1)
  return out
}

export function endOfYear(d: Date): Date {
  const out = beginningOfDay(d)
  out.setMonth(11, 31)
  return endOfDay(out)
}

// ── Arithmetic (calendar-aware) ──────────────────────────────────────────────

export function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

export function addWeeks(d: Date, n: number): Date {
  return addDays(d, n * 7)
}

/** Calendar-aware, with Rails end-of-month clamping: Jan 31 + 1 month → Feb 28/29. */
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d)
  const day = out.getDate()
  out.setDate(1)
  out.setMonth(out.getMonth() + n)
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()
  out.setDate(Math.min(day, lastDay))
  return out
}

export function addYears(d: Date, n: number): Date {
  return addMonths(d, n * 12)
}

export function addHours(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 3_600_000)
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000)
}

export function addSeconds(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 1000)
}

// ── Relative days ────────────────────────────────────────────────────────────

export function tomorrow(from: Date = new Date()): Date { return addDays(from, 1) }
export function yesterday(from: Date = new Date()): Date { return addDays(from, -1) }

/** Rails' `next_occurring(:monday)` — the next date with the given weekday. */
export function nextOccurring(d: Date, weekday: Weekday): Date {
  const target = WEEKDAYS.indexOf(weekday)
  const out = beginningOfDay(d)
  do { out.setDate(out.getDate() + 1) } while (out.getDay() !== target)
  return out
}

export function prevOccurring(d: Date, weekday: Weekday): Date {
  const target = WEEKDAYS.indexOf(weekday)
  const out = beginningOfDay(d)
  do { out.setDate(out.getDate() - 1) } while (out.getDay() !== target)
  return out
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export type Weekday = (typeof WEEKDAYS)[number]

// ── Predicates ───────────────────────────────────────────────────────────────

export function isToday(d: Date, now: Date = new Date()): boolean {
  return beginningOfDay(d).getTime() === beginningOfDay(now).getTime()
}

export function isTomorrow(d: Date, now: Date = new Date()): boolean {
  return beginningOfDay(d).getTime() === beginningOfDay(addDays(now, 1)).getTime()
}

export function isYesterday(d: Date, now: Date = new Date()): boolean {
  return beginningOfDay(d).getTime() === beginningOfDay(addDays(now, -1)).getTime()
}

export function isPast(d: Date, now: Date = new Date()): boolean {
  return d.getTime() < now.getTime()
}

export function isFuture(d: Date, now: Date = new Date()): boolean {
  return d.getTime() > now.getTime()
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

export function isWeekday(d: Date): boolean {
  return !isWeekend(d)
}

/** Same calendar day (ignores time). Rails' `same_day?` equivalent. */
export function isSameDay(a: Date, b: Date): boolean {
  return beginningOfDay(a).getTime() === beginningOfDay(b).getTime()
}

// ── Differences ──────────────────────────────────────────────────────────────

/** Whole calendar days between two dates (b - a). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((beginningOfDay(b).getTime() - beginningOfDay(a).getTime()) / DAY_MS)
}

/**
 * Rails' `distance_of_time_in_words` / `time_ago_in_words` (simplified).
 * timeAgoInWords(date) → 'about 2 hours', '3 days', 'less than a minute'
 */
export function timeAgoInWords(d: Date, now: Date = new Date()): string {
  return distanceOfTimeInWords(d, now)
}

export function distanceOfTimeInWords(from: Date, to: Date): string {
  const distanceSec = Math.abs(to.getTime() - from.getTime()) / 1000
  const distanceMin = Math.round(distanceSec / 60)

  if (distanceMin === 0) return 'less than a minute'
  if (distanceMin === 1) return 'a minute'
  if (distanceMin < 45) return `${distanceMin} minutes`
  if (distanceMin < 90) return 'about 1 hour'
  if (distanceMin < 1440) return `about ${Math.round(distanceMin / 60)} hours`
  if (distanceMin < 2520) return '1 day'
  if (distanceMin < 43_200) return `${Math.round(distanceMin / 1440)} days`
  if (distanceMin < 86_400) return 'about 1 month'
  if (distanceMin < 525_600) return `${Math.round(distanceMin / 43_200)} months`
  const years = Math.round(distanceMin / 525_600)
  return years === 1 ? 'about 1 year' : `about ${years} years`
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Rails' `to_formatted_s` presets (subset, most-used ones).
 *   toFormattedString(d, 'short')    → '18 Jul 00:30'
 *   toFormattedString(d, 'long')     → 'July 18, 2026 00:30'
 *   toFormattedString(d, 'db')       → '2026-07-18 00:30:15'
 *   toFormattedString(d, 'iso8601')  → '2026-07-18T00:30:15.000Z'
 */
export function toFormattedString(
  d: Date,
  format: 'short' | 'long' | 'db' | 'iso8601' | 'number' = 'db'
): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December']

  switch (format) {
    case 'iso8601':
      return d.toISOString()
    case 'db':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    case 'number':
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    case 'short':
      return `${pad(d.getDate())} ${months[d.getMonth()]!.slice(0, 3)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    case 'long':
      return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}
