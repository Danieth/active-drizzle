# Nested Attributes

`acceptsNestedAttributesFor` lets you create or update associated records through the parent — Rails-style.

## Setup

```ts
// schema.ts
export const users = pgTable('users', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
})

export const profiles = pgTable('profiles', {
  id:     integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: integer('user_id').notNull().references(() => users.id),
  bio:    text('bio'),
})

export const posts = pgTable('posts', {
  id:     integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title:  text('title').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
})
```

```ts
// models/User.model.ts
import { ApplicationRecord, model, acceptsNestedAttributesFor, hasOne, hasMany } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  static profile = hasOne({ autosave: true })
  static posts   = hasMany({ autosave: true })

  static profileAttributes  = acceptsNestedAttributesFor('profile')
  static postsAttributes    = acceptsNestedAttributesFor('posts', { allowDestroy: true })
}
```

## Creating with nested records

```ts
const user = await User.create({
  email: 'alice@example.com',
  profileAttributes: { bio: 'TypeScript enthusiast' },
  postsAttributes: [
    { title: 'First post' },
    { title: 'Second post' },
  ],
})

// user, user.profile, and both posts are all created in one operation
```

## Updating nested records

Pass the nested record's `id` to update an existing one:

```ts
await user.update({
  profileAttributes: {
    id:  user.profile.id,
    bio: 'Updated bio',
  },
})
```

## Destroying nested records

With `allowDestroy: true`, pass `_destroy: true` to delete a nested record:

```ts
await user.update({
  postsAttributes: [
    { id: 42, _destroy: true },   // deletes post with id 42
  ],
})
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `allowDestroy` | `false` | Allow `_destroy: true` to delete nested records |
| `rejectIf` | — | Function `(attrs) => boolean` — reject the nested record if it returns true |
| `limit` | — | Maximum number of nested records to accept |

### `rejectIf` example

```ts
static postsAttributes = acceptsNestedAttributesFor('posts', {
  rejectIf: (attrs) => !attrs.title,  // skip records with no title
})
```

## Without a model class

You can also accept nested attributes on associations that don't have an explicit `acceptsNestedAttributesFor` — just make sure `autosave: true` is set on the association and pass the attribute key ending in `Attributes`:

```ts
static comments = hasMany({ autosave: true })
```

```ts
await post.update({
  commentsAttributes: [{ body: 'Great post!' }],
})
```
