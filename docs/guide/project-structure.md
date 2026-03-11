# Project Structure

ActiveDrizzle works best with a consistent layout. This page shows the recommended structure and explains what lives where.

## Recommended layout

```
my-app/
├── src/
│   ├── db/
│   │   ├── schema.ts          ← Drizzle table definitions
│   │   ├── index.ts           ← drizzle() client + boot()
│   │   └── migrations/        ← Drizzle migration files
│   │
│   ├── models/
│   │   ├── User.model.ts      ← your handwritten model class
│   │   ├── Post.model.ts
│   │   ├── Comment.model.ts
│   │   ├── index.ts           ← imports every model (populates registry)
│   │   │
│   │   ├── User.model.gen.d.ts    ← GENERATED — TypeScript types
│   │   ├── User.model.gen.ts      ← GENERATED — isomorphic Client class
│   │   ├── Post.model.gen.d.ts
│   │   ├── Post.model.gen.ts
│   │   ├── _registry.gen.ts       ← GENERATED — model registry
│   │   └── _globals.gen.d.ts      ← GENERATED — global type helpers
│   │
│   └── app.ts
│
├── .active-drizzle/
│   └── schema.md              ← GENERATED — LLM-optimized schema reference
│
├── vite.config.ts
└── package.json
```

## The `db/` folder

**`db/schema.ts`** — defines your Drizzle tables. This is the single source of truth for column types, nullability, defaults, and constraints. ActiveDrizzle reads this file at build time to generate types.

```ts
// src/db/schema.ts
import { pgTable, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email:     text('email').notNull(),
  name:      text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const posts = pgTable('posts', {
  id:        integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title:     text('title').notNull(),
  published: boolean('published').notNull().default(false),
  userId:    integer('user_id').notNull().references(() => users.id),
})
```

**`db/index.ts`** — creates the Drizzle client and calls `boot()`. Import this at your app entry point.

```ts
// src/db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool }    from 'pg'
import { boot }    from 'active-drizzle'
import * as schema from './schema.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle({ client: pool, schema })

boot(db, schema)
```

## The `models/` folder

**`*.model.ts`** — your handwritten model class. This is where you declare associations, Attr transforms, hooks, validations, and scopes. Keep it focused on business logic — column types come from `schema.ts` via codegen.

**`models/index.ts`** — imports every model. This is a side-effect import that runs all `@model()` decorators and populates the global `MODEL_REGISTRY`.

```ts
// src/models/index.ts
export { User }    from './User.model.js'
export { Post }    from './Post.model.js'
export { Comment } from './Comment.model.js'
```

Import this in your `db/index.ts` (after `boot`) so all models are registered before any query runs:

```ts
// src/db/index.ts
import { boot } from 'active-drizzle'
import * as schema from './schema.js'
import '../models/index.js'  // ← registers all models

boot(db, schema)
```

## The generated files (`.gen.*`)

Generated files live **next to the model they augment**. The `.gen.` infix makes it immediately obvious what's handwritten vs. generated — they're also safe to add to `.gitignore` if you regenerate in CI.

| File | What it contains |
|------|-----------------|
| `User.model.gen.d.ts` | TypeScript interface augmentation — column types, enum helpers (`isPending()`, `toPending()`), dirty tracking methods, association types, scope overloads |
| `User.model.gen.ts` | Isomorphic `User.Client` class — runs in the browser, has `validate()`, `isChanged()`, `toJSON()` |
| `_registry.gen.ts` | Imports all models + attaches their `.Client` classes |
| `_globals.gen.d.ts` | Global helper types used across the generated code |

::: tip Should I commit generated files?
Both approaches are valid:
- **Commit them** — zero CI setup, TypeScript works immediately after clone
- **Gitignore them** — add `**/*.model.gen.*`, `_registry.gen.*` to `.gitignore` and run codegen in CI before `tsc`

Committing is simpler for small teams. Gitignoring keeps diffs cleaner.
:::

## `.active-drizzle/schema.md`

An LLM-optimized schema reference generated at build time. It lists every model, column, enum, association, scope, and hook in a format tuned for AI assistants. Drop it into your system prompt so AI tools know your exact data model without hallucinating column names.
