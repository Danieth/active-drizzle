# Getting Started

ActiveDrizzle brings Rails-style ActiveRecord patterns to [Drizzle ORM](https://orm.drizzle.team): associations, lifecycle hooks, attribute transforms, dirty tracking, and full TypeScript codegen — all on top of your existing Drizzle schema.

## Install

```bash
npm install active-drizzle
npm install -D drizzle-orm
```

::: tip Project layout
ActiveDrizzle works best with a `db/` folder for your Drizzle schema + client and a `models/` folder for your model classes. Codegen writes `.gen.*` files alongside your models automatically. See [Project Structure](/guide/project-structure) for the full recommended layout.
:::

## 1. Define your Drizzle schema

ActiveDrizzle reads your existing Drizzle schema directly. Nothing changes here.

```ts
// schema.ts
import { pgTable, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email:     text('email').notNull(),
  name:      text('name').notNull(),
  role:      integer('role').notNull().default(0),  // 0=customer, 1=admin
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const posts = pgTable('posts', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title:     text('title').notNull(),
  body:      text('body'),
  userId:    integer('user_id').notNull().references(() => users.id),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

## 2. Define your models

```ts
// models/User.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model, beforeSave } from 'active-drizzle'
import { Attr } from 'active-drizzle'
import { hasMany } from 'active-drizzle'

@model('users')
export class User extends ApplicationRecord {
  static role  = Attr.enum({ customer: 0, admin: 1 } as const)
  static posts = hasMany()

  @beforeSave()
  normalizeEmail() {
    this.email = this.email?.toLowerCase()
  }
}
```

```ts
// models/Post.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model } from 'active-drizzle'
import { belongsTo } from 'active-drizzle'

@model('posts')
export class Post extends ApplicationRecord {
  static user = belongsTo()
}
```

## 3. Boot once at startup

```ts
// app.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { boot } from 'active-drizzle'
import * as schema from './schema.js'

const db = drizzle(process.env.DATABASE_URL!, { schema })
boot(db, schema)
```

## 4. Run codegen

**With Vite** — add the plugin once; codegen runs automatically on every save:

```ts
// vite.config.ts
import activeDrizzle from 'active-drizzle/vite'

export default defineConfig({
  plugins: [
    activeDrizzle({
      schema: 'src/db/schema.ts',
      models: 'src/models/**/*.model.ts',
    }),
  ],
})
```

**Without Vite** (Next.js, Express, plain Node) — run codegen as a build step:

```bash
npx active-drizzle generate \
  --schema src/db/schema.ts \
  --models 'src/models/**/*.model.ts'
```

Or add it to `package.json`:

```json
{ "scripts": { "codegen": "active-drizzle generate --schema src/db/schema.ts --models 'src/models/**/*.model.ts'" } }
```

After codegen, `User.model.gen.d.ts` and `User.model.gen.ts` appear alongside each model. See [Codegen & CLI](/codegen/vite-plugin) for the full details.

## 5. Use it

```ts
// Create
const user = await User.create({ email: 'Alice@example.com', name: 'Alice' })
// email is normalised to 'alice@example.com' by the beforeSave hook

// Find
const same = await User.find(user.id)         // throws RecordNotFound if missing
const maybe = await User.findBy({ email: 'alice@example.com' })  // null if missing

// Query
const admins = await User.where({ role: 'admin' }).order('name').load()

// Associations
const posts = await user.posts.load()         // scoped Relation
const post  = await Post.find(1)
const owner = await post.user                 // Promise<User>

// Update
await user.update({ name: 'Alice Smith' })

// Destroy
await post.destroy()
```

That's the full loop. Keep reading to learn every feature.
