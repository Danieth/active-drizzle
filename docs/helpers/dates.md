# Date Helpers

ActiveSupport-style `Date`/`Time` extensions for JavaScript `Date`. Every function is immutable (returns a new `Date`, never mutates its argument) and all calendar math runs in the **JS runtime's local time zone** (like Rails computing in `Time.zone`).

```ts
const d = new Date(2026, 6, 18, 14, 30, 15, 500) // Sat Jul 18 2026, 14:30:15.500 local
```

## Boundaries (beginning/end of …)

All boundary helpers snap a `Date` to the start/end of a local-time unit; end-of helpers land on `.999` milliseconds.

### `beginningOfDay(d: Date): Date`
Midnight (00:00:00.000) of the same local day. Rails' `beginning_of_day`.
```ts
beginningOfDay(d)   // → Sat Jul 18 2026, 00:00:00.000
```

### `endOfDay(d: Date): Date`
Last instant (23:59:59.999) of the same local day. Rails' `end_of_day`.
```ts
endOfDay(d)         // → Sat Jul 18 2026, 23:59:59.999
```

### `beginningOfHour(d) / endOfHour(d)` · `beginningOfMinute(d) / endOfMinute(d)`
Snap to the top / last instant of the hour or minute. Rails' `beginning_of_hour`, `end_of_minute`, etc.
```ts
beginningOfHour(d)   // → 14:00:00.000
endOfHour(d)         // → 14:59:59.999
beginningOfMinute(d) // → 14:30:00.000
endOfMinute(d)       // → 14:30:59.999
```

### `beginningOfWeek(d: Date, weekStart?: 'monday' | 'sunday'): Date`
Midnight on the first day of the week; defaults to Monday-start like Rails' `beginning_of_week`.
```ts
beginningOfWeek(d)             // → Mon Jul 13 2026, 00:00:00.000
beginningOfWeek(d, 'sunday')   // → Sun Jul 12 2026, 00:00:00.000
```

### `endOfWeek(d: Date, weekStart?: 'monday' | 'sunday'): Date`
Last instant of the week's final day. Rails' `end_of_week`.
```ts
endOfWeek(d)        // → Sun Jul 19 2026, 23:59:59.999
```

### `beginningOfMonth(d) / endOfMonth(d)`
1st of the month at midnight / last instant of the final day (leap-year aware). Rails' `beginning_of_month` / `end_of_month`.
```ts
beginningOfMonth(d)                 // → Wed Jul 1 2026, 00:00:00.000
endOfMonth(d)                       // → Fri Jul 31 2026, 23:59:59.999
endOfMonth(new Date(2026, 1, 10))   // → Feb 28 2026 (non-leap)
endOfMonth(new Date(2028, 1, 10))   // → Feb 29 2028 (leap)
```

### `beginningOfQuarter(d) / endOfQuarter(d)` · `beginningOfYear(d) / endOfYear(d)`
Quarter (Jan/Apr/Jul/Oct) and year boundaries. Rails' `beginning_of_quarter`, `end_of_year`, etc.
```ts
beginningOfQuarter(d)  // → Wed Jul 1 2026 (Q3)
endOfQuarter(d)        // → Wed Sep 30 2026, 23:59:59.999
beginningOfYear(d)     // → Thu Jan 1 2026, 00:00:00.000
endOfYear(d)           // → Thu Dec 31 2026, 23:59:59.999
```

## Arithmetic

Calendar-aware, immutable offsets. Day/week/month/year math is done on calendar fields (local time); hour/minute/second math is pure epoch-millisecond math.

### `addDays(d, n)` · `addWeeks(d, n)`
Add (or subtract, if negative) `n` days / weeks. Rails' `+ n.days` / `+ n.weeks`.
```ts
addDays(d, 14)   // → Sat Aug 1 2026
addDays(d, -18)  // → Tue Jun 30 2026
addWeeks(d, 2)   // → Sat Aug 1 2026
```

### `addMonths(d: Date, n: number): Date`
Add `n` calendar months with Rails' end-of-month clamping (Jan 31 + 1 month → Feb 28/29). Rails' `+ n.months`.
```ts
addMonths(new Date(2026, 0, 31), 1)   // → Feb 28 2026 (clamped)
addMonths(new Date(2028, 0, 31), 1)   // → Feb 29 2028 (leap)
addMonths(new Date(2026, 0, 31), -2)  // → Nov 30 2025
```

### `addYears(d: Date, n: number): Date`
Add `n` years, clamping Feb 29 → Feb 28 in non-leap years. Rails' `+ n.years`.
```ts
addYears(new Date(2028, 1, 29), 1)    // → Feb 28 2029
```

### `addHours(d, n)` · `addMinutes(d, n)` · `addSeconds(d, n)`
Exact millisecond offsets. Rails' `+ n.hours` / `+ n.minutes` / `+ n.seconds`.
```ts
addHours(d, 2)     // → 16:30:15
addMinutes(d, 45)  // → 15:15:15
addSeconds(d, 50)  // → 14:31:05
```

## Relative (tomorrow / ago)

Convenience helpers relative to a given date (defaulting to `new Date()`), plus weekday navigation.

### `tomorrow(from?: Date): Date` · `yesterday(from?: Date): Date`
The next / previous day. Rails' `Date.tomorrow` / `Date.yesterday`. Non-deterministic without an argument.
```ts
tomorrow(d)   // → Sun Jul 19 2026, 14:30:15
yesterday(d)  // → Fri Jul 17 2026, 14:30:15
tomorrow()    // → a Date ~24h from now
```

### `nextOccurring(d: Date, weekday: Weekday): Date` · `prevOccurring(d: Date, weekday: Weekday): Date`
The next / most-recent date (strictly after / before `d`) on `weekday`, at midnight. Rails' `next_occurring(:monday)` / `prev_occurring(:friday)`.
```ts
nextOccurring(d, 'monday')    // → Mon Jul 20 2026, 00:00
prevOccurring(d, 'friday')    // → Fri Jul 17 2026, 00:00
```

### `type Weekday`
The weekday string union accepted by `nextOccurring`/`prevOccurring`.
```ts
type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'
```

## Predicates

Boolean tests. Day-comparison predicates default `now` to `new Date()` and compare local calendar days.

### `isToday(d, now?)` · `isTomorrow(d, now?)` · `isYesterday(d, now?)`
Same-local-day comparison against `now`. Rails' `today?` / `tomorrow?` / `yesterday?`.
```ts
isToday(new Date(2026, 6, 18, 1, 0), d)  // → true
isTomorrow(new Date(2026, 6, 19), d)     // → true
```

### `isPast(d, now?)` · `isFuture(d, now?)`
Strict instant comparison against `now`. Rails' `past?` / `future?`.
```ts
isPast(new Date(2020, 0, 1), d)    // → true
isFuture(new Date(2030, 0, 1), d)  // → true
```

### `isWeekend(d)` · `isWeekday(d)` · `isSameDay(a, b)`
Weekend/weekday tests and a local same-calendar-day comparison. Rails' `on_weekend?` / `on_weekday?` / `same_day?`.
```ts
isWeekend(d)                                 // → true (Saturday)
isWeekday(new Date(2026, 6, 15))             // → true (Wednesday)
isSameDay(d, new Date(2026, 6, 18, 23, 59))  // → true
```

## Formatting & distance

### `daysBetween(a: Date, b: Date): number`
Whole calendar days from `a` to `b` (signed; `b - a`), by local day boundaries.
```ts
daysBetween(new Date(2026, 6, 1), new Date(2026, 6, 18))   // → 17
daysBetween(new Date(2026, 6, 18), new Date(2026, 6, 1))   // → -17
```

### `timeAgoInWords(d: Date, now?: Date): string`
Human phrase for the distance between `d` and `now`. Rails' `time_ago_in_words`. Non-deterministic without `now`.
```ts
timeAgoInWords(new Date(Date.now() - 10 * 60_000))  // → '10 minutes'
```

### `distanceOfTimeInWords(from: Date, to: Date): string`
Human phrase for the (absolute) distance between two dates, using Rails' bucket thresholds. Rails' `distance_of_time_in_words`.
```ts
const base = new Date(2026, 0, 1, 12, 0, 0)
distanceOfTimeInWords(base, new Date(base.getTime() + 20_000))          // → 'less than a minute'
distanceOfTimeInWords(base, new Date(base.getTime() + 60 * 60_000))     // → 'about 1 hour'
distanceOfTimeInWords(base, new Date(base.getTime() + 26 * 3_600_000))  // → '1 day'
distanceOfTimeInWords(base, new Date(base.getTime() + 370 * 86_400_000))// → 'about 1 year'
```

### `toFormattedString(d: Date, format?: 'short' | 'long' | 'db' | 'iso8601' | 'number'): string`
Preset date formatting (defaults to `'db'`). Rails' `to_formatted_s(:db)` presets. All but `iso8601` render in **local time**.
```ts
const t = new Date(2026, 6, 18, 9, 5, 3)
toFormattedString(t, 'db')       // → '2026-07-18 09:05:03'
toFormattedString(t, 'number')   // → '20260718090503'
toFormattedString(t, 'short')    // → '18 Jul 09:05'
toFormattedString(t, 'long')     // → 'July 18, 2026 09:05'
toFormattedString(t, 'iso8601')  // → t.toISOString() (UTC)
```

---

# Time & Time Zones

Zone-aware time — Rails' `Time.zone` for TypeScript, built on **Temporal** (native `Temporal` global when available, `temporal-polyfill` otherwise). The model: the DB stores **instants** (`timestamptz`, like a JS `Date`), humans see **zoned** time (convert at the edge with `zoned()`), and time-of-day-less `date` columns are **plain dates** (`plainDate()`) to avoid off-by-one-day bugs.

The module also re-exports `Temporal` and the `ZonedDateTime`, `PlainDate`, `Instant`, and `Duration` types.

## App time zone (Rails' `Time.zone`)

### `setDefaultTimeZone(tz: string): void`
Set the process-wide app zone once at boot; validates eagerly and throws on unknown IANA zones. Rails' `Time.zone = …`.
```ts
setDefaultTimeZone('America/New_York')   // ok
setDefaultTimeZone('Mars/Olympus_Mons')  // throws (unknown zone)
```

### `getDefaultTimeZone(): string`
The configured app zone, falling back to the runtime's own zone if unset. Rails' `Time.zone.name`.
```ts
getDefaultTimeZone()   // → runtime zone by default
```

## Zoned time

### `zonedNow(tz?: string): ZonedDateTime`
Current instant as a `ZonedDateTime` in the app zone (or `tz`). Rails' `Time.zone.now`. Non-deterministic.
```ts
zonedNow()               // → ZonedDateTime "now" in the app zone
zonedNow('Asia/Tokyo')   // → ZonedDateTime "now" in Tokyo
```

### `zoned(value: Date | number | string | Instant | ZonedDateTime, tz?: string): ZonedDateTime`
Convert anything time-like to a `ZonedDateTime` in the app zone (or `tz`). Rails' `Time.zone.at` / `in_time_zone`.
```ts
const ny    = zoned(epoch, 'America/New_York')
const tokyo = zoned(epoch, 'Asia/Tokyo')
ny.epochMilliseconds === tokyo.epochMilliseconds   // → true (same instant, different wall clocks)
```

### `toDate(value: ZonedDateTime | Instant): Date`
Back to a plain JS `Date` (an instant) for the DB driver or JSON — round-trips `zoned()` losslessly.
```ts
toDate(zoned(new Date(epoch), 'Europe/Berlin')).getTime()  // → epoch
```

Because durations are calendar-aware, **1 day** vs **24 hours** differ across a DST transition:
```ts
const before = zoned('2026-03-07T17:00:00Z', 'America/New_York')  // noon EST
before.add(duration(1, 'days')).hour    // → 12 (still noon; the day was 23h long)
before.add(duration(24, 'hours')).hour  // → 13 (24h across a 23h day)
```

## Plain dates (Postgres `date` columns)

### `plainDate(value: string | PlainDate | ZonedDateTime): PlainDate`
A calendar date with no time and no zone; parses `'YYYY-MM-DD'` or takes a `ZonedDateTime`'s calendar date (respecting its zone).
```ts
plainDate('2026-03-03').toString()   // → '2026-03-03'
```

### `plainDateToday(tz?: string): PlainDate`
Today's calendar date in the app zone (or `tz`). Rails' `Date.current`. Non-deterministic.
```ts
plainDateToday().toString()   // → e.g. '2026-07-19'
```

## Durations

### `duration(like: Partial<Record<DurationUnit, number>>): Duration`  ·  `duration(amount: number, unit: DurationUnit): Duration`
Build a calendar-aware `Temporal.Duration` from an object or an `(amount, unit)` pair. Rails' `3.days` / `1.month`. Overloaded.
```ts
duration({ days: 3 }).days                            // → 3
duration(90, 'minutes').minutes                       // → 90
duration({ hours: 1, minutes: 30 }).total('minutes')  // → 90
```

### `type DurationUnit`
```ts
type DurationUnit = 'years' | 'months' | 'weeks' | 'days'
                  | 'hours' | 'minutes' | 'seconds' | 'milliseconds'
```

## Postgres bridge

### `pgDate(value: string | Date): PlainDate`
Parse a Postgres `date` value (a `'YYYY-MM-DD'` string, or the local-midnight `Date` node-postgres returns) into a `PlainDate`, taking calendar components directly to avoid off-by-one drift.
```ts
pgDate('2026-07-18').toString()   // → '2026-07-18'
```

### `pgDateString(date: PlainDate): string`
Serialize a `PlainDate` back to `'YYYY-MM-DD'` for a Postgres `date` column.
```ts
pgDateString(plainDate('2026-01-05'))   // → '2026-01-05'
```

## Formatting

### `formatZoned(zdt: ZonedDateTime, options?: Intl.DateTimeFormatOptions, locale?: string): string`
Locale-aware formatting via `Intl.DateTimeFormat`, rendered in the `ZonedDateTime`'s own zone (defaults `{ dateStyle: 'medium', timeStyle: 'short' }`, `'en-US'`).
```ts
const z = zoned('2026-07-18T18:30:00Z', 'America/New_York')  // 2:30 PM EDT
formatZoned(z)                          // → 'Jul 18, 2026, 2:30 PM'
formatZoned(z, { dateStyle: 'full' })   // → 'Saturday, July 18, 2026'
```
