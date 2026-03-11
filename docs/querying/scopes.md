# Scopes

Scopes are named, chainable query fragments declared as static methods on your model.

## Defining a scope

```ts
// schema.ts
export const posts = pgTable('posts', {
  id:          integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title:       text('title').notNull(),
  published:   boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at'),
  userId:      integer('user_id').notNull(),
})
```

```ts
// models/Post.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model, scope }      from 'active-drizzle'
import { sql }               from 'drizzle-orm'

@model('posts')
export class Post extends ApplicationRecord {
  @scope
  static published() {
    return this.where({ published: true })
  }

  @scope
  static recent() {
    return this.order('publishedAt', 'desc')
  }

  @scope
  static forUser(userId: number) {
    return this.where({ userId })
  }

  @scope
  static since(date: Date) {
    return this.where(sql`published_at > ${date}`)
  }
}
```

```ts
// Use scopes
const posts = await Post.published().recent().limit(10).load()
const mine  = await Post.published().forUser(currentUser.id).load()
const fresh = await Post.since(new Date('2025-01-01')).load()
```

The `@scope` decorator is optional at runtime but required for **codegen** to include the scope in generated type definitions.

## Chaining scopes

Every scope returns a `Relation`, so they chain with `where`, `order`, `limit`, `includes`, etc.:

```ts
const results = await Post
  .published()
  .forUser(42)
  .since(new Date('2025-01-01'))
  .includes('author')
  .order('createdAt', 'desc')
  .limit(20)
  .offset(0)
  .load()
```

## Default scope (STI)

For STI subclasses, the `WHERE type = 'X'` clause is applied as an implicit default scope. You don't write it — it's automatic:

```ts
// DigitalProduct.all() always has WHERE type = 'DigitalProduct'
```

## Computed scopes with `@computed`

Use `@computed` for aggregates or derived values that return plain data (not a `Relation`):

```ts
import { computed } from 'active-drizzle'

@model('orders')
export class Order extends ApplicationRecord {
  @computed
  static async totalRevenue(): Promise<number> {
    return this.sum('totalCents')
  }

  @computed
  static async revenueByStatus() {
    return this.tally('status')
  }
}
```

```ts
const revenue = await Order.totalRevenue()
const breakdown = await Order.revenueByStatus()
```

The `@computed` decorator signals to codegen that this method returns plain data, not a chainable `Relation`.

## Scope composition across models

Scopes return a `Relation` from `this`, so you can safely extend them in subclasses:

```ts
// models/AdminPost.model.ts
@model('posts')
export class AdminPost extends Post {
  static stiType = 'AdminPost'

  @scope
  static flagged() {
    return this.where({ flagged: true })
  }
}

// AdminPost.published().flagged() works — both scopes apply
```
