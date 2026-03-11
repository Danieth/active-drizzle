# Querying Basics

All queries start from a static method on your model and return a `Relation<T>` — a chainable, lazy query builder that doesn't hit the database until you call `.load()`, `.first()`, `.find()`, or another terminal method.

## Finding a single record

### `find(id)` — by primary key, throws if missing

```ts
const user = await User.find(1)
// Throws RecordNotFound if no user with id=1 exists
```

```ts
try {
  const user = await User.find(99999)
} catch (e) {
  if (e instanceof RecordNotFound) {
    console.log(e.message)  // "User with id=99999 not found"
  }
}
```

### `findBy(conditions)` — returns `null` if missing

```ts
const user = await User.findBy({ email: 'alice@example.com' })
// null if not found — no exception
```

### `first()` / `firstBang()`

```ts
const oldest = await User.order('createdAt', 'asc').first()
// null if table is empty

const required = await User.order('createdAt', 'asc').firstBang()
// throws RecordNotFound if empty
```

### `last()` / `lastBang()`

```ts
const newest = await User.last()        // most recently created
const recent3 = await User.last(3)      // array of last 3
```

### `take(n?)`

Returns the first N records (no ordering imposed):

```ts
const sample = await User.take()     // one record
const five   = await User.take(5)    // up to 5 records
```

---

## Loading collections

### `load()` — all matching records

```ts
const users = await User.where({ active: true }).load()
// → User[]
```

### `all()`

Alias for `load()` with no conditions:

```ts
const users = await User.all()
```

---

## Filtering with `where`

```ts
// Simple equality
User.where({ role: 'admin' })

// Multiple conditions (AND)
User.where({ role: 'admin', active: true })

// Array → IN (…)
User.where({ id: [1, 2, 3] })

// null → IS NULL
Post.where({ publishedAt: null })

// Raw Drizzle SQL expression
import { sql } from 'drizzle-orm'
Post.where(sql`char_length(title) > 100`)

// Drizzle operators
import { gt, lt, ilike } from 'drizzle-orm'
Product.where(gt(schema.products.priceCents, 1000))
User.where(ilike(schema.users.email, '%@gmail.com'))
```

`where` is composable — call it multiple times for AND:

```ts
const results = await Post
  .where({ published: true })
  .where({ userId: currentUser.id })
  .load()
```

---

## Ordering

```ts
User.order('name')                    // ASC by default
User.order('createdAt', 'desc')       // DESC
User.order('role', 'asc').order('name', 'asc')  // multiple
```

---

## Limit & offset

```ts
User.limit(10)
User.limit(10).offset(20)            // page 3 of 10
```

---

## Find-or- patterns

### `findOrInitializeBy`

Returns the existing record or a new (unsaved) instance:

```ts
const user = await User.findOrInitializeBy({ email: 'bob@example.com' })
user.isNewRecord   // true if not found, false if found
await user.save()  // only inserts if new
```

### `findOrCreateBy`

Returns the existing record or creates a new one:

```ts
const [user, created] = await User.findOrCreateBy({ email: 'bob@example.com' })
created   // true if a new record was created
```

---

## Batch iteration with `findEach`

Process large result sets without loading everything into memory:

```ts
await User.where({ active: true }).findEach(100, async (user) => {
  await sendEmail(user.email)
})
// Fetches 100 records at a time, calls callback for each
```

---

## None — empty scope

Returns an empty `Relation` that **never hits the database**:

```ts
const results = await User.none().load()       // []
const count   = await User.none().count()      // 0
const exists  = await User.none().exists()     // false
```

Useful when conditionally building queries:

```ts
function getUsers(adminOnly: boolean) {
  if (adminOnly && !currentUser.isAdmin()) return User.none()
  return User.all()
}
```

---

## Subqueries

Use a `Relation` as a value in another `where` — it becomes a `SELECT` subquery:

```ts
const activeUserIds = User.where({ active: true }).toSubquery('id')

const posts = await Post
  .where({ userId: activeUserIds })
  .load()
// WHERE user_id IN (SELECT id FROM users WHERE active = true)
```

---

## Locking rows

```ts
await Post.transaction(async () => {
  const post = await Post.where({ id: 1 }).withLock(async (rel) => {
    return rel.first()
  })
  // Row is locked FOR UPDATE within the transaction
})
```
