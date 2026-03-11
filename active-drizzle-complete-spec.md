# Active-Drizzle: Complete Build Spec
# From "ActiveRecord done" → "Full Rails-to-React Framework"

---

## The Vision (Read This First)

The goal is a system where adding a feature means touching **three files** — schema, model, controller — and everything else is generated. This is what it looks like in practice:

```
TASK: "Add a 'campaigns' resource to AdioPilot."

TIME: 15 minutes.
```

```typescript
// Step 1: schema.ts — add the table (2 min)
export const campaigns = pgTable('campaigns', {
  id:        serial('id').primaryKey(),
  teamId:    integer('team_id').notNull().references(() => teams.id),
  creatorId: integer('creator_id').references(() => users.id),
  name:      varchar('name', { length: 255 }).notNull(),
  budget:    integer('budget'),
  status:    integer('status').notNull().default(0),
  startDate: timestamp('start_date'),
  assetIds:  jsonb('asset_ids').default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

```typescript
// Step 2: Campaign.model.ts — the entire domain (5 min)
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static team    = belongsTo()
  static creator = belongsTo('users', { foreignKey: 'creatorId' })
  static status  = defineEnum({ draft: 0, active: 1, paused: 2, completed: 3 })

  static validations = [
    validates('name', presence(), length({ min: 2, max: 255 })),
    validates('budget', numericality({ gte: 0 }), { allowBlank: true }),
  ]

  @scope static active()         { return this.where({ status: 1 }) }
  @scope static upcoming()       { return this.where(and(eq(campaigns.status, 0), gt(campaigns.startDate, sql`now()`))) }
  @scope static search(q: string) { return this.where(ilike(campaigns.name, `%${q}%`)) }

  @pure assetCount(): number  { return (this.assetIds ?? []).length }
  @pure hasAssets(): boolean  { return this.assetCount() > 0 }
  @pure isEditable(): boolean { return ['draft', 'paused'].includes(this.status) }
}
```

```typescript
// Step 3: Campaign.ctrl.ts — the entire API (3 min)
@controller()
@crud(Campaign, {
  index: {
    scopes: ['draft', 'active', 'paused', 'completed', 'upcoming'],
    defaultScopes: ['active'],
    paramScopes: ['search'],
    sortable: ['createdAt', 'name', 'budget', 'startDate'],
    defaultSort: { field: 'createdAt', dir: 'desc' },
    filterable: ['status', 'creatorId'],  // codegen infers enum/relation type from the model
    include: ['creator'],
  },
  create: {
    permit: ['name', 'budget', 'status', 'startDate', 'assetIds'],
    autoSet: { creatorId: (ctx) => ctx.user.id },
  },
  update: { permit: ['name', 'budget', 'status', 'startDate', 'assetIds'] },
  get:    { include: ['team', 'creator'] },
})
@scope('teamId')
export class CampaignController extends TeamController {
  @mutation
  async launch(campaign: Campaign) {
    if (!campaign.hasAssets()) throw new BadRequest('Add assets before launching')
    campaign.status = 'active'
    campaign.startDate = new Date()
    return campaign.save()
  }

  @mutation
  async pause(campaign: Campaign) {
    campaign.status = 'paused'
    return campaign.save()
  }
}
```

```
Step 4: Save all three files.

Terminal output:
  ✓ Campaign.model.ts     → Campaign.model.gen.d.ts
                            (4 scopes, 4 enum values, 2 associations, 3 @pure methods)
  ✓ Campaign.ctrl.ts      → campaign.router.gen.ts
                            (7 routes: index, get, create, update, destroy, launch, pause)
  ✓ Campaign.ctrl.ts      → Campaign.client.gen.ts
                            (client model, search config, React Query hooks, combobox support)
  ✓ Bidirectional:          Team.model.gen.d.ts updated (added campaigns association)
  ✓                         _routes.gen.ts updated (8 new endpoints)
  ✓                         _globals.gen.d.ts updated

You have:
  - Full REST API with nested routes (/teams/:teamId/campaigns/...)
  - oRPC procedures with Zod validation
  - Frontend model with predicates, dirty tracking, validation
  - React Query hooks with optimistic updates
  - Search/filter system with URL sync
  - Combobox support
  - TypeScript types everywhere

Step 5: There is no step 5. Build the page.
```

**The principle:** You think in domain objects. The system thinks in HTTP, SQL, cache keys, TypeScript, and React for you. Never duplicate a validation rule. Never write a cache key by hand. Never touch an API type that doesn't come from the model.

**The constraint:** Every feature in this spec must be extracted from AdioPilot use cases — not invented in a vacuum. Build with AdioPilot, extract the pattern, generalize it.

---

## Current State (DONE — @active-drizzle/core)

- [x] ApplicationRecord, Proxy instances, Attr system
- [x] Dirty tracking, enum transforms, JSON serialization
- [x] Chainable Relation (where, order, limit, first, find, pluck, etc.)
- [x] Associations (belongsTo, hasMany, hasOne, habtm, through, dependent, counterCache, autosave, acceptsNested, declarative order)
- [x] Transactions via AsyncLocalStorage
- [x] Lifecycle hooks (before/after, conditional, afterCommit)
- [x] Validations (inline, class-level, async server)
- [x] STI with stiType auto-scoping
- [x] withLock, inBatches, updateAll, destroyAll
- [x] Codegen: .gen.d.ts (module augmentation), .gen.ts (Model.Client), _registry.gen.ts
- [x] Build-time validator with "did you mean?" (Levenshtein)
- [x] Vite plugin with incremental compilation (mtime cache, hash guard, content-diff writes)
- [x] CLI codegen
- [x] 258+ tests
- [x] VitePress docs deployed to GitHub Pages

---

## Phase 0: Monorepo Scaffold + Publish Core

**Goal:** Lock in the npm namespace, establish the package structure, publish v0.1.0 before building anything new.

**Rule:** Keep Turborepo out for now. Plain workspace configuration (bun/npm workspaces) is enough for 4 packages.

### 0.1 — Monorepo structure

```
active-drizzle/
├── packages/
│   ├── core/          ← @active-drizzle/core  (move current src/ here)
│   ├── controller/    ← @active-drizzle/controller
│   ├── codegen/       ← @active-drizzle/codegen
│   └── react/         ← @active-drizzle/react
├── package.json       ← workspace root (bun workspaces)
└── active-drizzle/    ← meta-package (re-exports all four)
```

- [ ] Create `packages/core/` — move `src/`, `tests/`, `tsup.config.ts`, `vitest.config.ts` into it
- [ ] Update `package.json` at root to declare workspace members
- [ ] Create stub `package.json` for controller, codegen, react (names only, no code yet)
- [ ] Create meta-package `active-drizzle/` that re-exports all four as its dependencies
- [ ] Verify `bun test` still passes from root (delegates to core workspace)
- [ ] Verify `bun run build` still works in `packages/core/`

### 0.2 — Publish @active-drizzle/core v0.1.0

- [ ] Rename current `active-drizzle` → `@active-drizzle/core` in `packages/core/package.json`
- [ ] Verify exports: `@active-drizzle/core` (model layer) and `@active-drizzle/core/vite` (codegen plugin)
- [ ] `bun run prepublishOnly` passes (build + test)
- [ ] `npm publish --access public` from `packages/core/`
- [ ] Publish the meta-package `active-drizzle` v0.1.0 that depends on `@active-drizzle/core`

---

## Phase 1: Controller Runtime

**Goal:** Backend controllers that map models → oRPC procedures + REST routes. Pure runtime. No codegen yet.

**Validation gate:** Build teams, assets, campaigns resources in AdioPilot before generalizing. If a controller feature isn't needed by those three, defer it.

**Package:** `packages/controller/` → `@active-drizzle/controller`
**Peer deps:** `@active-drizzle/core`, `@orpc/server`, `zod`
**Entry:** `@active-drizzle/controller`

### 1.1 — Package Scaffolding

- [ ] `packages/controller/package.json` with peer deps
- [ ] `tsup.config.ts` — ESM + CJS, external: core/drizzle/orpc/zod
- [ ] `tsconfig.json` extending root
- [ ] Test setup: vitest + real Postgres (reuse testcontainers pattern from core)

### 1.2 — Error Classes

Define these first — every other piece depends on them.

```typescript
export class HttpError extends Error { constructor(public status: number, message: string) }
export class BadRequest     extends HttpError { constructor(msg: string) { super(400, msg) } }
export class Unauthorized   extends HttpError { constructor(msg = 'Not authenticated') { super(401, msg) } }
export class Forbidden      extends HttpError { constructor(msg: string) { super(403, msg) } }
export class NotFound       extends HttpError { constructor(model: string) { super(404, `${model} not found`) } }
export class ValidationError extends HttpError {
  constructor(public errors: Record<string, string[]>) { super(422, 'Unprocessable') }
}
```

Error response shapes:
- 400/401/403/404: `{ error: 'message' }`
- 422: `{ errors: { field: ['message', ...] } }` — TanStack Form consumes this directly

- [ ] Error classes defined with correct shapes
- [ ] `formatValidationErrors(model)` — converts model `.errors` to 422 shape

### 1.3 — ActiveController Base Class

```typescript
class ActiveController<TContext> {
  protected context: TContext
  protected params: Record<string, any>
  protected db: DrizzleDB  // from boot()
  protected relation: Relation<any>  // pre-scoped by @crud + @scope
}
```

- [ ] Generic over `TContext` (user provides their auth shape)
- [ ] `this.context`, `this.params`, `this.db`, `this.relation` available in all methods
- [ ] Method resolution order: parent `@before` hooks fire before child `@before` hooks

### 1.4 — @controller Decorator

- [ ] Class decorator, sets base route path
- [ ] Path inference from class name: `CampaignController` → `/campaigns`
- [ ] Explicit override: `@controller('/admin/campaigns')`
- [ ] Stores metadata on class via Symbol

### 1.5 — @scope Decorator

- [ ] Class decorator, takes field name string: `@scope('teamId')`
- [ ] Nests routes under parent resource: `/teams/:teamId/campaigns`
- [ ] Auto-adds `where({ teamId: params.teamId })` to `this.relation`
- [ ] Auto-sets field on create: `create.autoSet` gets `{ teamId: params.teamId }` added
- [ ] Validates parent ID is a number, throws `BadRequest` if not
- [ ] Multiple `@scope` stacking: `@scope('teamId') @scope('campaignId')` → both apply

### 1.6 — @crud Decorator + Default Handlers

**Config shape** (corrected — no frontend concerns in controller config):

```typescript
{
  index?: {
    scopes?: string[]          // model scope names the frontend can activate
    defaultScopes?: string[]   // always applied
    paramScopes?: string[]     // model scope methods that take a string argument
    sortable?: string[]        // column names allowed in ORDER BY (SQL injection prevention)
    defaultSort?: { field: string; dir: 'asc' | 'desc' }
    filterable?: string[]      // column names — codegen infers enum/relation type from model
    include?: string[]         // default eager-loaded associations
    perPage?: number           // default 25
    maxPerPage?: number        // default 100
  }
  create?: {
    permit?: string[]          // explicit allowlist
    restrict?: string[]        // explicit denylist (alternative to permit)
    autoSet?: Record<string, (ctx: TContext) => any>
  }
  update?: {
    permit?: string[]
    restrict?: string[]
  }
  get?: {
    include?: string[]
  }
}
```

**Auto-exclusion rules** (no explicit permit needed for most models):
- Always excluded from create + update: `id`, `createdAt`, `updatedAt`
- Auto-excluded from create: columns covered by `@scope` (e.g., `teamId`)
- Auto-excluded from create: columns covered by `autoSet`
- If neither `permit` nor `restrict` specified: all columns minus auto-excluded

**Default index handler — exact execution order:**
1. Start with `Model.all()` (returns Relation)
2. Apply `@scope` where clauses
3. Apply `defaultScopes`
4. Apply requested `scopes` from params (validate against allowed list — reject unknown)
5. Apply `paramScopes` with their arguments (e.g., `search` → `.search(params.search)`)
6. Apply column `filterable` filters from params
   - Enum columns: accept label string, convert to integer via model Attr.enum
   - Relation columns (ending in `Id`): accept number or number[]
   - Boolean columns: accept boolean
   - Unknown filter keys: reject with 400
7. Apply `ids` param if present: `.where({ id: params.ids })` — still respects scope (security)
8. Apply `sort`: validate field against `sortable` list (prevent SQL injection), validate dir
   - Enum columns sorted by raw integer value, not label string
   - Unknown sort field: 400
9. Apply pagination: `.limit(perPage).offset(page * perPage)`, enforce `maxPerPage`
10. Apply `include` associations
11. Execute query + separate `COUNT(*)` query
12. Return `{ data, pagination: { page, perPage, totalCount, totalPages, hasMore } }`

**Default handlers:**
- `index`: as above
- `get`: load by `:id` within `this.relation`, apply `get.include`, 404 if not found
- `create`: validate permit/restrict, apply `autoSet`, create via `this.relation`, return 201 or 422
- `update`: load by `:id`, apply permitted changes, `.save()`, return record or 422
- `destroy`: load by `:id`, `.destroy()`, return 204

User overrides any default by defining the method on the controller class.

- [ ] `@crud` class decorator stores config on class via Symbol
- [ ] `ActiveController` reads config at construction, builds `this.relation`
- [ ] Default index handler with all 12 steps
- [ ] Default get/create/update/destroy handlers
- [ ] Method override detection (if user defines `index()`, use theirs)

### 1.7 — @singleton Decorator

```typescript
@singleton(TeamSettings, {
  findBy: (ctx) => ({ teamId: ctx.params.teamId }),
  findOrCreate: true,
  defaultValues: { timezone: 'UTC' },
  update: { permit: ['timezone', 'notificationsEnabled'] },
})
```

- [ ] No index route, no `:id` in URL
- [ ] `findOrCreate` race-safe: `INSERT ... ON CONFLICT DO NOTHING`, retry `SELECT` on 23505
- [ ] Routes: `GET/PATCH/DELETE` at base path
- [ ] `findOrCreate: true` adds a `POST` route (upsert semantics)

### 1.8 — @mutation Decorator

```typescript
@mutation
async launch(campaign: Campaign) { ... }

@mutation({ bulk: true })
async archive(campaigns: Campaign[]) { ... }

@mutation({ optimistic: { status: 'active' } })  // explicit hint for complex logic
async complexTransition(campaign: Campaign) { ... }
```

- [ ] Non-bulk: auto-loads record by `:id` within `this.relation`, passes as first arg
- [ ] Bulk: accepts `ids` array from params, loads all within `this.relation`, passes array
- [ ] Route: `POST /resources/:id/<methodName>` (non-bulk) or `POST /resources/<methodName>` (bulk)
- [ ] Method name → kebab-case route segment: `bulkArchive` → `bulk-archive`
- [ ] Stores `optimistic` hints on metadata for codegen to read later (Phase 4)

### 1.9 — @action Decorator (Plain Controllers)

```typescript
@controller()
export class UploadController extends TeamController {
  @action('POST')
  async presign(params: { filename: string; contentType: string }) {
    const url = await s3.getSignedUrl(...)
    return { uploadUrl: url, fileUrl: `https://cdn.example.com/${key}` }
  }
}
```

- [ ] Method decorator, takes HTTP method + optional path override
- [ ] Explicit route registration, no auto-loading, no model
- [ ] Works with plain `context` + `params` only

### 1.10 — @before / @after Hooks

```typescript
export class TeamController extends ActiveController<AppContext> {
  @before()
  async loadTeam() {
    this.team = await Team.find(this.params.teamId)
  }
}

@controller()
export class CampaignController extends TeamController {
  @before({ only: ['create', 'update'] })
  checkEditorPermissions() {
    if (!this.context.user.canEdit(this.team)) throw new Forbidden('...')
  }
}
```

- [ ] `@before({ only?, except?, if? })` — method decorator
- [ ] `only`/`except`: array of action names
- [ ] `if`: string (method name on controller) or `() => boolean`
- [ ] Inherited from parent class via prototype chain walk (parent hooks fire first)
- [ ] `@before` returning `false` or throwing aborts the action
- [ ] Same interface for `@after`

### 1.11 — oRPC Router (Runtime)

Each controller produces an oRPC router at boot time. Zod schemas are runtime-generated from model metadata + controller config (not from codegen — that's Phase 2).

- [ ] `buildRouter(ControllerClass)` — produces oRPC `router` with all procedures
- [ ] Runtime Zod schema generation for index/get/create/update/destroy/mutations
- [ ] `mergeRouters(...routers)` — combines all controllers into one root router
- [ ] Procedures have typed input shapes even before codegen (from runtime inference)

### 1.12 — REST Adapters

- [ ] `honoAdapter(router)` — mounts oRPC router as Hono routes
- [ ] `expressAdapter(router)` — mounts oRPC router as Express middleware
- [ ] Maps oRPC procedure names to REST paths + HTTP methods

### 1.13 — Content Negotiation (optional, implement after core works)

- [ ] Reads `Accept` header
- [ ] `application/json` → `JSON.stringify` (default)
- [ ] `application/msgpack` → msgpack encode (opt-in via boot config)
- [ ] Request body always JSON for now

### 1.14 — Tests

Write these against real Postgres using the AdioPilot resources (teams, assets, campaigns) as test subjects.

- [ ] Default CRUD: all 5 actions work with zero overrides
- [ ] `@scope`: all queries filtered, cross-tenant access impossible
- [ ] Index: scopes, paramScopes, column filters, sort, pagination — each independently
- [ ] Index: `ids` param still respects `@scope` (security test)
- [ ] Index: unknown sort field → 400
- [ ] Index: enum label in filter → converted to integer value
- [ ] Create: `autoSet` applied, permit/restrict enforced, validation 422 shape correct
- [ ] Update: only permitted fields accepted, dirty-only write
- [ ] Destroy: within scope only
- [ ] `@mutation`: auto-loads record, passed to handler
- [ ] `@mutation bulk`: loads all within scope, passed as array
- [ ] `@before`: correct order, parent before child, `only`/`except`/`if` respected
- [ ] `@before` with `if` condition: skips when condition false
- [ ] `@singleton`: get/update work, no `:id` in route
- [ ] `@singleton findOrCreate`: race-safe (simulate concurrent requests)
- [ ] Error shapes: 400, 401, 403, 404, 422 all match spec
- [ ] `ValidationError` shape consumed correctly by TanStack Form (shape test)

---

## Phase 2: Controller Codegen

**Goal:** Extend existing Vite plugin to read `.ctrl.ts` files and generate typed Zod schemas, oRPC routers, and route tables. Replaces the runtime Zod inference with generated, fully-typed schemas.

**Package:** Extends `packages/codegen/` (currently in `packages/core/src/vite` + `src/codegen`)

### 2.1 — Controller Reader (ts-morph)

- [ ] Read `.ctrl.ts` files alongside `.model.ts` files
- [ ] Extract: class name, parent class, `@controller` path, `@crud`/`@singleton` config
- [ ] Extract: `@scope` field(s) in correct stacking order
- [ ] Extract: `@mutation` methods — name, param types, return type, `optimistic` hint if present
- [ ] Extract: `@action` methods — HTTP method, path, param types
- [ ] Extract: `@before`/`@after` — method name + config
- [ ] Add `controllers` glob to Vite plugin config + CLI

### 2.2 — Controller Validator (Build-Time)

Errors appear in the same terminal format as model errors: `[active-drizzle] ERROR file:line — message. Did you mean X?`

- [ ] `@crud` model reference exists in model registry
- [ ] `sortable` fields are actual columns on the model
- [ ] `filterable` fields are actual columns on the model
- [ ] `permit`/`restrict` fields are actual columns on the model
- [ ] Scope names in `index.scopes` are defined as `@scope` methods on the model
- [ ] `paramScopes` entries exist as `@scope` methods with arity ≥ 1
- [ ] `@scope` field exists as a column on the model
- [ ] `@singleton findBy` references valid columns
- [ ] New column added to schema but not in `permit` → **WARN** "field X is writable but not in permit"
- [ ] `@mutation` first param type matches `@crud` model

### 2.3 — Zod Schema Generation

Per controller: `{Model}.schema.gen.ts`

- [ ] Index input: scopes as enum, paramScopes typed, column filters typed from model metadata
- [ ] Enum column filters: accept label strings (from `Attr.enum`) or raw values
- [ ] Sort input: field as enum from `sortable`, dir as `'asc' | 'desc'`
- [ ] Pagination: page (int ≥ 0), perPage (int, capped at `maxPerPage`)
- [ ] Create input: from model columns + permit/restrict, types from Drizzle schema
- [ ] Update input: same as create but all optional
- [ ] Mutation inputs: from method parameter types
- [ ] All schemas exported as named exports for use in oRPC procedures

### 2.4 — oRPC Router Codegen

Per controller: `{Model}.router.gen.ts`

- [ ] Typed procedures using generated Zod schemas (replaces runtime-inferred schemas)
- [ ] REST route mapping array (method + path + procedure name)
- [ ] Full TypeScript types on procedure inputs/outputs

### 2.5 — Route Table

- [ ] `_routes.gen.ts`: combined route table from all controllers
- [ ] CLI command: `active-drizzle routes` — pretty-prints all routes (like `rails routes`)
- [ ] Output format: `GET    /teams/:teamId/campaigns          → index`

### 2.6 — Vite Plugin Extension

- [ ] Watch `.ctrl.ts` → regenerate router + Zod schemas + affected hooks
- [ ] Watch `.model.ts` → regenerate affected controller outputs if model metadata changed
- [ ] `computeControllersToRevalidate` — analogous to model dependency tracking
- [ ] Terminal output on save: `✓ CampaignController → campaign.router.gen.ts (7 procedures)`

### 2.7 — Tests

- [ ] Controller reader extracts all decorator metadata correctly for each decorator type
- [ ] Generated Zod schemas validate correctly (fuzz with invalid inputs)
- [ ] Generated Zod schemas reject unknown sort fields, unknown scope names
- [ ] Generated routes match expected REST path patterns
- [ ] Validator catches: bad model ref, bad sortable field, bad scope name
- [ ] File watcher: change `.ctrl.ts` → correct files regenerated, unrelated files untouched

---

## Phase 3: React Client Runtime

**Goal:** Base classes and generic hook factories that generated code builds on.

**Package:** `packages/react/` → `@active-drizzle/react`
**Peer deps:** `@tanstack/react-query`, `react`
**Entry:** `@active-drizzle/react`

### 3.1 — Package Scaffolding

- [ ] `packages/react/package.json` with correct peer deps
- [ ] TSX support in tsup config
- [ ] Test setup: vitest + react testing library

### 3.2 — ClientModel Base Class

The generated `Model.Client` classes extend this.

```typescript
export class ClientModel {
  protected _original: Record<string, any>
  protected _changes: Map<string, [any, any]>

  constructor(data: Record<string, any>) {
    Object.assign(this, data)
    this._original = { ...data }
    this._changes = new Map()
  }

  set(field: string, value: any): this {
    // Returns NEW instance — immutable for React re-render compatibility
    const next = new (this.constructor as new (d: any) => this)({ ...this, [field]: value })
    next._original = this._original  // preserve dirty base
    next._changes = new Map(this._changes)
    this._original[field] !== value
      ? next._changes.set(field, [this._original[field], value])
      : next._changes.delete(field)
    return next
  }

  get isDirty(): boolean               { return this._changes.size > 0 }
  get changedFields(): string[]        { return [...this._changes.keys()] }
  get dirtyAttributes(): Record<string, any> { ... }
  get changes(): Record<string, [any, any]> { return Object.fromEntries(this._changes) }
  reset(): this                        { return new (this.constructor as any)(this._original) }
  toJSON(): Record<string, any>        { ... }
}
```

React usage pattern:
```tsx
const [campaign, setCampaign] = useState<CampaignClient>(data)
setCampaign(prev => prev.set('name', 'New Name'))
// Reference changed → React re-renders
```

- [ ] `ClientModel` class with immutable `set()`, dirty tracking, `reset()`, `toJSON()`
- [ ] `set()` preserves `_original` across copies (dirty tracking base unchanged)
- [ ] `validate()` returns `{ field: string[]; ... }` — TanStack Form compatible shape
- [ ] `dirtyAttributes` typed as `Partial<TUpdateInput>` (set by generated subclass)

### 3.3 — Cache Key Factories

```typescript
const campaignKeys = createModelKeys('campaigns')
campaignKeys.all(teamId)            // ['campaigns', teamId]
campaignKeys.lists(teamId)          // ['campaigns', teamId, 'lists']
campaignKeys.list(teamId, filters)  // ['campaigns', teamId, 'lists', filters]
campaignKeys.details(teamId)        // ['campaigns', teamId, 'details']
campaignKeys.detail(teamId, id)     // ['campaigns', teamId, 'details', id]

const settingsKey = createSingletonKey('teamSettings')
settingsKey(teamId)                 // ['teamSettings', teamId]
```

- [ ] `createModelKeys(resource)` — full key factory for CRUD resources
- [ ] `createSingletonKey(resource)` — key factory for singleton resources
- [ ] Keys are stable arrays (no object references — React Query serializes cleanly)

### 3.4 — Generic useModel Hook Factory

```typescript
const useModels = createModelHook({
  keys: campaignKeys,
  api: campaignApi,   // oRPC client procedures
  ClientClass: CampaignClient,
})

// Usage in components:
const { index, get, create, update, destroy, launch, pause } = useModels(teamId)
```

- [ ] `createModelHook(config)` → returns `useModels(parentId)` hook
- [ ] `index(params)`: `useInfiniteQuery`, wraps results in `ClientClass`, pre-populates detail cache
- [ ] `get(id)`: `useQuery`, wraps in `ClientClass`, uses `placeholderData` from list cache
- [ ] `create()`: `useMutation`, optimistic insert + list invalidation
- [ ] `update()`: `useMutation`, reads `dirtyAttributes` for PATCH, optimistic + rollback
- [ ] `destroy()`: `useMutation`, optimistic remove from list + detail cache
- [ ] Custom mutations: one `useMutation` per `@mutation` method, with optimistic hints
- [ ] `combobox.search(q)`: `useQuery`, populates detail cache from results
- [ ] `combobox.hydrate(ids)`: `useQuery`, cache-first, fetches only IDs not in cache
- [ ] `prefetch(id)`: `queryClient.prefetchQuery` for hover prefetching
- [ ] `invalidateAll()`: invalidates all query keys for this resource + parent

### 3.5 — Generic useSingleton Hook Factory

- [ ] `createSingletonHook(config)` → returns `useSingleton(parentId)` hook
- [ ] `get()`: `useQuery` — no id param
- [ ] `update()`: `useMutation` with optimistic
- [ ] Custom mutations: one per `@mutation` method

### 3.6 — Search State Hook Factory

```typescript
const useCampaignSearch = createSearchHook(campaignSearchConfig)

// Component:
const search = useCampaignSearch()
search.state         // current typed state
search.setScope('active')   // exclusive within scope group
search.setSort('createdAt') // flips direction if already sorted by this field
search.setFilter('status', 'draft')
search.setSearch('text query')
search.clearFilters()
search.hasActiveFilters  // boolean
```

Two modes, same API:
- URL-synced: reads/writes TanStack Router search params
- Local state: `useState` (for modals, popovers)

- [ ] `createSearchHook(config, opts?)` with `{ mode: 'url' | 'local' }`
- [ ] Scope toggle with group exclusivity (selecting one scope in a group deselects others in same group)
- [ ] Sort toggle with direction flip (click same field → flip asc/desc)
- [ ] Debounced search text (default 300ms, configurable in `opts`)
- [ ] Filter setters per filterable column
- [ ] `clearFilters()` resets to defaults

### 3.7 — UI Components

These are thin wrappers over headless behavior. Styling via shadcn/ui (configurable).

**ModelCombobox:**
- [ ] Props: `value` (id | id[]), `onChange`, `combobox` (from hook), `isMulti`, `placeholder`
- [ ] Debounced search input triggers `combobox.search(q)`
- [ ] On mount: `combobox.hydrate(value)` fills selected items from cache
- [ ] Works with react-select, radix-select, or custom dropdown (adapter pattern)

**SearchBar:**
- [ ] Reads `searchConfig` shape — renders search input, scope tabs, sort dropdown, filter buttons, clear
- [ ] All behavior driven by `useModelSearch` hook — component is purely presentational

**IntersectionTrigger:**
- [ ] Renders a `div`, `IntersectionObserver` fires `onVisible` when scrolled into view
- [ ] For infinite scroll trigger at bottom of lists (~15 lines)

### 3.8 — Tests

- [ ] `ClientModel.set()` returns new instance, original unchanged
- [ ] `ClientModel` dirty tracking across multiple `set()` calls
- [ ] `ClientModel.reset()` returns to original values
- [ ] `ClientModel.validate()` returns TanStack Form compatible shape
- [ ] `set()` on unchanged value → field removed from `_changes`
- [ ] Cache key factories: correct hierarchical key arrays, stable across calls
- [ ] `createModelHook` factory: produced hook has correct signatures
- [ ] Combobox hydrate: cache hit → no fetch; cache miss → fetch
- [ ] Search hook URL mode: `setScope` navigates with updated params
- [ ] Search hook local mode: `setScope` updates state
- [ ] Scope group exclusivity: selecting scope A in group 1 deselects scope B in group 1

---

## Phase 4: React Codegen

**Goal:** Extend Vite plugin to generate typed React hooks, client model extensions, search configs, and form configs from controller metadata.

### 4.1 — Model.Client Extension (Codegen)

The existing `.gen.ts` `Model.Client` class gets enhanced:

- [ ] Add typed `.set<K extends keyof TModel>(field: K, value: TModel[K]): this`
- [ ] Add `.dirtyAttributes: Partial<CampaignUpdate>` typed from controller `update.permit`
- [ ] `@pure` methods from the model: body copied verbatim into `Model.Client`
- [ ] Non-`@pure` instance methods: omitted from client (server-only)
- [ ] Enum predicates (`isDraft()`, `isActive()`) already generated — verify they work on `Client`

### 4.2 — Hook Generation

Per controller: `use{Model}.gen.ts`

```typescript
// Generated output example (not written by hand):
export const useCampaigns = createModelHook({
  keys: campaignKeys,
  api: campaignProcedures,
  ClientClass: CampaignClient,
  mutations: {
    launch: { optimistic: { status: 'active', startDate: Date } },
    pause:  { optimistic: { status: 'paused' } },
  },
})
```

- [ ] Uses `createModelHook` factory from `@active-drizzle/react`
- [ ] Passes correct keys, API procedures, and `ClientClass`
- [ ] For each `@mutation`: generates mutation config with optimistic hints
  - Simple assignments in method body: extracted by codegen automatically
  - Complex logic: requires explicit `{ optimistic: {...} }` hint on decorator
  - No hint + complex logic: generates invalidation-only mutation (correct, slightly slower UX)
- [ ] All params, returns, and error shapes are fully typed from generated Zod schemas

### 4.3 — Singleton Hook Generation

Per singleton controller: `use{Model}.gen.ts`

- [ ] Uses `createSingletonHook` factory
- [ ] No index, no id params
- [ ] Each `@mutation` generates a mutation hook

### 4.4 — Search Config Generation

Per CRUD controller: `{Model}SearchConfig.gen.ts`

Generated from `@crud.index` config + model metadata:

- [ ] Scopes with display labels (scope method name → Title Case)
- [ ] Scope groups: if model has `enumGroup`, group scopes by that group's members
- [ ] Filter options: typed from model `Attr.enum` (labels array) and `belongsTo` associations
- [ ] Sort options: from `sortable` list with display labels (camelCase → Title Case)
- [ ] Default sort + pagination values from config
- [ ] Debounce default (300ms) — client-side, NOT in controller config

### 4.5 — Form Config Generation

Per CRUD controller: `{Model}FormConfig.gen.ts`

```typescript
export const campaignFormConfig = {
  defaultValues: {
    name: '',
    budget: null,
    status: 'draft',   // enum default resolved to label
    assetIds: [],
  },
  validators: {
    // client-safe validations from model (presence, length, format, numericality)
    // serverValidate methods are omitted (backend-only)
    name: [requiredValidator, lengthValidator({ min: 2, max: 255 })],
    budget: [numericalityValidator({ gte: 0 })],
  },
  enumOptions: {
    status: [
      { value: 'draft', label: 'Draft' },
      { value: 'active', label: 'Active' },
      { value: 'paused', label: 'Paused' },
      { value: 'completed', label: 'Completed' },
    ],
  },
} satisfies CampaignFormConfig
```

- [ ] `defaultValues`: from `Attr.default()` + column defaults, enum defaults resolved to label strings
- [ ] `validators`: client-safe validators from model (omit `@serverValidate`)
- [ ] `enumOptions`: from `Attr.enum` mappings, formatted for select components
- [ ] Typed for TanStack Form: `useForm({ ...campaignFormConfig, onSubmit: ... })`

### 4.6 — Combobox Config

Per model with a `name` or `title` column (or user-configured `labelField`):

- [ ] Generates combobox config: `{ searchField: 'name', labelField: 'name', valueField: 'id' }`
- [ ] Hook includes `combobox` sub-hook using this config
- [ ] User can override label field: `@model('campaigns', { comboboxLabel: 'title' })`

### 4.7 — Global Client Registry

- [ ] `_client-registry.gen.ts`: all client models + hooks from one import
  ```typescript
  export { useCampaigns, CampaignClient, campaignFormConfig, campaignSearchConfig } from './...'
  export { useAssets, AssetClient, assetFormConfig, assetSearchConfig } from './...'
  ```

### 4.8 — Extend Vite Plugin + CLI

- [ ] Watch `.ctrl.ts` → regenerate hooks, search config, form config
- [ ] Watch `.model.ts` → regenerate affected hook if model metadata changed
- [ ] `active-drizzle generate` generates client files with `--client-output ./src/client/generated`
- [ ] `--no-client` flag for backend-only projects
- [ ] Terminal summary on save:
  ```
  ✓ CampaignController → useCampaigns.gen.ts
    (5 queries, 2 mutations [launch: optimistic, pause: optimistic], combobox, search)
  ```

### 4.9 — Tests

- [ ] Generated hooks have correct TypeScript types (compile test)
- [ ] Generated search config matches `@crud.index` config for scopes, sort, filters
- [ ] Generated form config has correct default values + validator functions
- [ ] Mutation hooks include optimistic hints when simple assignments extractable
- [ ] Mutation hooks fall back to invalidation when optimistic extraction fails
- [ ] Singleton hooks have no index, no id params
- [ ] File watcher: change `.ctrl.ts` → hooks regenerated, model files untouched
- [ ] File watcher: change `.model.ts` → affected hooks regenerated

---

## Phase 5: Documentation + Polish

### 5.1 — Docs: Controller Guide

- [ ] Getting started with controllers (show the campaigns example end-to-end)
- [ ] `@crud` configuration reference
- [ ] `@singleton` reference
- [ ] Custom `@mutation` methods
- [ ] Plain controllers with `@action`
- [ ] Authentication + `@before` hooks
- [ ] Nested resources with `@scope` stacking
- [ ] Content negotiation

### 5.2 — Docs: React Guide

- [ ] Setup and configuration
- [ ] Using generated hooks (index, get, create, update, destroy)
- [ ] Custom mutation hooks + optimistic updates
- [ ] Search + filter system with `useModelSearch`
- [ ] Combobox pattern
- [ ] TanStack Form integration with `formConfig`
- [ ] Singleton resources
- [ ] Building custom UIs with `useModelSearch` + config

### 5.3 — Docs: Full-Stack Tutorial

- [ ] "15 minutes from zero to working CRUD"
- [ ] Schema → model → controller → page (the campaigns example above, fully worked)
- [ ] Side-by-side comparison: manual approach (12 files) vs. active-drizzle (3 files)

### 5.4 — schema.md Enhancement

- [ ] Include controller info in LLM docs: routes, permitted fields, available scopes per endpoint
- [ ] An LLM reading `schema.md` knows the entire API surface — no guessing required

### 5.5 — CLI Polish

- [ ] `active-drizzle routes` — pretty-print all routes
- [ ] `active-drizzle models` — print all models with scopes/enums/associations
- [ ] `active-drizzle validate` — validators only, no file generation

---

## Phase 6: Advanced Features (Post-Launch)

Build these only after Phases 1-5 are stable and AdioPilot validates the patterns.

### 6.1 — Real-Time Subscriptions

```typescript
@subscribe
async changes() { return this.relation }  // scoped to team, respects auth
// Frontend hook auto-subscribes — zero additional code
```

- [ ] `@subscribe` decorator — push changes via WebSocket/SSE when records change
- [ ] Respects `@scope` — only push changes the client is authorized to see
- [ ] Generated React hook auto-subscribes + updates React Query cache

### 6.2 — Admin Panel Generator

- [ ] `import { AdminPanel } from '@active-drizzle/admin'`
- [ ] Reads controller configs, generates full CRUD admin UI
- [ ] Uses generated hooks + shadcn components

### 6.3 — OpenAPI Spec

- [ ] Zod schemas + route table → OpenAPI 3.1 spec
- [ ] Swagger UI mountable as a route

### 6.4 — Non-React SDK Generation

- [ ] Vanilla JS client (for React Native, Vue, Svelte)
- [ ] Same oRPC contract, different framework hooks

### 6.5 — Estimated Count for Large Tables

- [ ] `{ index: { estimateCount: true } }` — uses `SELECT reltuples FROM pg_class` when unfiltered
- [ ] Exact count when WHERE clause present (filtered queries are fast)

---

## Edge Cases (Carry Into Implementation)

| # | Case | Handling |
|---|------|----------|
| 1 | New column added to schema, not in `permit` | Codegen WARNS: "field X is writable but not in permit/restrict" |
| 2 | Optimistic update inference — complex mutation body | Require explicit `{ optimistic: {...} }` hint; fall back to invalidation |
| 3 | `ClientModel.set()` + React re-renders | `set()` returns new instance (immutable) — reference change triggers re-render |
| 4 | Singleton `findOrCreate` race condition | `INSERT ON CONFLICT DO NOTHING`, retry `SELECT` on pg error 23505 |
| 5 | `ids` param + security | Always applied within `this.relation` (pre-scoped) — cross-tenant IDs silently excluded |
| 6 | Enum label in `ORDER BY` | Sort by raw integer value, not label string |
| 7 | Nested `@scope` stacking | Both scopes AND'd to all queries + autoSet on create |
| 8 | STI model + index | Child model auto-scopes to its `stiType`; parent returns all types |
| 9 | Association includes + circular refs | Max depth 3 (configurable); beyond that, return IDs only |
| 10 | Frontend concerns (debounce, labels) | Inferred by codegen from model metadata, NOT declared in controller config |
| 11 | `afterCommit` in controllers | `save()` must be in a transaction for `afterCommit` to be meaningful |
| 12 | `@pure` vs non-`@pure` methods | `@pure` body copied to `Model.Client`; others omitted (server-only) |

---

## Build Order Summary

```
Phase 0: Monorepo scaffold + publish @active-drizzle/core v0.1.0   [DO THIS FIRST]
Phase 1: Controller runtime (no codegen)                            [validate with AdioPilot]
Phase 2: Controller codegen (extend Vite plugin)
Phase 3: React client runtime (base classes + hook factories)
Phase 4: React codegen (generate typed hooks + configs)
Phase 5: Docs + polish
Phase 6: Advanced features (post-launch, AdioPilot-driven)
```

**The constraint that overrides everything:** Every feature must be validated by a real AdioPilot use case before it is generalized into the framework. Build with AdioPilot. Extract. Package. Don't invent.
