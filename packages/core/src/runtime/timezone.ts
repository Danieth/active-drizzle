/**
 * IANA timezone support, backed entirely by the platform's Intl data —
 * no bundled tzdb, no dependency, never stale (the runtime's ICU updates it).
 *
 * This is the integration point between `Attr.timezone()` (a user's stored
 * zone preference) and the JS `Date` world that `Attr.date()` speaks:
 *
 *   user.timezone = 'america/new_york'        // canonicalized on write
 *   user.timezone                             // → 'America/New_York'
 *   formatInTimeZone(order.createdAt, user.timezone)
 *   // → 'Jul 18, 2026, 9:14 AM'
 */

/** Memoized full IANA list from the runtime's ICU data (~400+ zones, sorted). */
let _all: readonly string[] | null = null
export function allTimezones(): readonly string[] {
  if (_all === null) {
    const zones = typeof Intl.supportedValuesOf === 'function'
      ? [...Intl.supportedValuesOf('timeZone')]
      : []
    // Some ICU builds list only 'Etc/UTC' — but 'UTC' is the id people
    // store and pickers must offer. Guarantee it.
    if (!zones.includes('UTC')) zones.push('UTC')
    _all = zones.sort()
  }
  return _all
}

/**
 * Canonicalization cache — Intl.DateTimeFormat construction costs ~a
 * millisecond, and the same handful of zones repeat forever.
 */
const _canonical = new Map<string, string | null>()

/**
 * Resolves any accepted timezone spelling to its canonical IANA id:
 * 'america/new_york' → 'America/New_York', 'UTC' → 'UTC', legacy aliases
 * ('US/Eastern') resolve to their modern names on current ICU. Unknown or
 * non-string input → null.
 */
export function canonicalTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string') return null
  const t = tz.trim()
  if (t === '') return null
  if (_canonical.has(t)) return _canonical.get(t)!
  let resolved: string | null
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: t }).resolvedOptions().timeZone
  } catch {
    resolved = null
  }
  _canonical.set(t, resolved)
  return resolved
}

/** Is this a usable timezone identifier (canonical, alias, or offset)? */
export function isValidTimezone(tz: unknown): boolean {
  return canonicalTimezone(tz) !== null
}

/**
 * Formats an instant as wall-clock time in a zone. This is the "actually
 * USE the stored timezone on the backend" one-liner:
 *
 *   formatInTimeZone(invoice.sentAt, user.timezone)
 *   // → 'Jul 18, 2026, 9:14 AM'
 *   formatInTimeZone(invoice.sentAt, user.timezone, { dateStyle: 'full' })
 *   formatInTimeZone(invoice.sentAt, 'Asia/Tokyo', { locale: 'ja-JP' })
 *
 * Returns null for invalid dates or zones — never throws on user data.
 */
export function formatInTimeZone(
  date: Date | number | string,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions & { locale?: string } = {},
): string | null {
  const d = date instanceof Date ? date : new Date(date)
  if (isNaN(d.getTime())) return null
  const { locale = 'en-US', ...rest } = opts
  const options: Intl.DateTimeFormatOptions =
    Object.keys(rest).length > 0 ? rest : { dateStyle: 'medium', timeStyle: 'short' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(d)
  } catch {
    return null
  }
}

/**
 * The zone's UTC offset in minutes at a given instant (DST-aware):
 * New York in July → -240, in January → -300, Kolkata → 330, UTC → 0.
 * Null for unknown zones.
 */
export function timeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at)
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    if (name === 'GMT') return 0
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name)
    if (!m) return null
    const sign = m[1] === '-' ? -1 : 1
    return sign * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    return null
  }
}
