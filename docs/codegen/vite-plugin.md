# Codegen

ActiveDrizzle reads your Drizzle schema, model files, and controller files at build time and generates:

- **TypeScript types** (`.gen.d.ts`) — column types, enums, associations, scopes, dirty tracking helpers
- **Client runtime** (`.gen.ts`) — an isomorphic `Model.Client` class that runs in the browser
- **Model registry** (`_registry.gen.ts`) — all models in one importable file
- **oRPC router** (`_routes.gen.ts`) — all controller routes merged into a single typed router
- **React hooks** (`use{Model}.gen.ts`) — typed TanStack Query hooks + form config per model
- **Schema docs** (`.active-drizzle/schema.md`) — LLM-optimized reference
- **Route docs** (`_routes.gen.md`) — LLM-optimized API surface reference

There are two ways to run codegen: **Vite plugin** (automatic, watches for changes) or **CLI** (manual, one-off).

---

## Option A: Vite plugin (recommended)

If your project uses Vite, the plugin runs codegen automatically whenever you save a model or schema file. Zero configuration after the initial setup.

### Setup

```ts
// vite.config.ts
import { defineConfig }        from 'vite'
import activeDrizzle           from 'active-drizzle/vite'

export default defineConfig({
  plugins: [
    activeDrizzle({
      schema:      'src/db/schema.ts',
      models:      'src/models/**/*.model.ts',
      controllers: 'src/controllers/**/*.ctrl.ts', // enables controller + hook codegen
      reactHooks:  true,                           // emits use{Model}.gen.ts files
      outputDir:   'src/models',                   // where _registry.gen.ts is written
    }),
  ],
})
```

### What happens automatically

**On `vite dev` start:**
1. All model files + schema are extracted via ts-morph (static analysis, no runtime needed)
2. Types and client classes are generated next to each model file
3. `_registry.gen.ts` and `schema.md` are emitted
4. Build-time validator runs — misconfigured associations, wrong enum column types, broken STI → terminal errors with "did you mean?" suggestions

**On every `.model.ts` save:**
1. Only the changed file is re-extracted (mtime cache — unchanged models are free)
2. Only models with changed associations are re-validated (bidirectional dep graph)
3. Global files (`_registry`, `schema.md`) are regenerated only if the model list changed
4. Files are written only when content actually differs (prevents spurious HMR rounds)

**On every `.ctrl.ts` save:**
1. All controller files are re-scanned with mtime caching (unchanged files are skipped)
2. `_routes.gen.ts` and `_routes.gen.md` regenerate only when the combined hash changes
3. If `reactHooks: true`, updated `use{Model}.gen.ts` files emit only for controllers that changed

**On `vite build`:**
Codegen runs once before the TypeScript compiler sees anything. If the validator finds errors, the build fails with descriptive messages.

### Options

```ts
activeDrizzle({
  schema:      'src/db/schema.ts',              // required — path to Drizzle schema
  models:      'src/models/**/*.model.ts',      // required — glob for model files
  controllers: 'src/controllers/**/*.ctrl.ts',  // optional — enables controller codegen
  reactHooks:  true,                            // optional — emits use{Model}.gen.ts per controller
  outputDir:   'src/models',                    // optional — where registry goes (default: first model's dir)
  tsconfig:    'tsconfig.json',                 // optional — tsconfig for ts-morph (default: ./tsconfig.json)
})
```

---

## Option B: CLI / programmatic (Next.js, Express, plain Node)

For non-Vite projects, run codegen as a build step or on demand.

### As an npm script

Add a `codegen` script to `package.json`:

```json
{
  "scripts": {
    "codegen": "active-drizzle generate --schema src/db/schema.ts --models 'src/models/**/*.model.ts' --output src/models",
    "build": "npm run codegen && tsc",
    "dev": "npm run codegen && tsx watch src/app.ts"
  }
}
```

Run it:

```bash
npm run codegen
```

### Programmatic API

```ts
// scripts/codegen.ts
import { runCodegen } from 'active-drizzle/codegen'

await runCodegen({
  schema:    'src/db/schema.ts',
  models:    'src/models/**/*.model.ts',
  outputDir: 'src/models',
})
```

```bash
npx tsx scripts/codegen.ts
```

### With Next.js

Add codegen to your `next.config.ts`:

```ts
// next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  webpack(webpackConfig, { isServer, dev }) {
    if (isServer && dev) {
      // Run codegen once at dev server start
      import('active-drizzle/codegen').then(({ runCodegen }) =>
        runCodegen({
          schema:  './src/db/schema.ts',
          models:  './src/models/**/*.model.ts',
          outputDir: './src/models',
        })
      )
    }
    return webpackConfig
  },
}

export default config
```

Or just run it once before starting Next:

```bash
npm run codegen && next dev
```

---

## What gets generated — in detail

### `User.model.gen.d.ts` — type augmentation

Uses TypeScript's [module augmentation](https://www.typescriptlang.org/docs/handbook/declaration-merging.html) to add properties to your model class without touching your source file.

```ts
// What gets generated for a User model with:
//   static status = Attr.enum({ active: 0, banned: 1 })
//   static posts   = hasMany()

declare module './User.model' {
  interface User {
    // Column types from schema.ts
    id: number
    email: string
    status: 'active' | 'banned'   // ← enum label, not raw integer
    createdAt: Date

    // Enum helpers (auto-generated for every Attr.enum)
    isActive(): boolean
    isBanned(): boolean
    toActive(): this
    toBanned(): this
    statusChanged(): boolean
    statusWas(): 'active' | 'banned' | undefined

    // Dirty tracking (every column)
    emailChanged(): boolean
    emailWas(): string | undefined

    // Associations
    posts: Relation<PostRecord, PostAssociations>
  }

  namespace User {
    // Scopes and query methods
    function all(): Relation<UserRecord, UserAssociations>
    function where(condition?: UserWhere): Relation<UserRecord, UserAssociations>
    function active(): Relation<UserRecord, UserAssociations>
  }
}

// Typed Create / Update / Where interfaces
export interface UserCreate {
  email: string
  status?: 'active' | 'banned'
}
export type UserUpdate = Partial<UserCreate> & { id: number }
export interface UserWhere { ... }
```

### `User.model.gen.ts` — isomorphic Client class

A plain class (no Proxy, no DB connection) that runs in the browser. Used by form libraries, validation, and serialization.

```ts
// Usage: import { User } from './User.model.gen.js'
// new User.Client(serverPayload) gives you a typed object with validation

const draft = new User.Client({ email: 'alice@example.com', status: 'active' })
draft.isChanged()                 // → false
draft.email = 'new@example.com'
draft.isChanged()                 // → true
draft.validate()                  // → {} (runs all @validate methods)
```

### `_registry.gen.ts` — model registry

Imports all models and attaches their `.Client` classes. Import this once at your app entry to ensure all models are registered.

```ts
import { User, Post, Comment } from './models/_registry.gen.js'
// All models are now registered and their .Client classes are available
```

### `.active-drizzle/schema.md` — LLM docs

A markdown file listing every model, column type, enum value, association, scope, and hook. Designed to be dropped into an AI assistant's system prompt so it has accurate knowledge of your schema without guessing.

---

## Build-time validator

The validator runs on every codegen invocation and catches mistakes before TypeScript:

```
[active-drizzle] ERROR src/models/Post.model.ts:
  Association "author": table "authors" not found in schema. Did you mean "users"?

[active-drizzle] ERROR src/models/Order.model.ts:
  Enum "status": expects INTEGER column but found "text". Update the schema column type.

[active-drizzle] WARN src/models/Post.model.ts:
  Association "user": no bidirectional hasMany found on "User" pointing back to "posts".
```

Errors fail the build. Warnings print but allow codegen to continue.

| Check | Severity |
|-------|----------|
| Association target table not found in schema | Error |
| FK column missing from table | Error (hasMany) / Warning (belongsTo) |
| `through` join table not in schema | Error |
| Enum column is text but values are integers | Error |
| `Attr.set()` return type mismatches column type | Error |
| STI parent model not found | Error |
| STI parent table has no `type` discriminator column | Error |
| Missing bidirectional inverse | Warning |
| Scope references unknown column | Warning |

"Did you mean?" suggestions use Levenshtein distance — a typo like `"businesz"` suggests `"businesses"`.
