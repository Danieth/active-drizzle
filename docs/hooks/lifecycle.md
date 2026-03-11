# Lifecycle Hooks

Hooks are methods decorated with a lifecycle decorator. They run automatically at specific points in a record's lifecycle.

## Available hooks

| Decorator | When it runs |
|-----------|-------------|
| `@beforeSave()` | Before every INSERT or UPDATE |
| `@afterSave()` | After every INSERT or UPDATE |
| `@beforeCreate()` | Before INSERT (new records only) |
| `@afterCreate()` | After INSERT (new records only) |
| `@beforeUpdate()` | Before UPDATE (existing records only) |
| `@afterUpdate()` | After UPDATE (existing records only) |
| `@beforeDestroy()` | Before DELETE |
| `@afterDestroy()` | After DELETE |
| `@afterCommit()` | After the outermost transaction commits |

## Basic usage

```ts
// schema.ts
export const users = pgTable('users', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email:     text('email').notNull(),
  name:      text('name').notNull(),
  slug:      text('slug'),
  updatedAt: timestamp('updated_at'),
})
```

```ts
// models/User.model.ts
import { ApplicationRecord, model, beforeSave, afterCreate, afterCommit } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  @beforeSave()
  normalizeEmail() {
    (this as any).email = ((this as any).email as string).toLowerCase().trim()
  }

  @beforeSave()
  setSlug() {
    if (!(this as any).slug) {
      (this as any).slug = slugify((this as any).name)
    }
  }

  @afterCreate()
  async sendWelcomeEmail() {
    await EmailQueue.enqueue('welcome', { userId: (this as any).id })
  }

  @afterCommit()
  async notifySlack() {
    await Slack.post(`New user: ${(this as any).email}`)
  }
}
```

## Multiple hooks of the same type

Multiple decorators of the same type run in **declaration order**:

```ts
@beforeSave()
stripWhitespace() { /* runs first */ }

@beforeSave()
setDefaults() { /* runs second */ }
```

## Conditional hooks

Run a hook only when a specific field has changed:

```ts
@beforeSave('emailChanged')
async reconfirmEmail() {
  (this as any).confirmedAt = null
}

@afterSave('nameChanged')
updateSearchIndex() {
  SearchIndex.update((this as any).id, { name: (this as any).name })
}
```

The string argument is a method name on the instance. Common patterns:

```ts
// Built-in dirty tracking methods (via Attr.enum or plain columns):
@beforeSave('statusChanged')       // if status column changed this session
@afterCreate('isNewRecord')        // always true on afterCreate
@beforeSave('roleChanged')
```

You can also pass a function:

```ts
@beforeSave((record) => record.role === 'admin')
setupAdminPermissions() { ... }
```

## Aborting a save

Throw `AbortChain` to silently prevent the save without raising an error:

```ts
import { AbortChain } from 'active-drizzle'

@beforeSave()
preventBannedUsers() {
  if ((this as any).banned) throw new AbortChain()
}
```

```ts
const result = await user.save()   // → false (not an exception)
```

## Destroying records with hooks

```ts
@model('orders')
export class Order extends ApplicationRecord {
  @beforeDestroy()
  ensureCancellable() {
    if ((this as any).status === 'shipped') {
      throw new Error('Cannot delete a shipped order')
    }
  }

  @afterDestroy()
  async cleanupFiles() {
    await S3.delete(`orders/${(this as any).id}/`)
  }
}
```

## `@afterCommit` for side effects

Always use `@afterCommit` for external side effects (email, webhooks, etc.) rather than `@afterCreate` / `@afterSave`. This ensures the side effect only fires if the database write actually committed:

```ts
@afterCommit()
async sendOrderConfirmation() {
  // Guaranteed: the order is now in the DB when this runs
  await Email.send('order-confirmed', { orderId: (this as any).id })
}
```

## Inheritance

Hooks are inherited. A hook defined on `ApplicationRecord` runs for every model. A hook defined on a parent model class runs for all subclasses:

```ts
class ApplicationRecord extends ActiveDrizzleBase {
  @beforeSave()
  setTimestamps() {
    (this as any).updatedAt = new Date()
    if (this.isNewRecord) (this as any).createdAt = new Date()
  }
}

// Every model now gets automatic timestamp management
```

## `@memoize`, `@computed`, `@server`

Utility decorators that signal codegen intent — they are no-ops at runtime:

| Decorator | Purpose |
|-----------|---------|
| `@memoize` | Mark an instance method as memoized (codegen hint) |
| `@computed` | Mark a static method as computed (returns data, not Relation) |
| `@server` | Mark a method as server-only (excluded from client bundle) |
