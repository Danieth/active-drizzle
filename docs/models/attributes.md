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
