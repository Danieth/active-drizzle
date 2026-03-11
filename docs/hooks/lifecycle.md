# Lifecycle Callbacks

Lifecycle callbacks are methods that run automatically at specific points in a record's lifecycle. They're the right place for normalisation, computed fields, side effects, and audit logging — without tangling that logic into your controllers or service objects.

If you've used Rails callbacks, the API is intentionally similar. The key difference: everything is TypeScript, async is first-class, and `@afterCommit` makes external side effects safe.

After reading this guide you will know:

- Which decorators are available and when they fire
- How to write conditional callbacks
- How to abort a save from a `@before` callback
- The `@afterCommit` pattern for emails and external services
- How callbacks are inherited and composed across model hierarchies

---

## 1. Available Callbacks

| Decorator | When it fires |
|-----------|--------------|
| `@beforeSave()` | Before every INSERT or UPDATE |
| `@afterSave()` | After every INSERT or UPDATE |
| `@beforeCreate()` | Before INSERT (new records only) |
| `@afterCreate()` | After INSERT (new records only) |
| `@beforeUpdate()` | Before UPDATE (existing records only) |
| `@afterUpdate()` | After UPDATE (existing records only) |
| `@beforeDestroy()` | Before DELETE |
| `@afterDestroy()` | After DELETE |
| `@afterCommit()` | After the outermost transaction commits |

---

## 2. Defining Callbacks

Callbacks are instance methods decorated with the appropriate decorator. They can be synchronous or async:

```ts
// schema.ts
export const users = pgTable('users', {
  id:        serial('id').primaryKey(),
  email:     varchar('email', { length: 255 }).notNull(),
  name:      varchar('name', { length: 255 }).notNull(),
  slug:      varchar('slug', { length: 255 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

```ts
// models/User.model.ts
import {
  ApplicationRecord, model,
  beforeSave, afterCreate, afterUpdate, beforeDestroy, afterCommit,
} from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {

  // Normalize email before every save (insert or update)
  @beforeSave()
  normalizeEmail() {
    this.email = this.email.toLowerCase().trim()
  }

  // Auto-generate a slug from the name before creating
  @beforeCreate()
  generateSlug() {
    if (!this.slug) {
      this.slug = this.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    }
  }

  // Update the updatedAt timestamp before every save
  @beforeSave()
  setUpdatedAt() {
    this.updatedAt = new Date()
  }

  // Fire and forget — async queue after create
  @afterCreate()
  async enqueueWelcomeEmail() {
    await EmailQueue.enqueue('welcome', { userId: this.id })
  }

  // Guard deletion
  @beforeDestroy()
  ensureDeletable() {
    if (this.role === 'owner') {
      throw new Error('Cannot delete the account owner')
    }
  }

  // @afterCommit — safe for external side effects
  // Fires AFTER the DB transaction commits — the record is guaranteed in the DB
  @afterCommit()
  async notifySlack() {
    await Slack.post(`New user: ${this.email}`)
  }
}
```

---

## 3. The Callback Execution Order

When `save()` or `create()` is called, callbacks fire in this order:

1. `@beforeCreate` (or `@beforeUpdate` for existing records)
2. `@beforeSave`
3. `@validate` / `@serverValidate` — if errors, abort
4. `Attr.set` coercions applied
5. `INSERT` or `UPDATE` query
6. `@afterCreate` (or `@afterUpdate`)
7. `@afterSave`
8. Queue `@afterCommit` (flushes when the outermost transaction commits)

For `destroy()`:

1. `@beforeDestroy`
2. `DELETE` query
3. `@afterDestroy`

### Multiple callbacks of the same type

When multiple callbacks of the same type are declared, they run in **declaration order**:

```ts
@beforeSave()
stepOne() { /* runs first */ }

@beforeSave()
stepTwo() { /* runs second */ }

@beforeSave()
stepThree() { /* runs third */ }
```

---

## 4. Conditional Callbacks

Pass a condition to any callback decorator. The callback is skipped unless the condition is met.

### String condition — method name

The condition is the name of a method on the instance. The callback fires only if that method returns truthy:

```ts
// Only re-confirm email if it changed
@beforeSave('emailChanged')
async invalidateEmailConfirmation() {
  this.emailConfirmedAt = null
}

// Update search index only if searchable fields changed
@afterSave('nameChanged')
async reindexInSearch() {
  await SearchIndex.update(this.id, { name: this.name })
}
```

Built-in dirty tracking methods (auto-generated for every column) work perfectly here:
- `fieldChanged()` — true if the field value changed since load
- `isNewRecord` — true on `@afterCreate`
- Any `is*()` predicate from `Attr.enum`

### Function condition

```ts
// Only run in production
@afterCreate(() => process.env.NODE_ENV === 'production')
async sendRealEmail() {
  await Email.send('welcome', { userId: this.id })
}

// Only run for admin users
@afterSave((user) => user.role === 'admin')
async syncAdminPermissions() {
  await PermissionsService.sync(this.id)
}
```

---

## 5. Aborting a Save

Throw `AbortChain` in a `@before` callback to silently cancel the save without raising an error:

```ts
import { AbortChain } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {

  @beforeSave()
  preventSavingBannedUsers() {
    if (this.bannedAt !== null) throw new AbortChain()
  }
}
```

```ts
const user = await User.find(1)
user.bannedAt = new Date()
await user.save()    // → false (not an error, just didn't save)
user.errors.isEmpty()  // true — AbortChain is a clean abort, not a validation error
```

To communicate **why** the save was aborted, add errors before throwing:

```ts
@beforeSave()
preventSavingBannedUsers() {
  if (this.bannedAt !== null) {
    this.errors.add('base', 'Account is banned and cannot be saved')
    throw new AbortChain()
  }
}
```

```ts
const result = await user.save()   // false
user.errors.on('base')             // ['Account is banned and cannot be saved']
```

---

## 6. `@afterCommit` — Safe External Side Effects

**Always use `@afterCommit` for emails, webhooks, and external service calls** — never `@afterCreate` or `@afterSave`.

The reason: `@afterCreate` fires inside the transaction. If anything after it rolls the transaction back, the row is gone — but your email already went out. `@afterCommit` only fires after the outermost transaction successfully commits:

```ts
@model('orders')
export class Order extends ApplicationRecord {

  // ❌ Dangerous — fires inside the transaction
  @afterCreate()
  async sendConfirmation_WRONG() {
    await Email.send('order-confirmed', { orderId: this.id })
    // If the transaction later rolls back, email was sent for a non-existent order
  }

  // ✅ Safe — fires after the transaction commits
  @afterCommit()
  async sendConfirmation() {
    await Email.send('order-confirmed', { orderId: this.id })
    // Guaranteed: the order is in the DB when this runs
  }
}
```

`@afterCommit` callbacks are queued via `AsyncLocalStorage` during the transaction and flushed in FIFO order when the outermost `transaction()` block completes.

---

## 7. Async Callbacks

All callbacks can be async. ActiveDrizzle awaits them in sequence:

```ts
@beforeCreate()
async generateUniqueSlug() {
  let slug = slugify(this.name)
  let counter = 0
  while (await Post.findBy({ slug })) {
    slug = `${slugify(this.name)}-${++counter}`
  }
  this.slug = slug
}
```

Async `@before` callbacks run serially (not in parallel) to ensure deterministic behavior.

---

## 8. Destroying Records with Callbacks

```ts
@model('posts')
export class Post extends ApplicationRecord {
  static comments = hasMany({ dependent: 'destroy' })

  @beforeDestroy()
  ensureDeletable() {
    if (this.published) throw new Error('Cannot delete a published post')
  }

  @afterDestroy()
  async cleanupS3Files() {
    await S3.deleteRecursive(`posts/${this.id}/`)
  }
}
```

The `dependent: 'destroy'` option on associations fires `destroy()` on each associated record (their hooks also run) before the parent is destroyed.

---

## 9. Callback Inheritance

Callbacks are inherited through the class hierarchy. Parent class callbacks fire **before** child class callbacks of the same type:

```ts
// Base class — shared timestamps
class ApplicationRecord extends ActiveDrizzleBase {
  @beforeSave()
  updateTimestamps() {
    this.updatedAt = new Date()
    if (this.isNewRecord) this.createdAt = new Date()
  }
}

// Child — adds its own @beforeSave logic
@model('posts')
export class Post extends ApplicationRecord {
  @beforeSave()
  sanitizeTitle() {
    this.title = this.title.trim()
  }
  // Order: updateTimestamps() → sanitizeTitle()
}
```

This is the recommended pattern for timestamp management — define `updateTimestamps` once on your `ApplicationRecord` base class.

### Base `ApplicationRecord` example

```ts
// models/ApplicationRecord.ts
import { ApplicationRecord as ActiveDrizzleBase, beforeSave } from 'active-drizzle'

export class ApplicationRecord extends ActiveDrizzleBase {
  @beforeSave()
  setTimestamps() {
    this.updatedAt = new Date()
    if (this.isNewRecord) {
      this.createdAt = new Date()
    }
  }
}
```

Every model that extends `ApplicationRecord` gets automatic timestamp management without any additional code.

---

## 10. `@afterSave` vs `@afterCreate` vs `@afterUpdate`

Choose based on which lifecycle events you care about:

| Use case | Decorator to use |
|----------|-----------------|
| Always after a write (insert or update) | `@afterSave` |
| Only when a record is first created | `@afterCreate` |
| Only when an existing record is updated | `@afterUpdate` |
| External side effects (email, webhook) | `@afterCommit` |
| After a delete | `@afterDestroy` |

---

## 11. Common Patterns

### Auto-generate a field before create

```ts
@beforeCreate()
generateApiKey() {
  this.apiKey = crypto.randomBytes(32).toString('hex')
}
```

### Normalize a value before every save

```ts
@beforeSave()
normalizePhone() {
  this.phone = this.phone?.replace(/\D/g, '') ?? null
}
```

### Audit log on update

```ts
@afterUpdate('statusChanged')
async logStatusChange() {
  await AuditLog.create({
    modelType: 'Campaign',
    modelId:   this.id,
    field:     'status',
    from:      this.statusWas(),
    to:        this.status,
    changedAt: new Date(),
  })
}
```

### Enqueue a background job after commit

```ts
@afterCommit()
async scheduleDigest() {
  await Queue.push('user.send_digest', { userId: this.id })
}
```

### Prevent deletion under conditions

```ts
@beforeDestroy()
preventDeletionIfLocked() {
  if (this.locked) {
    this.errors.add('base', 'Record is locked and cannot be deleted')
    throw new AbortChain()
  }
}
```

---

## 12. Special Decorators — `@memoize`, `@computed`, `@server`, `@pure`

These are codegen annotations — no-ops at runtime, but they control what the Vite plugin includes in generated client code:

| Decorator | Purpose |
|-----------|---------|
| `@pure` | Include this instance method in the generated `ClientModel` — no server calls, no secrets |
| `@server` | Mark as server-only — excluded from client bundle entirely |
| `@computed` | Mark a static method as returning data (not a chainable `Relation`) — codegen hint for `@action` generation |
| `@memoize` | Hint that this value should be memoized in the client model |

```ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  // Included in the client bundle — pure TypeScript logic
  @pure
  isEditable(): boolean {
    return this.status === 'draft' || this.status === 'paused'
  }

  // Server-only — never reaches the frontend
  @server
  async sendToAnalytics() {
    await Analytics.track(this.id, this.toJSON())
  }
}
```
