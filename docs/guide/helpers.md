# Helpers

`@active-drizzle/helpers` brings Rails' ActiveSupport core extensions to TypeScript — array, string, number, and object helpers, plus an [awesome_print](https://github.com/awesome-print/awesome_print)-style `ap()` pretty printer.

```bash
npm install @active-drizzle/helpers
```

Everything is available two ways: as **pure functions**, or as **methods directly on arrays, strings, and numbers** after a one-time install.

## Prototype methods (the Rails way)

Call `installHelpers()` once at app boot:

```ts
import { installHelpers } from '@active-drizzle/helpers'
installHelpers()
```

Then, anywhere in your app:

```ts
[1, 2, 3].second()                        // 2
users.pluckKey('email')                   // ['a@x.com', ...]
orders.groupBy(o => o.status)             // { pending: [...], shipped: [...] }
[1, null, 2, undefined].compact()         // [1, 2]
names.toSentence()                        // 'Alice, Bob, and Carol'
values.isBlank()                          // Ruby's blank? — ? becomes is-prefix

'user_profile'.camelize()                 // 'userProfile'
'UserProfile'.tableize()                  // 'user_profiles'
'person'.pluralize()                      // 'people'
'  hello   world '.squish()               // 'hello world'
''.isBlank()                                // true

(3).ordinalize()                          // '3rd'
(1234.5).toCurrency()                     // '$1,234.50'
(1234567).toHumanSize()                   // '1.2 MB'
(5).minutes()                             // 300000 (ms — perfect for setTimeout)
```

Installation is safe and idempotent:

- Methods are **non-enumerable** — they never appear in `for..in`, `Object.keys()`, or `JSON.stringify()`.
- Existing properties are **never overwritten** — if a future ECMAScript version ships a native method with the same name, the native one wins.
- Calling `installHelpers()` twice is a no-op.

Type support comes automatically: importing the package augments the global `Array`, `String`, and `Number` interfaces.

## Pure functions

If you prefer to leave prototypes untouched, every helper is importable directly:

```ts
import { groupBy, camelize, ordinalize, isBlank, deepMerge, dig } from '@active-drizzle/helpers'

groupBy(orders, o => o.status)
camelize('user_profile')       // 'userProfile'
ordinalize(3)                  // '3rd'
isBlank('')                    // true — Rails blank? semantics
deepMerge(defaults, overrides)
dig(payload, 'data', 'items', 0, 'id')  // safe nested access
```

Namespaced imports are available too: `import { arrays, strings, numbers, objects } from '@active-drizzle/helpers'`.

### Object helpers (functions only)

We never extend `Object.prototype`. Hash-style helpers are pure functions:

| Helper | Rails equivalent |
| --- | --- |
| `isBlank(v)` / `isPresent(v)` / `presence(v)` | `blank?` / `present?` / `presence` |
| `slice(obj, ...keys)` / `except(obj, ...keys)` | `slice` / `except` |
| `compactObject(obj)` / `compactBlank(obj)` | `compact` / `compact_blank` |
| `camelizeKeys` / `underscoreKeys` (+ `deep*` variants) | `deep_transform_keys` |
| `deepMerge(a, b)` | `deep_merge` |
| `dig(obj, ...keys)` | `dig` |

## `ap()` — awesome_print-style output

`ap()` pretty-prints any value with indexed arrays, aligned keys, and per-type colors — the awesome_print look, in your Node console:

```ts
import { ap } from '@active-drizzle/helpers'

ap(await User.all())
```

```
[
    [0] #<User> {
          id: 1,
        name: "Alice"
    },
    [1] #<User> {
          id: 2,
        name: "Bob"
    }
]
```

`ap()` returns its argument, so you can drop it into any pipeline for debugging:

```ts
const active = ap(users.filter(u => u.active))
```

Options: `ap(value, { indent: 4, colors: false, depth: 10, sortKeys: true })`. Colors auto-detect TTY. `apFormat()` returns the string without printing.

After `installHelpers()`, arrays and strings also have an `.ap()` method: `users.ap()`.

## In the console

`ap()` pairs perfectly with the [active-drizzle console](/guide/console):

```ts
// bin/console.ts
import { createConsole } from '@active-drizzle/core'
import { ap, installHelpers } from '@active-drizzle/helpers'
installHelpers()

createConsole({ db, schema, models: { User }, context: { ap } })
```

```
app> ap(User.where({ active: true }))
```

## Time zones (Temporal)

Zone-aware time is built on [Temporal](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal) — the ECMAScript standard that replaces `Date`. Native in Node 26+, Chrome 144+, and Firefox 139+; everywhere else the bundled polyfill kicks in automatically with identical behavior.

The whole mental model in three lines:

1. **The database stores instants** (Postgres `timestamptz`) — points on the physical timeline with no zone. JS `Date` is also an instant. Store `Date`s; they're always correct.
2. **Humans see zoned time.** Convert at the display edge with `zoned()`.
3. **Calendar dates** (birthdays, due dates — Postgres `date`) have no time and no zone. Use `plainDate()`, never an instant — that's where off-by-one-day bugs come from.

```ts
import { setDefaultTimeZone, zonedNow, zoned, toDate, plainDate, duration, formatMoney } from '@active-drizzle/helpers'

setDefaultTimeZone('America/New_York')   // once at boot — Rails' Time.zone=

zonedNow()                               // current time in the app zone
zoned(user.createdAt)                    // Date from the DB → zoned display time
zoned(user.createdAt, 'Asia/Tokyo')      // ...in any IANA zone
toDate(zdt)                              // back to a JS Date for the DB

zoned(d).add(duration(1, 'days'))        // DST-safe: noon stays noon across spring-forward
formatZoned(zoned(d))                    // 'Jul 18, 2026, 2:30 PM' (Intl, locale-aware)

plainDate('2026-03-03')                  // Postgres date column value
pgDate(row.dueDate)                      // driver value (string or Date) → PlainDate, no off-by-one
```

## Money and strict integers

TypeScript has no integer type — `@active-drizzle/helpers` adds one with branded types. `Int` is a `number` that provably passed `Number.isSafeInteger`; the only way to make one is the validating constructor:

```ts
import { int, isInt, cents, dollarsToCents, formatMoney, type Int, type Cents } from '@active-drizzle/helpers'

function reserve(quantity: Int) { /* ... */ }
reserve(3)        // ✗ compile error — number is not Int
reserve(int(3))   // ✓
int(3.5)          // ✓ compiles — but throws TypeError at runtime

const price: Cents = dollarsToCents(19.99)  // 1999 — integer cents, never floats
formatMoney(price)                          // '$19.99'
formatMoney(price, { currency: 'EUR', locale: 'de-DE' })  // '19,99 €'
mulCents(price, 1.08875)                    // tax math, rounded back to integer cents
```

On the model layer, `Attr.money` and `Attr.int` enforce the same rules at the database boundary:

```ts
class Product extends ApplicationRecord {
  // schema: priceCents: integer('price_cents')
  static price = Attr.money('priceCents')   // dollars on the model, integer cents in the DB
  static stock = Attr.int()                 // assigning 3.5 throws — floats can't reach the column
}

product.price = 19.99    // stored as 1999
product.price            // → 19.99
```

## Dates

The full ActiveSupport Date/Time surface, immutable (every call returns a new `Date`):

```ts
new Date().beginningOfDay()               // 00:00:00.000 today
new Date().endOfMonth()                   // last ms of the month
date.beginningOfWeek()                    // Monday start (Rails default); pass 'sunday' to change
date.addMonths(1)                         // Jan 31 → Feb 28/29 (Rails end-of-month clamping)
date.nextOccurring('monday')              // next Monday
date.isWeekend()                          // true/false
date.timeAgoInWords()                     // 'about 2 hours'
date.toFormattedString('db')              // '2026-07-18 09:05:03'
```

Combined with number durations, you get Rails' time DSL:

```ts
import { fromNow, ago } from '@active-drizzle/helpers'

fromNow((3).days())                       // 3.days.from_now
ago((2).weeks())                          // 2.weeks.ago
```

## Full helper reference

**Array** — `first(n?)`, `last(n?)`, `second`–`fifth`, `isBlank`, `isPresent`, `presence`, `compact`, `uniq(by?)`, `without`, `including`, `pluck`/`pluckKey`, `groupBy`, `indexBy`, `countBy`, `tally`, `partition`, `sum(fn?)`, `minBy`, `maxBy`, `sortBy`, `eachSlice`, `eachCons`, `inGroupsOf`, `inGroups`, `sample(n?)`, `shuffle`, `toSentence`, `zip`, `rotate`, `eachWithObject`, `takeWhile`, `dropWhile`, `chunkWhile`, `sliceWhen`, `from`, `to`, `sole`, `deepDup`.

**String** — `pluralize(count?)`, `singularize`, `camelize`, `underscore`, `dasherize`, `humanize`, `titleize`, `classify`, `tableize`, `parameterize`, `foreignKey`, `capitalize`, `deletePrefix`, `deleteSuffix`, `isBlank`, `isPresent`, `presence`, `truncate`, `truncateWords`, `squish`, `stripHeredoc`, `indent`, `toBoolean`, `remove`, `first(n?)`, `last(n?)`, `from`, `to`, `swapcase`, `center`.

**Number** — `ordinal`, `ordinalize`, `withDelimiter`, `toCurrency`, `toPercentage`, `toHumanSize`, `toHuman`, `clamp`, `multipleOf`, `even`, `odd`, `roundTo`, `percentOf`, `seconds`, `minutes`, `hours`, `days`, `weeks`, `kilobytes`, `megabytes`, `gigabytes`, `terabytes` (plus `fromNow(ms)` / `ago(ms)` as functions).

**Date** — `beginningOfDay`/`endOfDay`, `beginningOfWeek`/`endOfWeek`, `beginningOfMonth`/`endOfMonth`, `beginningOfQuarter`/`endOfQuarter`, `beginningOfYear`/`endOfYear`, `addDays`/`addWeeks`/`addMonths`/`addYears`/`addHours`/`addMinutes`/`addSeconds`, `nextOccurring`/`prevOccurring`, `isToday`/`isPast`/`isFuture`/`isWeekend`/`isWeekday`, `timeAgoInWords`, `toFormattedString` (plus `tomorrow`, `yesterday`, `isTomorrow`, `isYesterday`, `isSameDay`, `daysBetween`, `distanceOfTimeInWords` as functions).
