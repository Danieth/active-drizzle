# Installation & Boot

## Requirements

| Dependency | Minimum version |
|------------|----------------|
| Node.js | 18+ |
| TypeScript | 5.0+ |
| drizzle-orm | 0.30+ |
| Drizzle driver | any (`pg`, `mysql2`, `better-sqlite3`, …) |

## Install

```bash
npm install active-drizzle
```

## `boot(db, schema)`

Call `boot` **once** before any model code runs — typically right after creating your Drizzle client:

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { boot }   from 'active-drizzle'
import * as schema from './schema.js'

const db = drizzle(process.env.DATABASE_URL!, { schema })

boot(db, schema)
```

::: tip
Pass the **full schema object** (the `* as schema` import). ActiveDrizzle uses it for `db.query.<table>` relational lookups, association resolution, and eager loading.
:::

::: warning
`boot` must be called before the first `Model.find()` / `Model.create()` / etc. call. In tests, call it in a `beforeAll` or `beforeEach` block.
:::

## TypeScript config

Add `experimentalDecorators` to your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": false,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

## With Next.js / Express

Create a singleton module that calls `boot` once:

```ts
// lib/db.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool }    from 'pg'
import { boot }    from 'active-drizzle'
import * as schema from '@/db/schema.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle({ client: pool, schema })

boot(db, schema)
```

Import this module at your app entry point and all models will have access to the database.
