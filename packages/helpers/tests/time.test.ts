import { describe, it, expect, afterEach } from 'vitest'
import {
  Temporal, setDefaultTimeZone, getDefaultTimeZone,
  zonedNow, zoned, toDate, plainDate, plainDateToday,
  duration, pgDate, pgDateString, formatZoned,
} from '../src/time.js'

// Reset app zone between tests
afterEach(() => setDefaultTimeZone(Temporal.Now.timeZoneId()))

describe('default time zone', () => {
  it('falls back to runtime zone, then honors setDefaultTimeZone', () => {
    expect(getDefaultTimeZone()).toBe(Temporal.Now.timeZoneId())
    setDefaultTimeZone('America/New_York')
    expect(getDefaultTimeZone()).toBe('America/New_York')
  })

  it('rejects unknown zones eagerly', () => {
    expect(() => setDefaultTimeZone('Mars/Olympus_Mons')).toThrow()
  })
})

describe('zoned()', () => {
  const epoch = 1_784_500_000_000 // fixed instant

  it('converts a JS Date into the app zone', () => {
    setDefaultTimeZone('America/New_York')
    const z = zoned(new Date(epoch))
    expect(z.timeZoneId).toBe('America/New_York')
    expect(z.epochMilliseconds).toBe(epoch)
  })

  it('same instant, different wall-clock across zones', () => {
    const d = new Date(epoch)
    const ny = zoned(d, 'America/New_York')
    const tokyo = zoned(d, 'Asia/Tokyo')
    expect(ny.epochMilliseconds).toBe(tokyo.epochMilliseconds) // same instant
    expect(ny.hour).not.toBe(tokyo.hour) // different clock face
    expect((tokyo.hour - ny.hour + 24) % 24).toBe(13) // NY is EDT (UTC-4), Tokyo UTC+9
  })

  it('accepts epoch millis, ISO strings, Instants, and ZonedDateTimes', () => {
    setDefaultTimeZone('UTC')
    expect(zoned(epoch).epochMilliseconds).toBe(epoch)
    expect(zoned(new Date(epoch).toISOString()).epochMilliseconds).toBe(epoch)
    expect(zoned(Temporal.Instant.fromEpochMilliseconds(epoch)).epochMilliseconds).toBe(epoch)
    const rezoned = zoned(zoned(epoch, 'Asia/Tokyo'), 'UTC')
    expect(rezoned.timeZoneId).toBe('UTC')
    expect(rezoned.epochMilliseconds).toBe(epoch)
  })

  it('round-trips through toDate()', () => {
    const z = zoned(new Date(epoch), 'Europe/Berlin')
    expect(toDate(z).getTime()).toBe(epoch)
  })
})

describe('DST correctness (the reason Temporal exists)', () => {
  it('adding one day across spring-forward keeps the wall-clock hour', () => {
    // US DST began 2026-03-08 02:00 in America/New_York
    const before = zoned('2026-03-07T17:00:00Z', 'America/New_York') // noon EST
    expect(before.hour).toBe(12)
    const after = before.add(duration(1, 'days'))
    expect(after.hour).toBe(12) // still noon, even though the day was 23h long
    // whereas the elapsed physical time is only 23 hours:
    expect(after.epochMilliseconds - before.epochMilliseconds).toBe(23 * 3_600_000)
  })

  it('adding 24 hours (not 1 day) shifts the wall clock', () => {
    const before = zoned('2026-03-07T17:00:00Z', 'America/New_York')
    const after = before.add(duration(24, 'hours'))
    expect(after.hour).toBe(13) // noon + 24h across a 23h day = 1pm
  })
})

describe('plain dates', () => {
  it('parses and preserves calendar dates without zone drift', () => {
    const d = plainDate('2026-03-03')
    expect(d.year).toBe(2026)
    expect(d.month).toBe(3)
    expect(d.day).toBe(3)
    expect(d.toString()).toBe('2026-03-03')
  })

  it('extracts the calendar date from a ZonedDateTime', () => {
    // 11pm New York on Mar 3 is already Mar 4 in Tokyo — plainDate respects the zone
    const lateNy = zoned('2026-03-04T04:00:00Z', 'America/New_York') // 23:00 Mar 3 NY
    expect(plainDate(lateNy).toString()).toBe('2026-03-03')
    expect(plainDate(lateNy.withTimeZone('Asia/Tokyo')).toString()).toBe('2026-03-04')
  })

  it('plainDateToday returns today in the app zone', () => {
    const today = plainDateToday()
    expect(today.toString()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('postgres bridge', () => {
  it('pgDate from string (date column)', () => {
    expect(pgDate('2026-07-18').toString()).toBe('2026-07-18')
  })

  it('pgDate from Date takes calendar components (no off-by-one)', () => {
    // node-postgres gives `date` columns as local-midnight Date objects
    const localMidnight = new Date(2026, 6, 18, 0, 0, 0)
    expect(pgDate(localMidnight).toString()).toBe('2026-07-18')
  })

  it('pgDateString serializes for the driver', () => {
    expect(pgDateString(plainDate('2026-01-05'))).toBe('2026-01-05')
  })
})

describe('duration', () => {
  it('object and (amount, unit) forms', () => {
    expect(duration({ days: 3 }).days).toBe(3)
    expect(duration(90, 'minutes').minutes).toBe(90)
    expect(duration({ hours: 1, minutes: 30 }).total('minutes')).toBe(90)
  })
})

describe('formatZoned', () => {
  const z = zoned('2026-07-18T18:30:00Z', 'America/New_York') // 2:30 PM EDT

  it('formats with locale defaults', () => {
    expect(formatZoned(z)).toBe('Jul 18, 2026, 2:30 PM')
  })

  it('accepts Intl options and locales', () => {
    expect(formatZoned(z, { dateStyle: 'full' })).toBe('Saturday, July 18, 2026')
    expect(formatZoned(z, { timeStyle: 'short' }, 'de-DE')).toBe('14:30')
  })

  it('formats in the ZonedDateTime own zone', () => {
    expect(formatZoned(z.withTimeZone('Asia/Tokyo'), { timeStyle: 'short' })).toBe('3:30 AM')
  })
})
