<p align="center">
  <img src="docs/public/logo.svg" width="80" height="80" alt="ActiveDrizzle logo" />
</p>

<h1 align="center">ActiveDrizzle</h1>

<p align="center">
  <strong>Rails-style ActiveRecord for Drizzle ORM.</strong><br/>
  Associations. Lifecycle hooks. Dirty tracking. Enum transforms. Full TypeScript codegen.<br/>
  <em>Write three files. Get a full-stack feature.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@active-drizzle/core"><img src="https://img.shields.io/npm/v/@active-drizzle/core?style=flat-square&color=3B82F6&label=core" alt="npm core"></a>
  <a href="https://www.npmjs.com/package/@active-drizzle/controller"><img src="https://img.shields.io/npm/v/@active-drizzle/controller?style=flat-square&color=3B82F6&label=controller" alt="npm controller"></a>
  <a href="https://www.npmjs.com/package/@active-drizzle/react"><img src="https://img.shields.io/npm/v/@active-drizzle/react?style=flat-square&color=3B82F6&label=react" alt="npm react"></a>
  <a href="https://github.com/Danieth/active-drizzle/actions"><img src="https://img.shields.io/github/actions/workflow/status/Danieth/active-drizzle/ci.yml?style=flat-square&label=tests" alt="CI"></a>
  <a href="https://danieth.github.io/active-drizzle/"><img src="https://img.shields.io/badge/docs-live-blue?style=flat-square" alt="Docs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

---

Today, adding a feature to a typical TypeScript app means touching **8–12 files**. Schema. Drizzle table. Backend types. API route. Validation logic. Frontend types (duplicated). Fetch function. React Query hook. Cache key. Optimistic update logic. Form validation (duplicated again). Component.

**With ActiveDrizzle, you touch three.**

```
Schema → Model → Controller → done.
```

Everything else — oRPC procedures, Zod schemas, React Query hooks, TypeScript types, form configs, cache invalidation — is generated at build time by a Vite plugin.

> **[Read the full documentation →](https://danieth.github.io/active-drizzle/)**

---

## Install

```bash
npm install @active-drizzle/core @active-drizzle/controller @active-drizzle/react
```

## The Three Files

### 1. Schema — your Drizzle table (you already have this)

```ts
// db/schema.ts
export const campaigns = pgTable('campaigns', {
  id:        serial('id').primaryKey(),
  teamId:    integer('team_id').notNull().references(() => teams.id),
  name:      varchar('name', { length: 255 }).notNull(),
  status:    integer('status').notNull().default(0),
  budget:    integer('budget'),
  startDate: timestamp('start_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

### 2. Model — your business logic

```ts
// models/Campaign.model.ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static team    = belongsTo()
  static creator = belongsTo('users', { foreignKey: 'creatorId' })
  static status  = Attr.enum({ draft: 0, active: 1, paused: 2, completed: 3 } as const)

  @scope static active() { return this.where({ status: 1 }) }
  @scope static search(q: string) { return this.where({ name: ilike(`%${q}%`) }) }

  @pure isEditable() { return ['draft', 'paused'].includes(this.status) }
}
```

### 3. Controller — your HTTP API

```ts
// controllers/Campaign.ctrl.ts
@controller('/campaigns')
@crud(Campaign, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),
  index:   { scopes: ['active'], sortable: ['createdAt', 'name'], include: ['creator'] },
  create:  { permit: ['name', 'budget', 'status'], autoSet: { creatorId: ctx => ctx.userId } },
  update:  { permit: ['name', 'budget', 'status'] },
})
@scope('teamId')
export class CampaignController extends OrgController {
  @mutation()
  async launch(campaign: Campaign) {
    if (!campaign.isEditable()) throw new BadRequest('Cannot launch')
    campaign.status = 'active'
    campaign.startDate = new Date()
    return campaign.save()
  }
}
```

### What you get (generated)

Save those three files. Your terminal shows:

```
✓ Campaign.model.ts  → Campaign.model.gen.d.ts (2 scopes, 4 enum values, 2 associations)
✓ Campaign.ctrl.ts   → campaign.router.gen.ts  (7 routes: index, get, create, update, destroy, launch)
✓ Campaign.ctrl.ts   → Campaign.client.gen.ts  (React Query hooks, form config, typed client model)
✓ _routes.gen.ts updated (7 new endpoints)
```

You now have:
- **Full REST API** with nested routes, scoping, and Zod validation
- **oRPC procedures** for type-safe client-server calls
- **React Query hooks** with cache invalidation
- **A typed client model** with enum predicates, dirty tracking, and inline validation
- **TypeScript types everywhere** — columns, associations, write shapes, read shapes

### Use it in React

```tsx
import { CampaignController } from '../_generated'

function CampaignsPage({ teamId }: { teamId: number }) {
  const ctrl = CampaignController.use({ teamId })

  const { data } = ctrl.index({ scopes: ['active'], sort: { field: 'createdAt', dir: 'desc' } })
  const launch = ctrl.mutateLaunch()

  return data?.items.map(c => (
    <div key={c.id}>
      <h3>{c.name}</h3>
      <span>{c.status}</span>  {/* 'active' | 'draft' | 'paused' — not an integer */}
      {c.isEditable() && (
        <button onClick={() => launch.mutate(c.id)}>Launch</button>
      )}
    </div>
  ))
}
```

---

## Why ActiveDrizzle?

### vs. plain Drizzle

Drizzle is a great query builder. ActiveDrizzle sits on top of it and adds everything you keep rebuilding by hand:

| You keep writing... | ActiveDrizzle gives you |
|---|---|
| `db.select().from(assets).where(eq(assets.teamId, teamId))` | `Asset.where({ teamId })` |
| Manual enum maps + helper functions | `static status = Attr.enum({ draft: 0, active: 1 })` → `asset.isActive()` |
| No dirty tracking | `asset.nameChanged()`, `asset.nameWas()`, `asset.changedFields()` |
| No associations | `belongsTo()`, `hasMany()`, `hasOne()`, `habtm()` — lazy-loaded |
| No lifecycle hooks | `@beforeSave()`, `@afterCommit()`, `@validate()` |
| N+1 queries by default | `User.includes('posts', 'avatar').load()` — one query |
| Copy-paste validation everywhere | Define once in the model, enforced on server + generated for forms |

### vs. Prisma

| | Prisma | ActiveDrizzle |
|---|---|---|
| Query builder | Prisma Client (generated) | Drizzle (you own the SQL) |
| Schema source | `schema.prisma` DSL | Standard Drizzle `pgTable()` |
| Associations | Implicit via schema | Explicit: `belongsTo()`, `hasMany()` |
| Lifecycle hooks | Middleware (limited) | Full Rails-style hooks with conditions |
| Dirty tracking | None | Built-in |
| Enum transforms | Mapped enums only | Integer ↔ label with predicates |
| Frontend codegen | None | React Query hooks, form configs, typed clients |
| STI | Not supported | Full Single Table Inheritance |

### vs. Rails ActiveRecord

| | Rails | ActiveDrizzle |
|---|---|---|
| Language | Ruby | TypeScript |
| Type safety | Runtime only | Compile-time via codegen |
| Error discovery | Production at 3am | Build step catches it |
| Frontend | Separate API + separate types | Generated typed hooks from the same model |
| Performance | Ruby | V8 + Drizzle SQL |

ActiveDrizzle catches at **build time** what Rails only finds at runtime:

```
ERROR  Campaign.model.ts — Association "assets": column "campaignId" not found on table "assets"
ERROR  TextMessage.model.ts — Enum "status": expects INTEGER column but found "text"
WARN   Campaign.model.ts — no bidirectional belongsTo found on Asset
```

---

## Features

### Models

- **Chainable queries** — `.where()`, `.order()`, `.limit()`, `.includes()`, `.pluck()`, `.count()`
- **Associations** — `belongsTo`, `hasMany`, `hasOne`, `habtm`, with `through:`, `dependent: 'destroy'`, `counterCache`, `autosave`
- **Attr transforms** — `Attr.enum()`, `Attr.json<T>()`, `Attr.string()`, `Attr.boolean()`, `Attr.new({ get, set })`
- **Dirty tracking** — `isChanged()`, `changedFields()`, `fieldWas()`, `fieldChanged()`
- **Lifecycle hooks** — `@beforeSave`, `@afterCommit`, `@beforeDestroy`, `@validate`, with `{ if: }` conditions
- **Scopes** — `@scope static active() { ... }` → chainable, composable named queries
- **STI** — `static stiType = 1000` → auto-filters, instantiates correct subclass
- **Transactions** — `ApplicationRecord.transaction(async () => { ... })` via `AsyncLocalStorage`
- **Nested attributes** — `hasMany({ acceptsNested: true })` → create/update/destroy children in one save
- **Custom primary keys** — composite keys, non-`id` columns

### Controllers

- **`@crud`** — index, get, create, update, destroy from one decorator
- **`@mutation`** — auto-loads record by `:id`, passes to method. `{ bulk: true, records: false }` for efficient mass updates
- **`@action`** — custom GET/POST endpoints for stats, imports, background jobs
- **`@before` / `@after`** — lifecycle hooks with `{ only: }`, `{ except: }`, `{ if: }` conditions
- **`@rescue`** — Rails-style error handling. `RecordNotFound` → 404 automatically
- **`@scope`** — URL nesting: `@scope('teamId')` → `/teams/:teamId/campaigns`
- **`scopeBy`** — scope queries from resolved controller state (multi-tenant)
- **`autoSet`** — stamp fields from context or state on create
- **Dynamic `permit`** — `(ctx, ctrl) => string[]` for role-based field access
- **Multi-tenant** — `this.state` with typed inheritance. Resolve org once, use everywhere

### React Integration

- **Generated hooks** — `ctrl.index()`, `ctrl.get(id)`, `ctrl.mutateCreate()`, `ctrl.mutateLaunch()`
- **TanStack Form config** — default values, enum options, validators from model metadata
- **Error parsing** — `parseControllerError()` maps 422 responses to per-field errors
- **Client model** — typed instances with predicates, dirty tracking, validation on the frontend

### Build-Time Codegen

- **Vite plugin** — watches `.model.ts` and `.ctrl.ts` files, regenerates on save
- **Type declarations** — `.gen.d.ts` per model with associations, enum predicates, dirty tracking
- **Runtime code** — `.gen.ts` with `Model.Client` class for frontend hydration
- **oRPC router** — type-safe procedures with Zod validation schemas
- **LLM docs** — `.active-drizzle/schema.md` for AI-assisted development

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your Application                             │
├──────────────┬──────────────────┬──────────────────┬────────────────┤
│   Schema     │     Models       │   Controllers    │    React       │
│  (Drizzle)   │ (ApplicationRecord) │  (@crud, @mutation) │  (Generated)  │
├──────────────┴──────────────────┴──────────────────┴────────────────┤
│                    Vite Plugin (ts-morph codegen)                    │
│  Extracts → Validates → Generates types + runtime + hooks + router  │
├─────────────────────────────────────────────────────────────────────┤
│              @active-drizzle/core    │  @active-drizzle/controller  │
│  Relation, Attr, hooks, associations │  CRUD handlers, oRPC, REST  │
├──────────────────────────────────────┴──────────────────────────────┤
│                         Drizzle ORM                                 │
│                         PostgreSQL                                  │
└─────────────────────────────────────────────────────────────────────┘
```

Three npm packages, each installable independently:

| Package | What it is |
|---------|-----------|
| `@active-drizzle/core` | Models, associations, hooks, dirty tracking, Attr, codegen, Vite plugin |
| `@active-drizzle/controller` | `@crud`, `@mutation`, `@action`, `@before`/`@after`, `@rescue`, oRPC router, REST adapters |
| `@active-drizzle/react` | React Query hook generation, `ClientModel`, error parsing, form integration |

---

## Quick Start

```bash
npm install @active-drizzle/core drizzle-orm
```

```ts
// boot.ts
import { boot } from '@active-drizzle/core'
import { db } from './db'
import * as schema from './schema'

boot(db, schema)
```

```ts
// vite.config.ts
import activeDrizzle from '@active-drizzle/core/vite'

export default defineConfig({
  plugins: [
    activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/**/*.model.ts',
      controllers: 'src/controllers/**/*.ctrl.ts',
    }),
  ],
})
```

> **[Full getting started guide →](https://danieth.github.io/active-drizzle/guide/getting-started)**

---

## Documentation

The full documentation covers every feature with examples:

| Section | Topics |
|---------|--------|
| **[Getting Started](https://danieth.github.io/active-drizzle/guide/getting-started)** | Installation, boot, project structure |
| **[The Happy Path](https://danieth.github.io/active-drizzle/guide/happy-path)** | End-to-end: schema → model → controller → React |
| **[Models](https://danieth.github.io/active-drizzle/models/overview)** | Attributes, associations, STI, custom PKs |
| **[Querying](https://danieth.github.io/active-drizzle/querying/basics)** | where, order, includes, pluck, aggregates, scopes |
| **[Controllers](https://danieth.github.io/active-drizzle/controllers/overview)** | CRUD, mutations, actions, hooks, error handling, multi-tenant |
| **[React Query](https://danieth.github.io/active-drizzle/react/overview)** | Generated hooks, forms, error handling |
| **[Codegen](https://danieth.github.io/active-drizzle/codegen/vite-plugin)** | Vite plugin, what gets generated, how it works |

---

## Testing

```bash
npm test                                # 615+ tests across all packages
npm run test:coverage -w packages/core  # 96%+ line coverage
```

---

## Contributing

```bash
git clone https://github.com/Danieth/active-drizzle.git
cd active-drizzle
npm install --legacy-peer-deps
npm test
```

The repo is an npm workspaces monorepo. Each package builds with `tsup`. Tests use Vitest with `ts-morph` in-memory projects for codegen and mock DB instances for runtime tests.

---

## License

[MIT](LICENSE) — Daniel Ackerman
