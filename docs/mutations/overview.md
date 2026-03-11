# Create, Update & Destroy

## Creating records

### `Model.create(attrs)` — insert and return

```ts
// schema.ts
export const users = pgTable('users', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
  name:  text('name').notNull(),
  role:  integer('role').notNull().default(0),
})
```

```ts
// models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  static role = Attr.enum({ customer: 0, admin: 1 } as const)
}
```

```ts
const user = await User.create({ email: 'alice@example.com', name: 'Alice', role: 'admin' })
user.id     // auto-assigned from the DB
user.role   // → 'admin'

// Validation errors raise instead of returning
try {
  await User.create({ email: '' })
} catch (e) {
  // ValidationError with e.errors
}
```

### `new` + `save()`

Useful when you need to set properties conditionally:

```ts
const user = new User()
user.email = 'bob@example.com'
user.name  = 'Bob'
await user.save()

user.isNewRecord  // false after save
user.id           // set by DB
```

### `new` → `isNewRecord`

A record is a **new record** (not yet saved) if it was constructed with `new Model()` or the first argument is not `true`:

```ts
const u = new User({ email: 'x@x.com', name: 'X' })
u.isNewRecord   // true
await u.save()
u.isNewRecord   // false
```

---

## Updating records

### `instance.update(attrs)` — partial update

```ts
const user = await User.find(1)
await user.update({ name: 'Alice Smith' })
// Only the name column is updated
```

### `instance.save()` — persist all changes

```ts
user.name = 'Alice Smith'
user.role = 'admin'
await user.save()
// UPDATE users SET name = ?, role = ? WHERE id = ?
// Only changed columns are sent (dirty tracking)
```

### `Relation.updateAll(attrs)` — bulk update

```ts
await User.where({ role: 'customer' }).updateAll({ role: 'guest' })
// UPDATE users SET role = 0 WHERE role = 0
```

No lifecycle hooks are run for `updateAll` — it's a raw SQL UPDATE for performance.

---

## Destroying records

### `instance.destroy()`

```ts
const user = await User.find(1)
await user.destroy()

user.isDestroyed  // true
```

Runs `@beforeDestroy` and `@afterDestroy` hooks. If the model has `dependent: 'destroy'` associations, those records are destroyed first.

### `Relation.destroyAll()` — bulk destroy

Loads each record and calls `destroy()` on it (hooks run):

```ts
await User.where({ active: false }).destroyAll()
```

### `Relation.deleteAll()` — raw DELETE (no hooks)

```ts
await User.where({ active: false }).deleteAll()
// DELETE FROM users WHERE active = false — no hooks, faster
```

---

## `reload()`

Refreshes the record from the database, discarding any unsaved changes:

```ts
user.name = 'Temporary Name'
await user.reload()
user.name   // original name from DB
```

---

## `touch()`

Updates the `updatedAt` timestamp (and nothing else):

```ts
await user.touch()
// UPDATE users SET updated_at = NOW() WHERE id = ?
```

---

## The `save` pipeline

When you call `save()` or `create()`, ActiveDrizzle runs this sequence:

1. Run `@beforeSave` hooks (and `@beforeCreate` / `@beforeUpdate`)
2. Run `@validate` and `@serverValidate` hooks — abort if errors
3. Coerce values via `Attr.set`
4. INSERT or UPDATE in the database
5. Run `@afterSave` hooks (and `@afterCreate` / `@afterUpdate`)
6. (If inside a transaction) queue `@afterCommit` hooks; flush when the outermost transaction commits
7. Autosave any associations with `autosave: true`

---

## `isValid()` / `errors`

Run validations without saving:

```ts
const user = new User({ email: '' })
const valid = await user.isValid()    // → false
user.errors   // { email: ['is required'] }
```
