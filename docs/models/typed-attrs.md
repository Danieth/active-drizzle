# Typed Arrays, Ranges & Timezones

Every scalar Attr can be lifted into a Postgres array, and the orderable
ones into a Postgres range. The cast contract is the same everywhere:
**writes absorb a wide funnel** (numbers, strings, padded/signed forms —
garbage collapses to `null`, never `NaN`), **reads are 1:1** from what the
column stores.

## `Attr.array.<type>` — typed Postgres arrays

Each element runs through the matching scalar cast in **both** directions:

```ts
@model('products')
export class Product extends ApplicationRecord {
  static tags    = Attr.array()            // passthrough (text[])
  static scores  = Attr.array.integer()    // '{"1","2"}' → [1, 2]
  static flags   = Attr.array.boolean()    // ['t','false'] → [true, false]
  static touched = Attr.array.date()       // elements become JS Dates
  static tiers   = Attr.array.money()      // dollars in, integer cents stored
  static rates   = Attr.array.percent()    // percents in, fractions stored
}

product.tiers = [19.99, 8.165]   // stored [1999, 817] — exact cents
product.tiers                    // → [19.99, 8.17]
```

Available: `string`, `integer`, `int` (strict), `boolean`, `date`,
`decimal`, `money`, `percent`, `json`. For anything custom, the escape
hatch takes a per-element function:

```ts
static ids = Attr.array({ element: (v) => BigInt(v) })
```

## `Attr.range.<type>` — typed Postgres ranges

Ranges need `<`/`>` to mean something, so the range namespace covers the
orderable types only. Literals like `[1,10)` parse into a structured
`PgRange` and serialize back on write:

```ts
@model('venues')
export class Venue extends ApplicationRecord {
  static seats      = Attr.range()            // numrange / int4range
  static bookedAt   = Attr.range.date()       // tstzrange — bounds are Dates
  static targetRate = Attr.range.percent()    // fractions in DB, percents on model
  static priceBand  = Attr.range.money()      // cents in DB, dollars on model
}

venue.seats                 // → { lower: 1, upper: 10, lowerInclusive: true, upperInclusive: false }
venue.priceBand = { lower: 8.165, upper: 19.99, lowerInclusive: true, upperInclusive: false }
// stored as '[817,1999)' — exact cents, no float drift
```

Available: `integer`, `decimal`, `date`, `percent`, `money`.
`Attr.dateRange()` and `Attr.percentRange()` remain as aliases, and
`Attr.multirange()` handles PG 14 multiranges. `rangeIncludes(range, value)`
tests membership (bound-inclusivity aware; `NaN` is in no range).

## `Attr.timezone` — IANA zones, zero dependencies

The platform's `Intl` data *is* the timezone database — nothing bundled,
never stale. The column stores a canonical IANA id:

```ts
@model('users')
export class User extends ApplicationRecord {
  static timezone = Attr.timezone()
}

user.timezone = 'america/new_york'   // canonicalized → 'America/New_York'
user.timezone = 'US/Eastern'         // legacy alias → modern id
user.timezone = 'Mars/Olympus'       // → null (pair with Validates.timezone())
```

And the point of storing it — actually using it against `Date` values on
the backend:

```ts
import { formatInTimeZone, timeZoneOffsetMinutes, allTimezones } from 'active-drizzle'

formatInTimeZone(order.createdAt, user.timezone)
// → 'Jul 18, 2026, 9:14 AM'
formatInTimeZone(order.createdAt, user.timezone, { dateStyle: 'full', locale: 'de-DE' })

timeZoneOffsetMinutes(user.timezone)                    // → -240 (DST-aware)
allTimezones()                                          // full sorted list for pickers
```

`Validates.timezone()` is the matching declarative validator — see
[Declarative Validators](/hooks/validators).
