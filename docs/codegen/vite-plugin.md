# Codegen & Vite Plugin

ActiveDrizzle ships a Vite plugin that automatically generates TypeScript type definitions from your Drizzle schema and model files at build time. No manual type declarations.

## What gets generated

For each model, the plugin emits a `.gen.d.ts` file with:

- **Column types** inferred from your Drizzle schema (`id: number`, `email: string`, etc.)
- **Attr transform types** — if you have `Attr.enum`, the type is the label union (`'pending' | 'paid' | 'shipped'`), not `number`
- **Association types** — `user: User`, `posts: Relation<Post>`, `comments: Comment[]`
- **Scope types** — static methods that return `Relation<T>` or computed values
- **Enum helpers** — `isPending()`, `toPending()`, `statusChanged()`, `statusWas()` etc.
- **A global `MODEL_REGISTRY` type** — know exactly which models exist at compile time

## Setup

```bash
npm install -D active-drizzle
```

```ts
// vite.config.ts
import { defineConfig }       from 'vite'
import { activeDrizzlePlugin } from 'active-drizzle/vite'

export default defineConfig({
  plugins: [
    activeDrizzlePlugin({
      schema:  './src/db/schema.ts',   // path to your Drizzle schema
      models:  './src/models/**/*.model.ts',  // glob for model files
      output:  './src/generated/',     // where to write .gen.d.ts files
    }),
  ],
})
```

## Options

| Option | Required | Description |
|--------|----------|-------------|
| `schema` | Yes | Path to your Drizzle schema file |
| `models` | Yes | Glob pattern matching your model files |
| `output` | Yes | Directory for generated `.gen.d.ts` files |
| `docs` | No | Path to write LLM-optimized markdown docs |
| `watch` | No | Re-run codegen on file change (default: true in dev mode) |

## Generated file example

Given this model:

```ts
// schema.ts
export const orders = pgTable('orders', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  status:     integer('status').notNull().default(0),
  totalCents: integer('total_cents').notNull(),
  userId:     integer('user_id').notNull(),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
})
```

```ts
// models/Order.model.ts
@model('orders')
export class Order extends ApplicationRecord {
  static status = Attr.enum({ pending: 0, paid: 1, shipped: 2 } as const)
  static totalCents = Attr.new({ get: v => v / 100, set: v => v * 100 })
  static user = belongsTo()
  static lineItems = hasMany()

  @scope
  static recent() { return this.order('createdAt', 'desc') }
}
```

The plugin generates:

```ts
// generated/Order.gen.d.ts
declare module './models/Order.model.js' {
  interface Order {
    id: number
    status: 'pending' | 'paid' | 'shipped'
    totalCents: number      // Attr.new get return type inferred
    userId: number
    createdAt: Date

    // Dirty tracking (from Attr.enum)
    statusChanged(): boolean
    statusWas(): 'pending' | 'paid' | 'shipped' | undefined
    isPending(): boolean
    isPaid(): boolean
    isShipped(): boolean
    toPending(): this
    toPaid(): this
    toShipped(): this

    // Associations
    user: Promise<User>
    lineItems: Relation<LineItem>
  }

  interface typeof Order {
    recent(): Relation<Order>
  }
}
```

## Running codegen manually

```bash
npx active-drizzle generate \
  --schema ./src/db/schema.ts \
  --models './src/models/**/*.model.ts' \
  --output ./src/generated/
```

## LLM docs output

Pass `docs` to also emit a markdown file optimized for AI assistants:

```ts
activeDrizzlePlugin({
  schema: './src/db/schema.ts',
  models: './src/models/**/*.model.ts',
  output: './src/generated/',
  docs:   './SCHEMA_DOCS.md',   // emitted at build time
})
```

The docs file includes:
- Complete table/column inventory with types and nullable flags
- All associations with FK topology
- All scopes with their signatures
- All enum values with their integer representations
- All virtual/computed attributes

This file can be included in your system prompt so LLMs understand your exact data model without hallucinating column names.

## Validation

The plugin runs a **validator** before generating. It checks:

- Every `belongsTo`/`hasMany`/`habtm` association resolves to a real model and table
- Every `@scope` method referenced in conditions exists on the model
- STI subclasses reference a real parent model in the registry
- `Attr.for` column names exist in the schema

Errors are reported as build-time TypeScript diagnostics with "did you mean?" suggestions (Levenshtein distance). A misconfigured model will fail the build instead of silently emitting wrong types.

## Without Vite (Node / plain TypeScript)

Use the programmatic API:

```ts
import { generate } from 'active-drizzle/codegen'

await generate({
  schema:  './src/db/schema.ts',
  models:  './src/models/**/*.model.ts',
  output:  './src/generated/',
})
```

Or call `runCodegen()` from within your application startup for always-fresh types in monorepo setups.
