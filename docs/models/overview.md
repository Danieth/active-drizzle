# Models Overview

Models are the heart of ActiveDrizzle. A model class represents a database table, encapsulates the business logic for that resource, and is the interface through which all reads and writes flow. If you've used Rails' ActiveRecord, the concepts will feel immediately familiar — but everything here is TypeScript-native, type-safe, and builds on top of Drizzle ORM.

After reading this guide, you will understand:

- How your Drizzle schema and model class relate to each other
- How to define a model and what the `@model` decorator does
- How to perform basic CRUD operations
- What a `Relation` is and how querying works
- How associations, scopes, validations, and lifecycle hooks fit together
- How codegen extends the model for the frontend

---

## 1. What is a Model?

A model is a TypeScript class that extends `ApplicationRecord`. It maps to exactly one database table (defined in your Drizzle schema), and it knows how to:

- **Read**: find records, filter them, sort them, eagerly load associations
- **Write**: create, update, and destroy records
- **Validate**: enforce business rules before writing
- **Transform**: convert raw DB values to TypeScript values (and back)
- **React**: run code before and after writes via lifecycle hooks

The Drizzle schema is the **source of truth for structure** (column names, types, constraints, nullability). The model is the **source of truth for behavior** (scopes, validations, hooks, virtual attributes, associations).

You never write SQL. You write TypeScript that reads like English.

---

## 2. Setup

### Your Drizzle Schema

ActiveDrizzle reads your existing Drizzle schema. There's nothing special to add — just define your tables normally:

```ts
// db/schema.ts
import { pgTable, serial, integer, varchar, text, timestamp, boolean } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id:        serial('id').primaryKey(),
  email:     varchar('email', { length: 255 }).notNull().unique(),
  name:      varchar('name', { length: 255 }).notNull(),
  role:      integer('role').notNull().default(0),  // 0 = member, 1 = admin
  active:    boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const posts = pgTable('posts', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }).notNull(),
  body:        text('body'),
  userId:      integer('user_id').notNull().references(() => users.id),
  published:   boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at'),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
})
```

### Boot

Call `boot()` once at startup, passing your Drizzle database client and the schema object:

```ts
// server.ts
import { boot } from 'active-drizzle'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './db/schema.js'
import './models/index.js'  // ← side-effect import — registers all models

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db   = drizzle({ client: pool, schema })

boot(db, schema)
```

`boot()` binds the database executor to the global context. After this, any model can execute queries without needing to pass a `db` reference around.

### Registering Models

Models register themselves via the `@model` decorator at import time. You need to make sure every model file is imported at startup:

```ts
// models/index.ts
export { User } from './User.model.js'
export { Post } from './Post.model.js'
export { Comment } from './Comment.model.js'
// ... every model your app uses
```

---

## 3. Defining a Model

The minimal model is just a class with the `@model` decorator:

```ts
// models/User.model.ts
import { ApplicationRecord, model } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {}
```

That's it. You now have full CRUD, querying, associations, and lifecycle support for the `users` table:

```ts
const user = await User.create({ email: 'alice@example.com', name: 'Alice', role: 0 })
const found = await User.find(user.id)
await user.update({ name: 'Alice Smith' })
await user.destroy()
```

The `@model('users')` decorator does two things:

1. Binds the class to its Drizzle table (the key must match what's in your schema object exactly)
2. Registers the class in the global `MODEL_REGISTRY`, used for association resolution and STI

### Column Access

Columns map directly to properties on the model instance. The column name convention is camelCase in TypeScript, matching Drizzle's convention:

```ts
const user = await User.find(1)
user.id           // number
user.email        // string
user.name         // string
user.active       // boolean
user.createdAt    // Date
user.updatedAt    // Date
```

Types are inferred from your Drizzle schema via codegen — `.gen.d.ts` files are generated alongside your model files and extend the class with the correct types.

---

## 4. Reading Records

All queries start from a static method on your model class and return a **`Relation`** — a lazy, chainable query builder. Nothing hits the database until you call a terminal method like `.load()`, `.first()`, or `.find()`.

### Finding by ID

```ts
// find(id) — throws RecordNotFound if missing
const user = await User.find(1)

// findBy — returns null if missing
const user = await User.findBy({ email: 'alice@example.com' })

// findBy with multiple conditions
const admin = await User.findBy({ role: 1, active: true })
```

`find()` raises `RecordNotFound` if no record matches the primary key. This mirrors Rails behavior exactly — use `findBy()` when absence is an expected state, and `find()` when you expect the record to exist.

### Collections

```ts
// All records
const users = await User.all()

// Filtered
const admins  = await User.where({ role: 1 }).load()
const actives = await User.where({ active: true }).load()

// Multiple conditions (AND)
const result  = await User.where({ role: 1, active: true }).load()

// first() / last()
const newest = await User.order('createdAt', 'desc').first()
const oldest = await User.order('createdAt', 'asc').first()
```

### Chaining

Relation methods are chainable and combine with AND semantics:

```ts
const results = await User
  .where({ active: true })
  .where({ role: 1 })
  .order('name', 'asc')
  .limit(20)
  .offset(0)
  .load()
```

See [Querying Basics](/querying/basics) for the complete query reference.

---

## 5. Saving Records

### Creating

```ts
// Create and return the saved record
const user = await User.create({
  email: 'alice@example.com',
  name: 'Alice',
  role: 0,
})

// Build first, save later
const user = new User()
user.email = 'bob@example.com'
user.name  = 'Bob'
await user.save()
user.isNewRecord  // false after save
```

`User.create()` raises a `ValidationError` if the record is invalid. `save()` returns `true` or `false` — check `user.errors` when it returns `false`.

### Updating

```ts
// Update specific fields
await user.update({ name: 'Alice Smith', role: 1 })

// Assign then save (only changed columns are sent)
user.name = 'Alice Smith'
await user.save()

// Bulk update (no hooks)
await User.where({ active: false }).updateAll({ role: 0 })
```

### Destroying

```ts
await user.destroy()
user.isDestroyed  // true

// Bulk destroy (hooks run for each record)
await User.where({ active: false }).destroyAll()

// Raw DELETE (no hooks, faster)
await User.where({ active: false }).deleteAll()
```

See [Create, Update, Destroy](/mutations/overview) for the complete reference.

---

## 6. Attributes and Enums

Columns often need transformation between the database representation and your TypeScript code. The `Attr` system handles this transparently through a Proxy — there's no manual `get`/`set` boilerplate.

### `Attr.enum` — Integer ↔ Label

Store integers in the DB, work with descriptive strings everywhere in TypeScript:

```ts
@model('posts')
export class Post extends ApplicationRecord {
  static status = Attr.enum({
    draft:     0,
    published: 1,
    archived:  2,
  } as const)
}
```

```ts
const post = await Post.create({ status: 'draft', title: 'Hello' })

post.status          // → 'draft' (string)
post.isDraft()       // → true    (auto-generated predicate)
post.isPublished()   // → false
post.toDraft()       // sets status = 'draft', returns instance

// Filtering works with labels — Attr converts to integer before the WHERE
await Post.where({ status: 'published' }).load()
// SELECT * FROM posts WHERE status = 1
```

Auto-generated helpers for each enum value:
- `post.isDraft()` / `post.isPublished()` — boolean predicates
- `post.toDraft()` / `post.toPublished()` — transition helpers (set, don't save)
- `post.statusChanged()` — dirty tracking
- `post.statusWas()` — previous value

### Other Attr Types

```ts
static priceCents = Attr.new({
  get: (v: number) => v / 100,      // read: cents → dollars
  set: (v: number) => Math.round(v * 100),  // write: dollars → cents
  default: 0,
})

static tags = Attr.json<string[]>({ default: () => [] })

static publishedAt = Attr.date()   // ISO string ↔ Date object
```

See [Attributes & Enums](/models/attributes) for the full reference.

---

## 7. Associations

Associations are declared as static properties using the association marker functions. ActiveDrizzle infers foreign keys from column names (following Drizzle conventions) and resolves the target model from the `MODEL_REGISTRY`.

```ts
// schema.ts (foreign key must be present in schema)
export const posts = pgTable('posts', {
  id:     serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  // ...
})
```

```ts
// models/Post.model.ts
import { ApplicationRecord, model, belongsTo, hasMany } from 'active-drizzle'

@model('posts')
export class Post extends ApplicationRecord {
  static author = belongsTo('users')   // FK = userId
}

// models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  static posts = hasMany()             // inferred: posts.userId
}
```

### Loading Associations

```ts
// Lazy load (separate query, N+1 risk)
const post   = await Post.find(1)
const author = await post.author   // SELECT * FROM users WHERE id = post.userId

// Eager load — one query with LEFT JOIN
const posts = await Post.includes('author').load()
posts[0].author   // already resolved, no extra query

// Nested includes
const users = await User.includes({ posts: ['comments'] }).load()
users[0].posts[0].comments   // deeply loaded
```

See [Associations](/models/associations) for `hasMany`, `hasOne`, `belongsTo`, `habtm`, dependent options, through associations, and custom FK configuration.

---

## 8. Scopes

Scopes are reusable, named query fragments declared as static methods. They return a `Relation` so they chain naturally with each other and with `where`, `order`, `includes`, etc.

```ts
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
}
```

```ts
// Scopes compose
const posts = await Post.published().recent().forUser(currentUser.id).limit(10).load()
```

The `@scope` decorator is a codegen hint — it tells the generator to include this scope in type definitions and expose it as a requestable filter in controllers. See [Scopes](/querying/scopes).

---

## 9. Validations

Declare validation logic as instance methods decorated with `@validate`. Validations run automatically during `save()` and `create()`.

```ts
import { ApplicationRecord, model, validate, serverValidate } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  @validate()
  validateEmail() {
    if (!this.email?.includes('@')) {
      this.errors.add('email', 'must be a valid email address')
    }
  }

  // Server-only: runs on save, excluded from the client bundle
  @serverValidate()
  async validateEmailUnique() {
    const existing = await User.findBy({ email: this.email })
    if (existing && existing.id !== this.id) {
      this.errors.add('email', 'is already taken')
    }
  }
}
```

```ts
const user = new User({ email: 'not-an-email' })
await user.isValid()    // false
user.errors.all()       // { email: ['must be a valid email address'] }

// create() raises ValidationError if invalid
try {
  await User.create({ email: 'bad' })
} catch (e) {
  e.errors   // { email: ['...'] }
}
```

See [Validations](/hooks/validations) for conditional validation, inline Attr validation, and the full errors API.

---

## 10. Lifecycle Callbacks

Callbacks are methods that run automatically at specific points in a record's lifecycle. Decorate them with the appropriate lifecycle decorator:

```ts
import { ApplicationRecord, model, beforeSave, afterCreate, afterCommit } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  @beforeSave()
  normalizeEmail() {
    this.email = this.email.toLowerCase().trim()
  }

  @afterCreate()
  async sendWelcomeEmail() {
    await EmailQueue.enqueue('welcome', { userId: this.id })
  }

  // Use afterCommit for external side effects —
  // guarantees the DB row exists before firing
  @afterCommit()
  async notifySlack() {
    await Slack.post(`New user: ${this.email}`)
  }
}
```

Available hooks: `@beforeSave`, `@afterSave`, `@beforeCreate`, `@afterCreate`, `@beforeUpdate`, `@afterUpdate`, `@beforeDestroy`, `@afterDestroy`, `@afterCommit`.

See [Lifecycle Callbacks](/hooks/lifecycle) for conditional hooks, aborting saves, and the `@afterCommit` pattern for external side effects.

---

## 11. The Save Pipeline

When you call `save()` or `create()`, ActiveDrizzle runs this sequence:

1. **`@beforeSave` / `@beforeCreate` / `@beforeUpdate`** hooks — normalize, set defaults
2. **`@validate` / `@serverValidate`** — if any errors, abort and return `false` (or throw on `create()`)
3. **`Attr.set` coercions** — transform values before writing to DB
4. **`INSERT` or `UPDATE`** — only changed columns are included in the SQL
5. **`@afterSave` / `@afterCreate` / `@afterUpdate`** hooks
6. **Queue `@afterCommit`** callbacks for when the outermost transaction commits
7. **Autosave associated records** (if `autosave: true`)

---

## 12. Transactions

Wrap multiple operations in a transaction using the class-level `transaction()` method. Transactions are implicit — if a `save()` happens inside a `transaction()` block, it automatically participates:

```ts
await User.transaction(async () => {
  const user  = await User.create({ email: 'alice@example.com', name: 'Alice' })
  const post  = await Post.create({ title: 'Hello', userId: user.id })
  // Both INSERT in the same transaction — if either throws, both are rolled back
})
```

`@afterCommit` hooks queue during the transaction and flush only when the outermost transaction commits — making them safe for emails, webhooks, and other external side effects.

See [Transactions](/mutations/transactions) for nested transactions, `AsyncLocalStorage` implicit propagation, and rollback patterns.

---

## 13. Instance Methods and `@pure`

Add instance methods to encapsulate derived values and business logic:

```ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static status = Attr.enum({ draft: 0, active: 1, paused: 2 } as const)

  // @pure marks a method as safe to include in the client bundle
  // (no DB calls, no server secrets)
  @pure
  isLaunchable(): boolean {
    return this.status === 'draft' && this.name.length > 0
  }

  @pure
  displayBudget(): string {
    return this.budget != null ? `$${this.budget.toLocaleString()}` : 'No budget'
  }
}
```

The `@pure` decorator signals to codegen that this method is safe to bundle into the generated `ClientModel` subclass on the frontend. Methods without `@pure` remain server-only.

---

## 14. Codegen and the Frontend

When the Vite plugin is running (or you run `npx active-drizzle generate`), codegen reads each `.model.ts` file and generates:

- **`.gen.d.ts`** — TypeScript interface with all column types, associations, and enum labels
- **`.gen.ts`** — Runtime `ClientModel` subclass with `@pure` methods, enum predicates, and cache key factories

This means the full model interface — types, predicates, computed properties — is available on the frontend without duplicating a single line of type definition.

```ts
// Frontend — using the generated ClientModel
import type { UserAttrs, UserWrite } from './_generated'
// UserAttrs = full read shape including any eager-loaded associations
// UserWrite = only permit-listed writable fields (defined in the controller)

const user: UserAttrs = data.items[0]
user.role              // 'admin' | 'member' — typed from Attr.enum
user.isAdmin()         // true/false — from @pure method
user.email             // string
```

See [ClientModel & Type Safety](/react/client-model) for the full frontend type system.

---

## What's Next

| Topic | Where to go |
|-------|-------------|
| All query methods (find, where, order, includes, pluck...) | [Querying Basics](/querying/basics) |
| Scopes — named, parameterised, composable | [Scopes](/querying/scopes) |
| Aggregates (count, sum, avg, tally) | [Aggregates & Counting](/querying/aggregates) |
| Pluck and Pick — selective column loading | [Pluck & Pick](/querying/pluck) |
| create / update / destroy deep dive | [Create, Update, Destroy](/mutations/overview) |
| Validation reference | [Validations](/hooks/validations) |
| All lifecycle hooks | [Lifecycle Callbacks](/hooks/lifecycle) |
| Dirty tracking | [Dirty Tracking](/hooks/dirty-tracking) |
| Transactions | [Transactions](/mutations/transactions) |
| Attribute transforms (Attr) | [Attributes & Enums](/models/attributes) |
| All association types and options | [Associations](/models/associations) |
| STI (Single Table Inheritance) | [STI](/models/sti) |
| Custom primary keys | [Custom Primary Keys](/models/custom-pk) |
