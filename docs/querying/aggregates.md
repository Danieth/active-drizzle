# Aggregates & Counting

All aggregate methods are terminal — they execute the query immediately and return a value.

## `count()`

```ts
const total  = await User.count()                     // all users
const admins = await User.where({ role: 'admin' }).count()
```

## `sum(column)`

```ts
// schema.ts
export const orders = pgTable('orders', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  totalCents: integer('total_cents').notNull(),
})
```

```ts
const totalRevenue = await Order.sum('totalCents')
// → number (raw DB value, no Attr.get transform applied)

const userRevenue = await Order
  .where({ userId: 42 })
  .sum('totalCents')
```

## `average(column)`

```ts
const avgOrder = await Order.average('totalCents')    // → number | null
```

## `minimum(column)` / `maximum(column)`

```ts
const cheapest   = await Product.minimum('priceCents')
const mostExpensive = await Product.maximum('priceCents')
```

## `exists()` / `any()` / `empty()`

```ts
const hasUsers  = await User.exists()                         // → boolean
const hasAdmins = await User.where({ role: 'admin' }).exists()

// any() and empty() are convenience aliases
const hasAdmins = await User.where({ role: 'admin' }).any()   // true if 1+
const isEmpty   = await User.where({ role: 'admin' }).empty() // true if 0
```

## `one()` / `many()`

```ts
// Exactly one match
const isUnique = await User.where({ email: 'alice@example.com' }).one()  // → boolean

// More than one match
const hasDuplicates = await User.where({ name: 'Bob' }).many()  // → boolean
```

## `tally(column)` — group counts

Returns a `Record<string, number>` counting how many rows have each unique value of a column:

```ts
// schema.ts
export const orders = pgTable('orders', {
  id:     integer('id').primaryKey().generatedAlwaysAsIdentity(),
  status: integer('status').notNull(),   // Attr.enum applied on the model
})
```

```ts
// models/Order.model.ts
@model('orders')
export class Order extends ApplicationRecord {
  static status = Attr.enum({ pending: 0, paid: 1, shipped: 2, cancelled: 3 } as const)
}
```

```ts
const counts = await Order.tally('status')
// → { pending: 12, paid: 45, shipped: 30, cancelled: 3 }
// Labels come from Attr.enum.get() — the tally is human-readable
```

For plain string columns:

```ts
const counts = await User.tally('country')
// → { US: 124, UK: 38, CA: 22, ... }
```

## `ids()`

Returns an array of all primary key values:

```ts
const userIds = await User.where({ active: true }).ids()
// → [1, 2, 5, 12, ...]
```

For composite PKs, returns objects:

```ts
const membershipIds = await Membership.ids()
// → [{ tenantId: 1, userId: 42 }, ...]
```
