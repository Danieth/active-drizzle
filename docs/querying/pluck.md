# Pluck & Pick

Both methods extract raw column values without instantiating model objects — fast and allocation-efficient.

## `pluck(...columns)`

Returns an array of values (single column) or an array of objects (multiple columns). `Attr.get` transforms are applied.

```ts
// schema.ts
export const products = pgTable('products', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name:       text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
})
```

```ts
// models/Product.model.ts
@model('products')
export class Product extends ApplicationRecord {
  static priceCents = Attr.new({
    get: (v: number) => v / 100,
    set: (v: number) => Math.round(v * 100),
  })
}
```

```ts
// Single field → flat array
const names = await Product.pluck('name')
// → ['Widget', 'Gadget', 'Doohickey']

// With Attr.get transform applied
const prices = await Product.pluck('priceCents')
// → [9.99, 19.99, 49.99]   ← dollars, not cents

// Multiple fields → array of objects
const items = await Product.pluck('id', 'name', 'priceCents')
// → [{ id: 1, name: 'Widget', priceCents: 9.99 }, ...]

// Chain with where/order/limit
const cheapNames = await Product
  .where({ published: true })
  .order('priceCents', 'asc')
  .limit(5)
  .pluck('name')
```

## `pick(...columns)` — first record only

Like `pluck` but returns a single row's values instead of an array:

```ts
const [name, price] = await Product.order('priceCents', 'asc').pick('name', 'priceCents')
// → ['Widget', 9.99]

// Single field
const cheapestName = await Product.order('priceCents', 'asc').pick('name')
// → 'Widget'
```

---

## Nested pluck

Pluck fields from associated models in a **single SQL query** — no N+1.

### Setup: Drizzle `relations()` required

For nested pluck to work, you must define Drizzle `relations()` in your schema file:

```ts
// schema.ts
import { pgTable, integer, text, relations } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
  name:  text('name').notNull(),
})

export const orders = pgTable('orders', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  totalCents: integer('total_cents').notNull(),
  userId:     integer('user_id').notNull().references(() => users.id),
})

// ← these are required for nested pluck and includes()
export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
}))

export const ordersRelations = relations(orders, ({ one }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
}))
```

```ts
// models/Order.model.ts
@model('orders')
export class Order extends ApplicationRecord {
  static totalCents = Attr.new({
    get: (v: number) => v / 100,
    set: (v: number) => Math.round(v * 100),
  })
  static user = belongsTo()
}
```

### Dot-path syntax

```ts
// 'user.email' plucks the email from the related user
const results = await Order.pluck('id', 'user.email')
// → [{ id: 1, 'user.email': 'alice@example.com' }, ...]

// Single nested path → flat values
const emails = await Order.pluck('user.email')
// → ['alice@example.com', 'bob@example.com', ...]

// Attr transforms are applied on the nested side too
const prices = await Order.pluck('totalCents', 'user.email')
// → [{ totalCents: 99.99, 'user.email': 'alice@example.com' }, ...]
//   totalCents is in dollars (Attr.get applied)
```

### Scoped nested pluck

```ts
// Pluck from orders where total > $100, plus the user's email
const bigOrders = await Order
  .where({ userId: 42 })
  .order('totalCents', 'desc')
  .limit(10)
  .pluck('id', 'totalCents', 'user.email')
```

### Multiple associations

```ts
// schema.ts also has line_items → orders, products → line_items
const details = await LineItem.pluck('qty', 'order.id', 'product.name')
// → [{ qty: 2, 'order.id': 1, 'product.name': 'Widget' }, ...]
```

### Null association

If the association is null (e.g. a nullable `belongsTo`), the nested field returns `null`:

```ts
const result = await Post.pluck('id', 'category.name')
// → [{ id: 1, 'category.name': 'Tech' }, { id: 2, 'category.name': null }]
```

::: info One query, always
Nested pluck uses Drizzle's `findMany({ columns, with })` — a single SQL query with joins/lateral selects. It never generates N+1 queries regardless of result set size.
:::
