# Custom Primary Keys

By default, ActiveDrizzle assumes your primary key column is named `id`. You can override this for any model.

## Non-`id` primary key

```ts
// schema.ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const tokens = pgTable('tokens', {
  token:     text('token').primaryKey(),   // PK is 'token', not 'id'
  userId:    integer('user_id').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
})
```

```ts
// models/Token.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'

@model('tokens')
export class Token extends ApplicationRecord {
  static primaryKey = 'token'   // ← tell ActiveDrizzle which column is the PK
}
```

```ts
// find by the custom PK
const t = await Token.find('abc123')          // WHERE token = 'abc123'
await t.update({ expiresAt: new Date(...) })  // UPDATE WHERE token = 'abc123'
await t.destroy()                             // DELETE WHERE token = 'abc123'

// ids() returns the PK values
const allTokens = await Token.ids()           // → ['abc123', 'def456', ...]
```

## Composite primary key

```ts
// schema.ts
import { pgTable, integer, primaryKey } from 'drizzle-orm/pg-core'

export const memberships = pgTable('memberships', {
  tenantId: integer('tenant_id').notNull(),
  userId:   integer('user_id').notNull(),
  role:     integer('role').notNull().default(0),
}, t => ({
  pk: primaryKey({ columns: [t.tenantId, t.userId] }),
}))
```

```ts
// models/Membership.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'
import { Attr }              from 'active-drizzle'

@model('memberships')
export class Membership extends ApplicationRecord {
  static primaryKey = ['tenantId', 'userId']   // ← composite PK as array

  static role = Attr.enum({ member: 0, admin: 1, owner: 2 } as const)
}
```

```ts
// find by composite PK — pass an array of values in the same order
const m = await Membership.find([1, 42])    // WHERE tenant_id = 1 AND user_id = 42

await m.update({ role: 'admin' })
await m.destroy()

// ids() returns objects for composite PKs
const ids = await Membership.ids()
// → [{ tenantId: 1, userId: 42 }, { tenantId: 1, userId: 99 }, ...]
```

## `save()` and `reload()` work the same way

```ts
const membership = new Membership({ tenantId: 5, userId: 10, role: 'member' }, true)
await membership.save()   // INSERT with composite PK

await membership.reload() // SELECT WHERE tenant_id = 5 AND user_id = 10
```

## Summary

| Scenario | `static primaryKey` | `find()` call |
|----------|--------------------|-|
| Default (id column) | _(omit)_ | `Model.find(1)` |
| Single non-id column | `'token'` | `Model.find('abc123')` |
| Composite | `['tenantId', 'userId']` | `Model.find([1, 42])` |
