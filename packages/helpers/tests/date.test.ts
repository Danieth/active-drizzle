import { describe, it, expect } from 'vitest'
import {
  beginningOfDay, endOfDay, beginningOfWeek, endOfWeek,
  beginningOfMonth, endOfMonth, beginningOfQuarter, endOfQuarter,
  beginningOfYear, endOfYear,
  addDays, addWeeks, addMonths, addYears, addHours, addMinutes, addSeconds,
  tomorrow, yesterday, nextOccurring, prevOccurring,
  isToday, isTomorrow, isYesterday, isPast, isFuture,
  isWeekend, isWeekday, isSameDay, daysBetween,
  timeAgoInWords, distanceOfTimeInWords, toFormattedString,
} from '../src/date.js'

// Saturday, July 18 2026, 14:30:15.500 local time
const d = new Date(2026, 6, 18, 14, 30, 15, 500)

describe('boundaries', () => {
  it('day', () => {
    expect(beginningOfDay(d).getHours()).toBe(0)
    expect(beginningOfDay(d).getDate()).toBe(18)
    expect(endOfDay(d).getHours()).toBe(23)
    expect(endOfDay(d).getMilliseconds()).toBe(999)
  })

  it('does not mutate the input', () => {
    const copy = new Date(d)
    beginningOfDay(d)
    endOfMonth(d)
    addMonths(d, 5)
    expect(d.getTime()).toBe(copy.getTime())
  })

  it('week (monday default, sunday option)', () => {
    // July 18 2026 is a Saturday
    expect(beginningOfWeek(d).getDay()).toBe(1) // Monday
    expect(beginningOfWeek(d).getDate()).toBe(13)
    expect(endOfWeek(d).getDay()).toBe(0) // Sunday
    expect(endOfWeek(d).getDate()).toBe(19)
    expect(beginningOfWeek(d, 'sunday').getDate()).toBe(12)
  })

  it('week when date IS the boundary', () => {
    const monday = new Date(2026, 6, 13, 10, 0)
    expect(beginningOfWeek(monday).getDate()).toBe(13)
    const sunday = new Date(2026, 6, 12, 10, 0)
    expect(beginningOfWeek(sunday).getDate()).toBe(6) // previous Monday
  })

  it('month / quarter / year', () => {
    expect(beginningOfMonth(d).getDate()).toBe(1)
    expect(endOfMonth(d).getDate()).toBe(31)
    expect(endOfMonth(new Date(2026, 1, 10)).getDate()).toBe(28) // Feb 2026
    expect(endOfMonth(new Date(2028, 1, 10)).getDate()).toBe(29) // Feb 2028 leap
    expect(beginningOfQuarter(d).getMonth()).toBe(6) // Jul
    expect(endOfQuarter(d).getMonth()).toBe(8) // Sep
    expect(endOfQuarter(d).getDate()).toBe(30)
    expect(beginningOfYear(d).getMonth()).toBe(0)
    expect(endOfYear(d).getMonth()).toBe(11)
    expect(endOfYear(d).getDate()).toBe(31)
  })
})

describe('arithmetic', () => {
  it('addDays / addWeeks across month boundaries', () => {
    expect(addDays(d, 14).getMonth()).toBe(7) // Aug
    expect(addDays(d, 14).getDate()).toBe(1)
    expect(addWeeks(d, 2).getDate()).toBe(1)
    expect(addDays(d, -18).getMonth()).toBe(5) // Jun 30
  })

  it('addMonths clamps end-of-month like Rails', () => {
    const jan31 = new Date(2026, 0, 31)
    expect(addMonths(jan31, 1).getMonth()).toBe(1)
    expect(addMonths(jan31, 1).getDate()).toBe(28) // Feb 2026
    const leap = new Date(2028, 0, 31)
    expect(addMonths(leap, 1).getDate()).toBe(29) // Feb 2028
    expect(addMonths(jan31, -2).getDate()).toBe(30) // Nov 30
  })

  it('addYears handles Feb 29', () => {
    const feb29 = new Date(2028, 1, 29)
    expect(addYears(feb29, 1).getDate()).toBe(28)
    expect(addYears(feb29, 1).getMonth()).toBe(1)
  })

  it('time arithmetic', () => {
    expect(addHours(d, 2).getHours()).toBe(16)
    expect(addMinutes(d, 45).getMinutes()).toBe(15)
    expect(addSeconds(d, 50).getSeconds()).toBe(5)
  })
})

describe('relative days and occurrences', () => {
  it('tomorrow / yesterday', () => {
    expect(tomorrow(d).getDate()).toBe(19)
    expect(yesterday(d).getDate()).toBe(17)
  })

  it('nextOccurring / prevOccurring', () => {
    // d is Saturday Jul 18
    expect(nextOccurring(d, 'monday').getDate()).toBe(20)
    expect(nextOccurring(d, 'saturday').getDate()).toBe(25) // next, not same day
    expect(prevOccurring(d, 'friday').getDate()).toBe(17)
    expect(prevOccurring(d, 'saturday').getDate()).toBe(11)
  })
})

describe('predicates', () => {
  it('isToday / isTomorrow / isYesterday with explicit now', () => {
    expect(isToday(new Date(2026, 6, 18, 1, 0), d)).toBe(true)
    expect(isTomorrow(new Date(2026, 6, 19), d)).toBe(true)
    expect(isYesterday(new Date(2026, 6, 17), d)).toBe(true)
    expect(isToday(new Date(2026, 6, 19), d)).toBe(false)
  })

  it('isPast / isFuture', () => {
    expect(isPast(new Date(2020, 0, 1), d)).toBe(true)
    expect(isFuture(new Date(2030, 0, 1), d)).toBe(true)
  })

  it('isWeekend / isWeekday / isSameDay', () => {
    expect(isWeekend(d)).toBe(true) // Saturday
    expect(isWeekday(new Date(2026, 6, 15))).toBe(true) // Wednesday
    expect(isSameDay(d, new Date(2026, 6, 18, 23, 59))).toBe(true)
    expect(isSameDay(d, new Date(2026, 6, 19, 0, 0))).toBe(false)
  })
})

describe('differences', () => {
  it('daysBetween is calendar-based, sign-aware', () => {
    expect(daysBetween(new Date(2026, 6, 1), new Date(2026, 6, 18))).toBe(17)
    expect(daysBetween(new Date(2026, 6, 18), new Date(2026, 6, 1))).toBe(-17)
    expect(daysBetween(new Date(2026, 6, 18, 23), new Date(2026, 6, 19, 1))).toBe(1)
  })

  it('distanceOfTimeInWords matches Rails buckets', () => {
    const base = new Date(2026, 0, 1, 12, 0, 0)
    const at = (ms: number) => new Date(base.getTime() + ms)
    expect(distanceOfTimeInWords(base, at(20_000))).toBe('less than a minute')
    expect(distanceOfTimeInWords(base, at(60_000))).toBe('a minute')
    expect(distanceOfTimeInWords(base, at(10 * 60_000))).toBe('10 minutes')
    expect(distanceOfTimeInWords(base, at(60 * 60_000))).toBe('about 1 hour')
    expect(distanceOfTimeInWords(base, at(5 * 3_600_000))).toBe('about 5 hours')
    expect(distanceOfTimeInWords(base, at(26 * 3_600_000))).toBe('1 day')
    expect(distanceOfTimeInWords(base, at(4 * 86_400_000))).toBe('4 days')
    expect(distanceOfTimeInWords(base, at(40 * 86_400_000))).toBe('about 1 month')
    expect(distanceOfTimeInWords(base, at(200 * 86_400_000))).toBe('7 months')
    expect(distanceOfTimeInWords(base, at(370 * 86_400_000))).toBe('about 1 year')
    expect(distanceOfTimeInWords(base, at(3 * 365 * 86_400_000))).toBe('about 3 years')
  })

  it('timeAgoInWords is symmetric', () => {
    expect(timeAgoInWords(new Date(Date.now() - 10 * 60_000))).toBe('10 minutes')
  })
})

describe('toFormattedString', () => {
  const t = new Date(2026, 6, 18, 9, 5, 3)

  it('db / number / short / long', () => {
    expect(toFormattedString(t, 'db')).toBe('2026-07-18 09:05:03')
    expect(toFormattedString(t, 'number')).toBe('20260718090503')
    expect(toFormattedString(t, 'short')).toBe('18 Jul 09:05')
    expect(toFormattedString(t, 'long')).toBe('July 18, 2026 09:05')
    expect(toFormattedString(t)).toBe('2026-07-18 09:05:03') // default db
  })

  it('iso8601 delegates to toISOString', () => {
    expect(toFormattedString(t, 'iso8601')).toBe(t.toISOString())
  })
})
