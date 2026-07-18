# Validations

ActiveDrizzle offers two validation mechanisms: synchronous `@validate` (runs client and server) and asynchronous `@serverValidate` (server only).

## `@validate` — synchronous

```ts
// schema.ts
export const users = pgTable('users', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
  age:   integer('age'),
})
```

```ts
// models/User.model.ts
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  @validate()
  validateEmail() {
    const email = this.email as string
    if (!email?.includes('@')) {
      this.errors.add('email', 'must be a valid email address')
    }
  }

  @validate()
  validateAge() {
    const age = this.age as number
    if (age !== null && age < 0) {
      this.errors.add('age', 'must be non-negative')
    }
  }
}
```

```ts
const user = new User({ email: 'not-an-email' })
const valid = await user.isValid()    // → false
user.errors.all()                     // { email: ['must be a valid email address'] }
user.errors.on('email')               // ['must be a valid email address']
user.errors.full()                    // ['email must be a valid email address']
```

When you `save()` or `create()`, validation runs automatically:

```ts
try {
  await User.create({ email: 'bad' })
} catch (e) {
  // ValidationError thrown
  e.errors   // { email: ['must be a valid email address'] }
}
```

## `@serverValidate` — async, server only

For validations that require a DB lookup or external service call:

```ts
import { serverValidate } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  @serverValidate()
  async validateEmailUnique() {
    const existing = await User.findBy({ email: this.email })
    if (existing && existing.id !== this.id) {
      this.errors.add('email', 'is already taken')
    }
  }
}
```

`@serverValidate` runs during `save()` / `create()` on the server. In client-generated code (via codegen), `@serverValidate` methods are excluded from the client bundle.

## Inline validation with `validate` / `validates`

For simple per-field rules, use `validate` (or the Rails-ish alias `validates`) on any `Attr.*`.  
A validator returns a **non-empty message string** on failure, or `null` to pass. Empty strings are ignored (not errors).

```ts
static price = Attr.money('priceCents', {
  validate: (v) => (v !== null && v >= 0 ? null : 'must be non-negative'),
})
```

Multiple validators as an array — **all** run; every failure needs a real message:

```ts
static slug = Attr.string({
  validates: [
    (v) => (v?.length ? null : 'cannot be blank'),
    (v) => (/^[a-z0-9-]+$/.test(v ?? '') ? null : 'must be lowercase alphanumeric'),
  ],
})
```

## Conditional validation

Run a validation only under certain conditions:

```ts
@validate('statusChanged')
ensureTransitionAllowed() {
  const from = this.statusWas()
  const to   = this.status
  const allowed = { pending: ['paid'], paid: ['shipped', 'cancelled'] }
  if (from && !allowed[from]?.includes(to)) {
    this.errors.add('status', `cannot transition from ${from} to ${to}`)
  }
}
```

## `errors` API

Every error **must** include a non-empty message. `errors.add(field, '')` throws.

| Method | Returns |
|--------|---------|
| `errors.add(field, message)` | Add an error (message required) |
| `errors.on(field)` | `string[]` — messages for that field |
| `errors.all()` | `Record<string, string[]>` — all errors |
| `errors.full()` | `string[]` — `['field message', ...]` format |
| `errors.clear()` | Remove all errors |
| `errors.isEmpty()` | `boolean` |

Legacy bracket access still works: `errors['email']`, `errors['email'] = ['is invalid']`.

## `isValid()` / `isInvalid()`

```ts
const user = new User({ email: '' })

await user.isValid()    // → false (runs all validations)
await user.isInvalid()  // → true

user.errors.all()       // { email: ['must be a valid email address'] }
```

## Skipping validation

If you need to save without running validations (use sparingly):

```ts
await user.save({ validate: false })
```
