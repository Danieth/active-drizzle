# Querying Basics

ActiveDrizzle provides a rich, chainable query interface for retrieving records from the database. If you've used Rails' Active Record Query Interface, this will feel familiar — but everything is TypeScript-native, fully typed, and built on top of Drizzle ORM.

All queries start from a static method on your model class and return a **`Relation`** — a lazy, chainable query builder. Nothing hits the database until you call a terminal method like `.load()`, `.first()`, `.find()`, or `.count()`.

After reading this guide you will know how to:

- Retrieve single records and collections
- Filter, sort, limit, and offset results
- Eager-load associations to avoid N+1 queries
- Chain conditions for AND/OR logic
- Use subqueries, locking, and batch iteration
- Avoid hitting the database entirely with `none()`

---

## 1. Retrieving a Single Record

### `find(id)` — by primary key, raises if missing

The most common way to fetch a known record. If the record doesn't exist, `RecordNotFound` is thrown — this mirrors Rails behavior exactly.

```ts
const user = await User.find(1)
// → User instance
// → throws RecordNotFound('User with id=1 not found') if missing
```

```ts
try {
  const user = await User.find(99999)
} catch (e) {
  if (e instanceof RecordNotFound) {
    console.log(e.message)   // "User with id=99999 not found"
  }
}
```

Use `find()` when you expect the record to exist and its absence is an error condition — like loading a resource by URL param. The controller integration auto-converts `RecordNotFound` to a 404 response so you rarely need to catch it manually.

### `findBy(conditions)` — returns `null` if missing

Use when the record might not exist and that's a normal state:

```ts
const user = await User.findBy({ email: 'alice@example.com' })
// → User | null

const admin = await User.findBy({ role: 'admin', active: true })
// → first matching record, or null

// Multiple conditions — AND logic
const post = await Post.findBy({ userId: 42, published: true })
```

`findBy` always returns the **first** matching record. If ordering matters, use `where(...).order(...).first()` instead.

### `first()` / `firstBang()`

```ts
const oldest = await User.order('createdAt', 'asc').first()
// → User | null (if table is empty)

const required = await User.order('createdAt', 'asc').firstBang()
// → User, or throws RecordNotFound if empty
```

`first()` without ordering returns an arbitrary record (undefined order from the database). Always specify an order if the result must be deterministic.

### `last()` / `lastBang()`

```ts
const newest = await User.last()         // most recently created (assumes id order)
const recent3 = await User.last(3)       // array of last 3

// Chain
const latestAdmin = await User.where({ role: 'admin' }).last()
```

### `take(n?)`

Returns records in undefined database order — useful for sampling or when order doesn't matter:

```ts
const any    = await User.take()     // one record
const five   = await User.take(5)    // up to 5 records (array)
```

---

## 2. Retrieving Collections

### `all()`

All records in the table, unordered:

```ts
const users = await User.all()
// → User[]
```

In practice, always pair this with `order` and `limit` for production code.

### `load()`

Terminal method for any `Relation` chain. Equivalent to calling `all()` on a filtered/sorted chain:

```ts
const users = await User
  .where({ active: true })
  .order('name', 'asc')
  .limit(25)
  .load()
// → User[]
```

---

## 3. Conditions — `where`

`where` is the core filtering method. It accepts hash conditions, raw SQL, or Drizzle operators.

### Hash conditions

```ts
// Equality
User.where({ role: 'admin' })
// WHERE role = 1  (Attr.enum converts label → value)

// Multiple fields (AND)
User.where({ role: 'admin', active: true })
// WHERE role = 1 AND active = true

// Array → IN (…)
User.where({ id: [1, 2, 3] })
// WHERE id IN (1, 2, 3)

// null → IS NULL
Post.where({ publishedAt: null })
// WHERE published_at IS NULL
```

### Drizzle operators

For comparisons, LIKE, and other SQL operators, use Drizzle's helper functions:

```ts
import { gt, lt, gte, lte, ne, ilike, like, isNull, isNotNull, or, and, inArray } from 'drizzle-orm'
import * as schema from './schema.js'

// Greater than
Product.where(gt(schema.products.priceCents, 1000))
// WHERE price_cents > 1000

// ILIKE (case-insensitive)
User.where(ilike(schema.users.email, '%@gmail.com'))

// OR condition
Post.where(or(
  schema.posts.status.equals(1),
  schema.posts.featured.equals(true)
))
```

### Raw SQL

For anything complex, use Drizzle's `sql` tag:

```ts
import { sql } from 'drizzle-orm'

Post.where(sql`char_length(title) > 100`)
Post.where(sql`published_at > NOW() - INTERVAL '7 days'`)
User.where(sql`lower(email) = ${email.toLowerCase()}`)
```

### Chaining `where` (AND)

Multiple `where` calls combine with AND:

```ts
const results = await Post
  .where({ published: true })
  .where({ userId: currentUser.id })
  .where(sql`published_at > ${thirtyDaysAgo}`)
  .load()
// WHERE published = true AND user_id = ? AND published_at > ?
```

---

## 4. Ordering

```ts
User.order('name')                              // ASC by default
User.order('createdAt', 'desc')                 // DESC
User.order('role', 'asc').order('name', 'asc')  // multiple columns
```

Ordering with Drizzle expressions:

```ts
import { desc, asc } from 'drizzle-orm'

User.order(desc(schema.users.createdAt))
Product.order(asc(schema.products.priceCents)).order(asc(schema.products.name))
```

---

## 5. Limit & Offset

```ts
User.limit(10)                // first 10 records
User.limit(10).offset(20)    // records 21–30 (page 3 of 10)

// Pagination helper
const page    = 2
const perPage = 25
const users   = await User
  .order('createdAt', 'desc')
  .limit(perPage)
  .offset((page - 1) * perPage)
  .load()
```

---

## 6. Eager Loading — `includes`

`includes` loads associations in a single query (using Drizzle's relational `findMany`), eliminating N+1 queries.

::: warning The N+1 problem
Without eager loading, accessing `post.author` in a loop fires one query per post:
```ts
const posts = await Post.all()
for (const post of posts) {
  const author = await post.author   // 1 query per post = N+1
}
```
With `includes`, all authors are fetched in a single query.
:::

```ts
// Single association
const posts = await Post.includes('author').load()
posts[0].author   // resolved — no extra query

// Multiple associations
const posts = await Post.includes('author', 'tags', 'comments').load()

// Nested associations
const users = await User.includes({ posts: ['comments', 'tags'] }).load()
users[0].posts[0].comments   // deeply loaded

// Deeply nested
const teams = await Team.includes({
  members: { posts: ['comments'] }
}).load()
```

For `includes` to work on nested associations, you must define Drizzle `relations()` in your schema. See the [Associations](/models/associations) guide.

---

## 7. Selecting Specific Columns

By default, all columns are selected. To select only specific columns (reduces data transfer):

```ts
const ids = await User.where({ active: true }).select('id', 'email').load()
// → [{ id: 1, email: 'alice@example.com' }, ...]
// Returned objects are plain objects, not model instances
```

::: tip Use `pluck` for flat arrays
If you only need values (not objects), use `.pluck('id')` → `[1, 2, 5, ...]`. See [Pluck & Pick](/querying/pluck).
:::

---

## 8. Find-or-Patterns

### `findOrInitializeBy`

Returns the existing record, or a new unsaved instance if none matches:

```ts
const [user, isNew] = await User.findOrInitializeBy({ email: 'bob@example.com' })
// isNew = true if not found in DB

user.isNewRecord   // true if not found
user.name = 'Bob'
await user.save()  // inserts if new, no-op if existing
```

### `findOrCreateBy`

Finds or creates atomically:

```ts
const [tag, created] = await Tag.findOrCreateBy({ name: 'typescript' })
// created = true if a new record was inserted

if (created) {
  console.log('New tag created!')
}
```

`findOrCreateBy` wraps in a transaction internally. If two requests race, one will win and the other will find the newly created record.

---

## 9. Subqueries

Use a `Relation` as a value in a `where` — it becomes a correlated `SELECT` subquery:

```ts
const activeUserIds = User.where({ active: true }).toSubquery('id')
// Becomes: SELECT id FROM users WHERE active = true

const posts = await Post
  .where({ userId: activeUserIds })
  .load()
// WHERE user_id IN (SELECT id FROM users WHERE active = true)
```

Subqueries are evaluated server-side in a single round-trip — no fetching of intermediate results.

---

## 10. `none` — The Empty Relation

`none()` returns a `Relation` that never hits the database and always returns empty results. It satisfies the same chainable interface as a real relation.

```ts
const results = await User.none().load()       // []
const count   = await User.none().count()      // 0
const exists  = await User.none().exists()     // false
```

This is useful for conditionally building queries without branching logic:

```ts
function getPostsForUser(user: User, adminMode: boolean) {
  if (!adminMode && !user.isEditor()) {
    return Post.none()   // caller gets an empty relation, no DB hit
  }
  return Post.where({ userId: user.id })
}

// Usage
const posts = await getPostsForUser(currentUser, false).limit(10).load()
```

---

## 11. Batch Iteration — `findEach`

Process large datasets without loading everything into memory:

```ts
// Fetch 100 records at a time, call the callback for each
await User.where({ active: true }).findEach(100, async (user) => {
  await sendEmail(user.email)
})
```

`findEach` uses keyset pagination internally (not OFFSET) — it's efficient even on tables with millions of rows. The callback is called once per record. If the callback throws, iteration stops.

---

## 12. Row Locking — `withLock`

Lock rows for concurrent access patterns within a transaction:

```ts
await Order.transaction(async () => {
  const order = await Order
    .where({ id: 1 })
    .withLock(async (rel) => rel.first())
  // Row is locked with FOR UPDATE
  // Safe to update without concurrent modifications

  if (order && order.isPayable()) {
    await order.update({ status: 'processing' })
  }
})
```

`withLock` must be called inside a `transaction()` block — it throws an error if there's no active transaction.

---

## 13. `toSubquery(column?)` — Using a Relation as a Subquery

Convert a `Relation` into a raw SQL subquery value for use in another condition:

```ts
const premiumTeamIds = Team
  .where({ plan: 'enterprise' })
  .toSubquery('id')

const users = await User
  .where({ teamId: premiumTeamIds })
  .load()
// WHERE team_id IN (SELECT id FROM teams WHERE plan = 'enterprise')
```

---

## 14. Relation Method Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `.where(conditions)` | `Relation` | Add conditions (AND) |
| `.order(field, dir?)` | `Relation` | Order results |
| `.limit(n)` | `Relation` | Cap result count |
| `.offset(n)` | `Relation` | Skip N records |
| `.includes(...assocs)` | `Relation` | Eager-load associations |
| `.select(...cols)` | `Relation` | Select specific columns |
| `.none()` | `Relation` | Empty relation (no DB hit) |
| `.load()` | `Promise<T[]>` | Execute → array |
| `.all()` | `Promise<T[]>` | Execute → array (alias) |
| `.first()` | `Promise<T \| null>` | First record or null |
| `.firstBang()` | `Promise<T>` | First or throws |
| `.last(n?)` | `Promise<T \| T[]>` | Last record(s) |
| `.take(n?)` | `Promise<T \| T[]>` | Arbitrary records |
| `.find(id)` | `Promise<T>` | By PK, throws if missing |
| `.findBy(cond)` | `Promise<T \| null>` | First match or null |
| `.count()` | `Promise<number>` | Row count |
| `.exists()` | `Promise<boolean>` | Any rows? |
| `.sum(col)` | `Promise<number>` | Sum of column |
| `.average(col)` | `Promise<number>` | Average of column |
| `.pluck(...cols)` | `Promise<values>` | Raw column values |
| `.ids()` | `Promise<id[]>` | All primary keys |
| `.tally(col)` | `Promise<Record<string,number>>` | Count by value |
| `.findEach(batchSize, fn)` | `Promise<void>` | Batch iteration |
| `.withLock(fn)` | `Promise<T>` | Lock row in transaction |
| `.toSubquery(col?)` | SQL value | Use as IN subquery |
| `.destroyAll()` | `Promise<void>` | Delete with hooks |
| `.deleteAll()` | `Promise<void>` | Raw DELETE, no hooks |
| `.updateAll(attrs)` | `Promise<void>` | Raw UPDATE, no hooks |

---

## 15. How Queries Are Built

Understanding the `Relation` pipeline helps with debugging:

1. Every static call (`User.where(...)`, `User.order(...)`) creates a new `Relation` describing the query
2. `Relation` objects are **immutable** — chaining creates a new instance each time
3. On `.load()`, the `Relation` compiles to a Drizzle `findMany()` or `select()` call
4. Drizzle compiles that to parameterized SQL and sends it to Postgres
5. Results are mapped through `Attr.get` transforms and wrapped in the model Proxy

This means you can build queries lazily, store partial queries in variables, and compose them safely:

```ts
// Build a base query — nothing hits the DB yet
const base = User.where({ active: true }).order('name', 'asc')

// Extend it differently based on context
const admins  = base.where({ role: 'admin' })
const members = base.where({ role: 'member' }).limit(100)

// Execute only when needed
const [adminList, memberList] = await Promise.all([
  admins.load(),
  members.load(),
])
```
