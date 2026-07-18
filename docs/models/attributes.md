# Attributes (Attr)

The `Attr` system declares how a column value is **transformed on read (`get`)** and **transformed on write (`set`)**. All transforms are applied by the Proxy that wraps every model instance — no boilerplate needed.

## `Attr.enum` — integer ↔ label

Store integers in the DB, get back descriptive strings in TypeScript.

```ts
// schema.ts
import { pgTable, integer } from 'drizzle-orm/pg-core'

export const orders = pgTable('orders', {
  id:     integer('id').primaryKey().generatedAlwaysAsIdentity(),
  status: integer('status').notNull().default(0),
})
```

```ts
// models/Order.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'
import { Attr }              from 'active-drizzle'

@model('orders')
export class Order extends ApplicationRecord {
  static status = Attr.enum({ pending: 0, paid: 1, shipped: 2, cancelled: 3 } as const)
}
```

```ts
const order = await Order.create({ status: 'pending' })

order.status          // → 'pending'  (string label)
order.isPending()     // → true        (auto-generated predicate)
order.isPaid()        // → false
order.toPaid()        // sets status = 'paid', returns the instance
await order.save()

// Filter by label — Attr.set() converts it to 0 before the WHERE
const pending = await Order.where({ status: 'pending' }).load()
```

**Auto-generated helpers from `Attr.enum`:**

| Helper | Description |
|--------|-------------|
| `order.status` | Returns label string |
| `order.isPending()` | True if status === 'pending' |
| `order.toPending()` | Sets status = 'pending', returns instance |
| `order.statusChanged()` | True if status was changed this session |
| `order.statusWas()` | Previous label before the change |

## `Attr.new` — custom transform

Full control over get/set with optional default and validation.

```ts
// schema.ts
export const products = pgTable('products', {
  id:           integer('id').primaryKey().generatedAlwaysAsIdentity(),
  price_cents:  integer('price_cents').notNull(),
})
```

```ts
// models/Product.model.ts
@model('products')
export class Product extends ApplicationRecord {
  // Store as cents, read as dollars
  static priceCents = Attr.new({
    get: (v: number) => v / 100,
    set: (v: number) => Math.round(v * 100),
    default: 0,
    validate: (v: number) => v >= 0 ? null : 'price must be non-negative',
  })
}
```

```ts
const p = await Product.create({ priceCents: 19.99 })  // stored as 1999
p.priceCents   // → 19.99

await Product.where({ priceCents: 19.99 }).load()  // WHERE price_cents = 1999
```

## `Attr.for` — column name remapping

When your TypeScript property name must differ from the DB column name.

```ts
// schema.ts
export const users = pgTable('users', {
  id:   integer('id').primaryKey().generatedAlwaysAsIdentity(),
  role: integer('role').notNull().default(0),   // column is named 'role'
})
```

```ts
// models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  // The TypeScript property 'admin' maps to the DB column 'role'
  static admin = Attr.for('role', {
    get: (v: number) => v === 1,        // role 1 = admin
    set: (v: boolean) => v ? 1 : 0,
  })
}
```

```ts
const u = await User.create({ admin: true })   // INSERT role = 1
u.admin        // → true
u.adminChanged()  // dirty tracking still works
```

## `Attr.string` — string coercion

Trim on write, coerce to string on read.

```ts
@model('users')
export class User extends ApplicationRecord {
  static name = Attr.string({ validate: v => v ? null : 'name is required' })
}
```

## `Attr.integer`

Coerce to `Number` on both sides.

## `Attr.boolean`

Coerce to `Boolean` on both sides.

## `Attr.json` — JSON serialization

Serialises objects for TEXT/VARCHAR columns; passes through for JSONB (driver handles it).

```ts
// schema.ts
export const settings = pgTable('settings', {
  id:   integer('id').primaryKey().generatedAlwaysAsIdentity(),
  data: text('data'),   // stored as JSON string
})
```

```ts
// models/Setting.model.ts
@model('settings')
export class Setting extends ApplicationRecord {
  static data = Attr.json<{ theme: string; notifications: boolean }>()
}
```

```ts
const s = await Setting.create({ data: { theme: 'dark', notifications: true } })
s.data   // → { theme: 'dark', notifications: true }  (parsed object, not string)
```

## `Attr.date` — ISO string ↔ Date

```ts
export const events = pgTable('events', {
  id:       integer('id').primaryKey().generatedAlwaysAsIdentity(),
  startsAt: text('starts_at').notNull(),   // stored as ISO string
})
```

```ts
@model('events')
export class Event extends ApplicationRecord {
  static startsAt = Attr.date()
}
```

```ts
const ev = await Event.create({ startsAt: '2025-06-01' })
ev.startsAt            // → Date object
ev.startsAt.getFullYear()  // → 2025
```

## `Attr.decimal` — full-precision decimals

Store as string (full precision), read as number. Use for money or rates where floating-point drift matters.

```ts
export const rates = pgTable('rates', {
  id:   integer('id').primaryKey().generatedAlwaysAsIdentity(),
  rate: text('rate').notNull(),   // e.g. '0.0825'
})
```

```ts
@model('rates')
export class Rate extends ApplicationRecord {
  static rate = Attr.decimal()
}
```

```ts
const r = await Rate.create({ rate: 0.0825 })
r.rate          // → 0.0825 (number)
typeof r.rate   // 'number'
```

## `Attr.int` — strict integers

Unlike `Attr.integer` (lenient `Number()` coercion), `Attr.int` **rejects** non-integers at the assignment site — a float can never reach an integer column:

```ts
static quantity = Attr.int()

order.quantity = 3      // ✓
order.quantity = '12'   // ✓ numeric strings accepted
order.quantity = 3.5    // ✗ throws TypeError immediately
```

## `Attr.money` — integer cents ↔ decimal dollars

The column stores integer minor units (never floats); the model speaks major units:

```ts
export const products = pgTable('products', {
  priceCents: integer('price_cents'),
  currency:   varchar('currency', { length: 3 }),
})
```

```ts
static price = Attr.money('priceCents', { currency: 'currency' })
```

```ts
product.price = 19.99          // stored as 1999
product.price                  // → 19.99
product.priceFormatted()       // → '€19.99' — reads the row's own currency column
product.priceFormatted('de-DE') // → '19,99 €'
```

The `currency` option is optional — without it, `priceFormatted()` formats as USD. Because `Attr.money` rides the same column mapping as `Attr.for`, queries work in model units against the raw column: `Product.where({ price: ... })` and `pluck('price')` apply the transform automatically.

Multi-currency guidance: keep amounts in a `*_cents` integer column and the ISO code in its own `currency` column (the classic Rails `money-rails` layout). Never mix currencies in aggregate SQL without grouping by the currency column.

## `Attr.percent` — fraction in the DB, percent on the model

The database stores the mathematically honest fraction (0–1, aggregation-friendly); the model speaks human percent (0–100):

```ts
static conversionRate = Attr.percent()   // column: doublePrecision()

funnel.conversionRate = 15.3   // stored as 0.153
funnel.conversionRate          // → 15.3
```

SQL like `avg(conversion_rate)` stays fraction-math; every model read/write is already in display units.

## `Attr.bps`, `Attr.multiple`, `Attr.days` — domain kinds

Small, strict constructors for recurring financial/temporal shapes. Each is a
**kind marker** for presenters plus honest coercion:

```ts
static spread   = Attr.bps()        // integer basis points — '250 bps'
static leverage = Attr.multiple()   // string-backed numeric ratio — '2.5x'
static termDays = Attr.days()       // integer day count — '90 days'
```

`bps` and `days` reject non-integers at assignment (like `Attr.int`);
`multiple` stores full-precision strings (like `Attr.decimal`).

## Presentational meta — the field describes itself

Every `Attr.*` accepts presentational metadata: pure data about the field,
extracted at build time and shipped to generated Clients. The backend model
becomes the single source of labels, help text, and per-variant copy.

```ts
static amount = Attr.money('amountCents', {
  label: 'Requested Loan Amount',
  help:  'Enter the total loan amount you are seeking.',
  info:  'This figure is shared with lenders after submission.',

  copy: {                          // per-discriminant overrides
    by: 'facilityType',            // must name an enum/state Attr on this model
    REVOLVING_CREDIT: { label: 'Requested Facility Size' },
  },

  presentIf:  (r) => r.purpose !== 'NEW',   // pure record-predicates
  requiredIf: (r) => r.purpose !== 'NEW',
  lockedIf:   (r) => r.isArchived(),        // record STATE only — never roles

  presenters: { view: 'moneyText', edit: 'moneyInput' },  // default presenter names

  meta: { icon: 'dollar', priority: 1 },    // open extension bag — yours
})
```

The rules, all enforced by codegen (fail-closed):

- **`label` / `help` / `info` must be string literals** — computed values
  can't be extracted for the client and fail the build.
- **`copy.by` must name an enum/state Attr** on the model, and override keys
  must be its labels. Typos are build errors, not silent fallbacks.
- **Predicates are dep-inferred** like `@validate` bodies. Unprovable ⇒ build
  error. A predicate reading something that isn't a model field (a role, a
  user) is a build error with a pointed message: role/identity conditions
  live on the controller.
- **`meta:` is an open bag for your app's keys** — static data only
  (functions or references fail the build). Type your custom keys once via
  declaration merging:

  ```ts
  declare module '@active-drizzle/core' {
    interface AttrCustomMeta { regulatoryDisclosure?: string }
  }
  ```

Generated Clients expose it all as `static fieldMeta` — filtered to each
controller's [projection](/controllers/abilities), with predicates included
only when their deps fit it.

## Ranges, multiranges, and arrays

First-class support for Postgres' exotic types. Ranges parse the wire literal into a structured object:

```ts
static seats        = Attr.range()          // int4range / numrange
static bookedDuring = Attr.dateRange()      // tstzrange — bounds are JS Dates
static targetRate   = Attr.percentRange()   // numrange of fractions, percent on the model
static availability = Attr.multirange()     // nummultirange (PG 14+)
static tags         = Attr.array()          // text[] etc.
```

```ts
venue.seats                    // → { lower: 1, upper: 10, lowerInclusive: true, upperInclusive: false }
venue.seats = { lower: 5, upper: 20, lowerInclusive: true, upperInclusive: false }  // → '[5,20)'

campaign.targetRate = { lower: 2.5, upper: 10, lowerInclusive: true, upperInclusive: false }
// stored as '[0.025,0.1)' — fraction math in SQL, percent at the model

room.availability              // → [{ lower: 1, upper: 3, ... }, { lower: 5, upper: 8, ... }]

post.tags = ['a', 'b']         // JS arrays pass through to the driver natively
Attr.array({ element: Number }) // per-element coercion: '{1,2}' → [1, 2]
```

Unbounded sides are `null` (`'[3,)'` → `{ lower: 3, upper: null }`), and PG's `'empty'` range maps to `{ isEmpty: true }`. A `rangeIncludes(range, value)` helper is exported for inclusivity-correct containment checks.

## Defaults

Every `Attr.*` method accepts a `default` option. The default is applied when reading a field on a **new** record that hasn't been set yet:

```ts
static status = Attr.enum({ draft: 0, published: 1 } as const, { default: 0 })
// or
static status = { ...Attr.enum({ draft: 0, published: 1 } as const), default: 0 }
```

Defaults can also be factory functions:

```ts
static tags = Attr.json<string[]>({ default: () => [] })
```
