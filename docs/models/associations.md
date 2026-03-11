# Associations

Associations are declared as static properties using the marker functions: `belongsTo`, `hasMany`, `hasOne`, and `habtm`.

## `belongsTo`

The owning side — holds the foreign key column.

```ts
// schema.ts
import { pgTable, integer, text } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id:   integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
})

export const posts = pgTable('posts', {
  id:      integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title:   text('title').notNull(),
  userId:  integer('user_id').notNull().references(() => users.id),
})
```

```ts
// models/Post.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'
import { belongsTo }         from 'active-drizzle'

@model('posts')
export class Post extends ApplicationRecord {
  static user = belongsTo()
  // ActiveDrizzle infers: FK = userId, target table = users
}
```

```ts
// Lazy load (returns a Promise)
const post = await Post.find(1)
const user = await post.user   // SELECT * FROM users WHERE id = post.userId

// Eager load (single query)
const posts = await Post.includes('user').load()
posts[0].user   // already resolved — no extra query
```

### Custom FK or table

```ts
static author = belongsTo('users', { foreignKey: 'authorId' })
static creator = belongsTo('users', { foreignKey: 'creatorId' })
```

### `touch: true`

Updates the parent's `updatedAt` timestamp when the child is saved:

```ts
static order = belongsTo('orders', { touch: true })
```

### Polymorphic `belongsTo`

```ts
// schema.ts
export const comments = pgTable('comments', {
  id:             integer('id').primaryKey().generatedAlwaysAsIdentity(),
  body:           text('body').notNull(),
  commentableId:  integer('commentable_id').notNull(),
  commentableType: text('commentable_type').notNull(),  // 'Post' | 'Video'
})
```

```ts
// models/Comment.model.ts
@model('comments')
export class Comment extends ApplicationRecord {
  static commentable = belongsTo(undefined, { polymorphic: true })
}
```

```ts
const comment = await Comment.find(1)
const target  = await comment.commentable
// Returns a Post or Video instance based on commentable_type
```

---

## `hasMany`

The inverse side — no FK on this table.

```ts
// models/User.model.ts
import { hasMany } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  static posts = hasMany()
  // Inferred: SELECT * FROM posts WHERE user_id = this.id
}
```

```ts
const user  = await User.find(1)
const posts = await user.posts.load()          // Relation<Post>

// Filter / order the association
const recent = await user.posts
  .where({ published: true })
  .order('createdAt', 'desc')
  .limit(5)
  .load()
```

### Custom FK or table

```ts
static authoredPosts = hasMany('posts', { foreignKey: 'authorId' })
```

### `dependent: 'destroy'`

Destroy all children when the parent is destroyed:

```ts
static comments = hasMany({ dependent: 'destroy' })
```

### `counterCache`

Automatically maintain a counter column on the parent table:

```ts
// schema.ts — parent table must have the counter column
export const users = pgTable('users', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  postsCount: integer('posts_count').notNull().default(0),
})
```

```ts
// models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  static posts = hasMany({ counterCache: true })
  // Increments/decrements user.postsCount automatically
}
```

### `through` (has-many-through)

```ts
// schema.ts
export const doctors   = pgTable('doctors',   { id: integer('id').primaryKey().generatedAlwaysAsIdentity() })
export const patients  = pgTable('patients',  { id: integer('id').primaryKey().generatedAlwaysAsIdentity() })
export const appointments = pgTable('appointments', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  doctorId:  integer('doctor_id').notNull(),
  patientId: integer('patient_id').notNull(),
})
```

```ts
// models/Doctor.model.ts
@model('doctors')
export class Doctor extends ApplicationRecord {
  static appointments = hasMany()
  static patients     = hasMany('patients', { through: 'appointments' })
}
```

### `acceptsNestedAttributesFor`

See the [Nested Attributes](/mutations/nested-attributes) page.

---

## `hasOne`

Like `hasMany` but returns a single record (Promise, not Relation):

```ts
// schema.ts
export const profiles = pgTable('profiles', {
  id:     integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userId: integer('user_id').notNull(),
  bio:    text('bio'),
})
```

```ts
// models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  static profile = hasOne()
}
```

```ts
const user    = await User.find(1)
const profile = await user.profile   // Promise<Profile | null>
```

---

## `habtm` — has-and-belongs-to-many

Many-to-many through a pure join table (no model for the join):

```ts
// schema.ts
export const posts      = pgTable('posts',       { id: integer('id').primaryKey().generatedAlwaysAsIdentity() })
export const tags       = pgTable('tags',        { id: integer('id').primaryKey().generatedAlwaysAsIdentity(), name: text('name').notNull() })
export const posts_tags = pgTable('posts_tags',  {
  postId: integer('post_id').notNull(),
  tagId:  integer('tag_id').notNull(),
})
```

```ts
// models/Post.model.ts
import { habtm } from 'active-drizzle'

@model('posts')
export class Post extends ApplicationRecord {
  static tags = habtm('posts_tags')
  // FK inferred: posts_tags.post_id → this.id → tags
}
```

```ts
const post = await Post.find(1)
const tags = await post.tags.load()   // Relation<Tag>
```

---

## Eager loading with `includes`

Load associations in a **single query** using Drizzle's relational API:

```ts
// One query: posts + user + comments
const posts = await Post
  .includes('user', 'comments')
  .where({ published: true })
  .order('createdAt', 'desc')
  .load()

posts[0].user      // User instance — already loaded
posts[0].comments  // Comment[] — already loaded
```

::: tip Drizzle `relations()` required
For `includes()` and nested `pluck()` to work, you must define Drizzle `relations()` in your schema file alongside the table definitions. See [Querying → Pluck](/querying/pluck#nested-pluck) for details.
:::

Nested includes:

```ts
const orders = await Order.includes({ lineItems: { includes: 'product' } }).load()
orders[0].lineItems[0].product  // Product instance
```
