/**
 * Attr.timezone + the Intl-backed timezone utilities.
 * The "simple case": a user stores a zone preference, and the backend can
 * actually USE it against JS Dates — format, offset, picker list.
 */

import { describe, it, expect } from 'vitest'
import { Attr } from '../../src/runtime/attr.js'
import { Validates } from '../../src/runtime/validators.js'
import {
  allTimezones,
  canonicalTimezone,
  formatInTimeZone,
  isValidTimezone,
  timeZoneOffsetMinutes,
} from '../../src/runtime/timezone.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'

describe('allTimezones', () => {
  it('returns the full IANA list from Intl', () => {
    const zones = allTimezones()
    expect(zones.length).toBeGreaterThan(300)
    expect(zones).toContain('America/New_York')
    expect(zones).toContain('Asia/Tokyo')
    expect(zones).toContain('UTC')
  })

  it('is memoized (same array back)', () => {
    expect(allTimezones()).toBe(allTimezones())
  })
})

describe('canonicalTimezone / isValidTimezone', () => {
  it('canonicalizes case', () => {
    expect(canonicalTimezone('america/new_york')).toBe('America/New_York')
    expect(canonicalTimezone('UTC')).toBe('UTC')
    expect(canonicalTimezone('  Asia/Tokyo  ')).toBe('Asia/Tokyo')
  })

  it('rejects garbage and non-strings', () => {
    expect(canonicalTimezone('Mars/Olympus_Mons')).toBeNull()
    expect(canonicalTimezone('')).toBeNull()
    expect(canonicalTimezone(5)).toBeNull()
    expect(canonicalTimezone(null)).toBeNull()
    expect(isValidTimezone('America/Chicago')).toBe(true)
    expect(isValidTimezone('Nope/Nope')).toBe(false)
  })
})

describe('formatInTimeZone — using the stored zone against Dates', () => {
  const instant = new Date('2026-07-18T13:14:00.000Z')

  it('renders wall-clock time in the zone', () => {
    expect(formatInTimeZone(instant, 'America/New_York')).toMatch(/9:14/)
    expect(formatInTimeZone(instant, 'Asia/Tokyo')).toMatch(/10:14/)
    expect(formatInTimeZone(instant, 'UTC')).toMatch(/1:14/)
  })

  it('accepts custom Intl options and locales', () => {
    expect(
      formatInTimeZone(instant, 'America/New_York', { hour: '2-digit', minute: '2-digit', hour12: false })
    ).toBe('09:14')
    expect(formatInTimeZone(instant, 'Asia/Tokyo', { dateStyle: 'long', locale: 'ja-JP' })).toContain('2026')
  })

  it('never throws on bad input — null instead', () => {
    expect(formatInTimeZone(new Date(NaN), 'UTC')).toBeNull()
    expect(formatInTimeZone(instant, 'Nope/Nope')).toBeNull()
    expect(formatInTimeZone('garbage', 'UTC')).toBeNull()
  })
})

describe('timeZoneOffsetMinutes — DST-aware offsets', () => {
  it('summer vs winter New York', () => {
    expect(timeZoneOffsetMinutes('America/New_York', new Date('2026-07-01T12:00:00Z'))).toBe(-240)
    expect(timeZoneOffsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300)
  })

  it('half-hour zones and UTC', () => {
    expect(timeZoneOffsetMinutes('Asia/Kolkata')).toBe(330)
    expect(timeZoneOffsetMinutes('UTC')).toBe(0)
  })

  it('unknown zone → null', () => {
    expect(timeZoneOffsetMinutes('Nope/Nope')).toBeNull()
  })
})

describe('Attr.timezone', () => {
  const tz = Attr.timezone()

  it('canonicalizes on write (absorb wide)', () => {
    expect(tz.set!('america/new_york')).toBe('America/New_York')
    expect(tz.set!('UTC')).toBe('UTC')
    expect(tz.set!('  asia/tokyo ')).toBe('Asia/Tokyo')
  })

  it('garbage casts to null, reads are 1:1', () => {
    expect(tz.set!('Mars/Olympus_Mons')).toBeNull()
    expect(tz.set!('')).toBeNull()
    expect(tz.set!(null)).toBeNull()
    expect(tz.get!('America/New_York')).toBe('America/New_York')
    expect(tz.get!(null)).toBeNull()
    expect(tz.get!('')).toBeNull()
  })

  it('carries the _type marker for codegen/presenters', () => {
    expect(tz._type).toBe('timezone')
  })

  it('the simple case end-to-end: user sets a zone, backend uses it', () => {
    class User extends ApplicationRecord {
      static timezone = Attr.timezone()
    }
    const user = new User({ id: 1, timezone: null }, false)
    ;(user as any).timezone = 'america/new_york'
    expect((user as any).timezone).toBe('America/New_York')

    const sentAt = new Date('2026-07-18T13:14:00.000Z')
    expect(formatInTimeZone(sentAt, (user as any).timezone)).toMatch(/9:14/)
  })
})

describe('Validates.timezone', () => {
  it('valid zones pass, garbage fails, nil skips', () => {
    const v = Validates.timezone()
    expect(v('America/New_York')).toBeNull()
    expect(v('Nope/Nope')).toBe('is not a valid timezone')
    expect(v(null)).toBeNull()
  })
})
