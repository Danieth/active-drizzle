# Controller Reference

The terse signature-and-example companion to the prose controller guides. Every entry is grounded in `@active-drizzle/controller` source and its tests. Import everything from `@active-drizzle/controller` (the Hono adapter is at `@active-drizzle/controller/hono`).

```ts
import {
  ActiveController,
  controller, crud, singleton, scope, attachable,
  mutation, action, before, after, rescue,
  buildRouter, mergeRouters,
  BadRequest, Unauthorized, Forbidden, NotFound, ValidationError, Conflict,
} from '@active-drizzle/controller'
```

## Decorators — class

### `@controller(path?)`
Marks a class as a controller and (optionally) sets its base route path. Omitted → inferred from the class name (`CampaignController → /campaigns`, `TeamSettingsController → /team-settings`). Rails `resources :campaigns`.
```ts
@controller()             // → /campaigns  (inferred)
class CampaignController extends BaseController {}

@controller('/campaigns') // explicit path — used verbatim, not pluralized
class CampaignController extends BaseController {}
```

### `@scope(field)`
Nests the controller under a parent resource and door-scopes every query to `where({ field: :param })`. Stacks bottom-to-top in source order. Rails nested `resources` + a scoping `before_action`.
```ts
@controller()
@crud(Campaign, { /* … */ })
@scope('teamId')   // → /teams/:teamId/campaigns, all queries scoped to teamId
class CampaignController extends BaseController {}
// @scope('orgId') @scope('teamId') → /orgs/:orgId/teams/:teamId/campaigns
```

### `@crud(model, config?)`
Attaches a model + `CrudConfig`, generating the default `index / get / create / update / destroy` actions. Rails a resourceful controller with `before_action :set_record` + strong params. See [CRUD Actions](#crud-actions).
```ts
@controller()
@crud(Campaign, {
  index:  { filterable: ['status', 'teamId'], searchable: ['name'], sortable: ['id', 'name'], perPage: 10 },
  create: { permit: ['name', 'status', 'budget'], autoSet: { teamId: (ctx) => ctx.teamId } },
  update: { permit: ['name', 'status', 'budget'] },
  get:    { include: [] },
})
@scope('teamId')
class CampaignController extends BaseController {}
```

### `@singleton(model, config)`
Marks the controller as a singleton resource — `get / update` (and optional `findOrCreate`), no `:id`, no `index`. Rails `resource :team_settings` (singular).
```ts
@controller()
@singleton(TeamSettings, {
  findBy:        (ctx) => ({ teamId: ctx.teamId }),
  findOrCreate:  true,
  defaultValues: { timezone: 'UTC' },
  update:        { permit: ['timezone'] },
})
@scope('teamId')
class TeamSettingsController extends BaseController {}
// → GET /teams/:teamId/team-settings, PATCH …  (no :id)
```

### `@attachable(config?)`
Adds `presign / confirm / attach` file-upload endpoints that inherit the controller's auth context and scope params. `autoSet` injects server-owned values onto the `Asset` at presign time.
```ts
@attachable({ autoSet: { uploadedById: (ctx) => ctx.user.id } })
@crud(Document)
class DocumentController extends BaseController {}   // → POST …/presign, …/confirm, …/attach
```

### `@includeInController(concern, config?)`
Mixes a controller concern's before/after hooks and actions into the class. Decorators evaluate bottom-up, so a concern's dependency must be listed *below* it. See [Concerns](#concerns).
```ts
@controller()
@crud(Product)
@includeInController(Searchable, { fields: ['title', 'sku'] })
class ProductController extends BaseController {}
```

## Decorators — method

### `@mutation(config?)`
Marks an instance method as a custom write action. Non-bulk auto-loads the record by `:id` and passes it first (`POST /<resource>/:id/<name>`); bulk takes `ids[]` and passes the loaded array — or the raw ids with `records: false` (`POST /<resource>/<name>`). Rails a custom `member`/`collection` POST route. Config: `{ bulk, records, params, required, if, label, returns, optimistic }`.
```ts
@mutation()                                  // POST …/:id/activate
async activate(campaign: any) {
  campaign.status = 'active'
  await campaign.save()
  return campaign
}

@mutation({ bulk: true, records: false })    // POST …/bulk-pause — no record loading
async bulkPause(ids: number[]) {
  await this.relation.where({ id: ids }).updateAll({ status: 'paused' })
}

// Guarded button + declared payload — greyed client-side, ENFORCED server-side
@mutation({ params: ['reason'], required: ['reason'],
           if: (deal) => deal.stage === 'submitted', label: 'Send back' })
async sendBack(deal: Deal, data: { reason: string }) { /* … */ }
```

### `@action(httpMethod, path?, config?)`
Marks a method as an explicit REST action. `httpMethod` is `GET|POST|PUT|PATCH|DELETE`. `{ load: true }` auto-loads the record by `:id` (path defaults to `/<resource>/:id/<name>`) and passes it first; otherwise a collection route `/<resource>/<name>`. Rails `get :export, on: :member`.
```ts
@action('POST', undefined, { load: true })   // POST …/:id/inspect-record
async inspectRecord(record: any) { return { id: record.id, name: record.name } }

@action('POST')                              // POST …/trigger-swallow  (collection)
async triggerSwallow() { /* … */ }
```

### `@before(config?)` · `@after(config?)`
Lifecycle hooks. `config`: `{ only?: string[], except?: string[], if?: string | (() => boolean) }`. Inherited from parent classes (parent hooks fire first). A `@before` returning `false` aborts with a 400. Rails `before_action` / `after_action`.
```ts
@before()
async validateTeamExists() {
  if (!(await Team.findBy({ id: this.params.teamId }))) throw new NotFound('Team')
}

@before({ only: ['create'] })   checkQuota()  { /* … */ }
@before({ except: ['index'] })  requireAuth() { /* … */ }
@before({ if: 'shouldBlock' })  requireAdmin() { throw new Unauthorized() }
```

### `@rescue(errorClass, config?)`
Rails-style `rescue_from`: when an action throws `instanceof errorClass`, the decorated method runs with the error. Throw an `HttpError` to convert it, or return a value to swallow it. Inherited (parent handlers fire first). `config`: `{ only?, except? }`.
```ts
@rescue(RecordNotFound)                      // convert ORM miss → 404
async handleNotFound(e: RecordNotFound) { throw new NotFound(e.modelName) }

@rescue(TransientError, { only: ['get'] })   // swallow → return a fallback value
async handleTransient(_e: TransientError) { return { fallback: true } }
```

## CRUD Actions

`@crud` generates five actions. The **procedure names** are `index / get / create / update / destroy`; `get` is the Rails `show`. Any same-named instance method overrides the default handler. Route table for `@scope('teamId') @crud(Campaign)`:

| Procedure | Method | Path | Rails |
|---|---|---|---|
| `index`   | GET    | `/teams/:teamId/campaigns`     | `index`   |
| `get`     | GET    | `/teams/:teamId/campaigns/:id` | `show`    |
| `create`  | POST   | `/teams/:teamId/campaigns`     | `create`  |
| `update`  | PATCH  | `/teams/:teamId/campaigns/:id` | `update`  |
| `destroy` | DELETE | `/teams/:teamId/campaigns/:id` | `destroy` |

### `index` config (`IndexConfig`)

- **`scopes: string[]` / `defaultScopes: string[]`** — allowlist of model scopes the client may request via `?scopes[]=active` / scopes always applied. An unlisted requested scope is a 400.
- **`paramScopes: string[]`** — scope methods taking a single string arg, passed as a top-level query param.
- **`filterable: string[]`** — column allowlist for `filters` (values codec-converted, enum label → int). Supports a depth-1 `$or` combinator (≤10 flat, allowlisted branches). Undeclared key → 400.
- **`filters: Record<string, { label?, kind?, apply }>`** — named (tier-2) filters; product semantics stay server-side, the client sees only `{ name, label, kind }`. `apply(rel, value, ctx?, ctrl?)` narrows the already-scoped relation.
- **`searchable: string[]` / `search: { fields }`** — `searchable` → case-insensitive ILIKE OR across columns for `?q=`; `search` → weighted Postgres full-text (`ts_rank`) with `sort: { field: 'relevance' }`. LIKE wildcards in `q` are escaped.
- **`sortable: string[]` / `defaultSort: { field, dir }`** — sort-field allowlist (unlisted → 400) + default ordering.
- **`include: IncludeSpec[]`** — eager-load associations, e.g. `['notes', { activities: ['reactions'] }]`.
- **`perPage` (25) / `maxPerPage` (100)** — default page size and hard ceiling (clamped, never rejected).
```ts
index: {
  scopes: ['active'], defaultScopes: ['notArchived'],
  filterable: ['status', 'teamId'],
  searchable: ['name', 'email'],
  sortable: ['id', 'name', 'budget'], defaultSort: { field: 'id', dir: 'asc' },
  perPage: 10, maxPerPage: 50,
}
```

### `create` / `update` config (`WriteConfig`)

- **`permit: string[] | ((ctx, ctrl, record?) => string[])`** — mass-assignment allowlist (Rails strong params). The function form is role- and record-state-aware (`record` = loaded record on update, defaults-draft on create). Non-permitted keys are stripped.
- **`restrict: string[]`** — denylist used only when `permit` is absent (`id`, `createdAt`, `updatedAt` always excluded).
- **`autoSet: Record<string, (ctx, ctrl?) => any>`** *(create only)* — fields forced from context/state after permit; cannot be overridden by client input.
- **`nestedAutoSet: Record<string, Record<string, (ctx, ctrl?) => any>>`** — `autoSet` for nested rows, keyed by dot-separated association path. Forced on nested create, stripped (immutable) on nested update.
- **`optimisticLock: boolean | string`** *(update only)* — optimistic concurrency. `true` → version from `updatedAt`; `'<field>'` → that field (auto-incremented if numeric). Client echoes the `version` token as `_version`; mismatch → **409 Conflict** carrying the current envelope.
```ts
create: { permit: ['name'], autoSet: { teamId: (ctx) => ctx.teamId, createdById: (ctx) => ctx.userId } }
update: { permit: (_ctx, ctrl, loan) => loan.isDraft() ? ['amount', 'termMonths'] : [], optimisticLock: true }
```

### `get` config (`GetConfig`)

- **`include: IncludeSpec[]`** — associations eager-loaded on read (and re-loaded into the PATCH/create response).
- **`expose: string[]`** — serialization ceiling: **only** these fields leave the server (the primary key always rides along). Omitting it returns the full record and disables the abilities envelope.
- **`abilities: boolean`** — when true (requires `expose`), `get / create / update` respond with the **Forms envelope** `{ record, abilities, can, issues?, version? }`. See [Abilities](#abilities-authorization).
```ts
get: { expose: ['id', 'amount', 'status'], include: ['labels'], abilities: true }
```

### `@crud` config: `scopeBy`
`scopeBy: (ctrl) => Record<string, any>` — dynamically scopes every CRUD query using resolved controller state, applied to `this.relation` *after* `@before` hooks. Use when the scope value comes from loaded state rather than a URL param.
```ts
@crud(Asset, { scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }) })
```

### Exported default handlers
For custom overrides — call the stock behavior then tweak. `defaultIndex`, `defaultGet`, `defaultCreate`, `defaultUpdate`, `defaultDestroy`, `singletonFindOrCreate`, `convertFilterValue`.
```ts
async index() {
  const res = await defaultIndex(this.relation, Campaign, this.config, this.params, this.context, this)
  return { ...res, meta: { generatedAt: Date.now() } }
}
```

## Abilities & Authorization

**Security principle:** the model *allows* (capability); the controller *gates* (authorization). Every ability projected into the envelope is re-enforced server-side on dispatch — the verdict is a projection of the rule, never the rule itself.

- **The `abilities` map** — built from `expose` × `permit(ctx, ctrl, record)`: `'edit'` iff a field is in both the resolved permit and `expose`; `'view'` iff only in `expose`; absent otherwise. Narrows by record state; `acceptsNested` associations get an `<assoc>Attributes` verdict.
- **The `can` map** — server-computed booleans, one per `Attr.state` event (via `record.can(event)`) and one per non-bulk `@mutation` (its `if` guard projected per record).
- **`enforceMutationRules(mut, record, data, ctx, ctrl)`** — the server-side gate for a `@mutation`: (1) `if` guard false → 422; (2) `params` allowlist-strips `data`; (3) missing `required` → 422 with per-field issues. Returns the sanitized payload.
- **`sanitizeNestedWrites` / `applyNestedAutoSet`** — controller-level lock on `<assoc>Attributes` writes: the protocol triple (`id`, `_destroy`, `_key`) passes typed; server-owned fields, the parent FK, and undeclared grandchild `<x>Attributes` are stripped; shape mismatches fail closed.
- **`buildRecordEnvelope(record, model, config, ctx, ctrl, issues?)`** — assembles the Forms envelope. `usesEnvelope(config)` is true iff `get.abilities && get.expose.length`.

Cross-tenant isolation comes from `@scope` + `scopeBy` (every default query flows through `this.relation`); a record from another scope simply isn't found → 404.

## The Request / Forms Envelope

### `RecordEnvelope`
Returned by `get / create / update` when `get.abilities` is on.
```ts
interface RecordEnvelope {
  record:    Record<string, any>                   // serialized through `expose` (+ get.include)
  abilities: Record<string, 'edit' | 'view'>       // field → verdict (edit⊂view⊂expose)
  can:       Record<string, boolean>               // state-event / mutation verdicts
  issues?:   Array<{ field: string; code: string }>// e.g. stripped non-permitted field
  version?:  string                                 // optimistic-lock token (echo as _version)
}
```

### Protocol fields on PATCH `data`
Ride the update payload but are protocol, not columns:
- **`_event`** — fires a declared `Attr.state` transition in the *same* save as the field diff. Strict allowlist (only declared transitions). A blocked transition → 422 `transition_blocked`, nothing saved.
- **`_version`** — optimistic-lock echo; stale → 409 Conflict.
```ts
// PATCH { amount: 250, _event: 'submit', _version: '1721383200000' }
// → applies amount, fires submit(), one save; response re-masked (SUBMITTED ⇒ everything 'view')
```

### `IndexResult` / `PaginationResult`
```ts
interface IndexResult { data: any[]; pagination: PaginationResult }
interface PaginationResult { page: number; perPage: number; totalCount: number; totalPages: number; hasMore: boolean }
```

### `IndexParams`
The validated `index` input (also the oRPC input schema).
```ts
interface IndexParams {
  scopes?: string[]; filters?: Record<string, any>; q?: string; ids?: number[]
  sort?: { field: string; dir?: 'asc' | 'desc' }; page?: number; perPage?: number
  [paramScope: string]: any   // paramScopes + scope params (e.g. teamId)
}
// create input: { …scopeParams, data }   update/get/destroy input: { …scopeParams, id, data? }
```

## Error Classes

All extend `HttpError` and are throwable from any action, `@before` hook, or `@rescue` handler. The router maps them to oRPC error codes; the Hono adapter serializes them to these wire shapes.

### `HttpError` — base
`new HttpError(status: number, message: string)`; carries `.status` and `.name`.

### `BadRequest` → **400** `{ error }`
Framework-thrown for unknown scope/filter/sort keys, malformed `$or`, unsupported `q`, bad scope params.
```ts
throw new BadRequest(`Unknown scope: 'archived'`)
```

### `Unauthorized` → **401** `{ error }`
`new Unauthorized(message = 'Not authenticated')`.

### `Forbidden` → **403** `{ error }`
```ts
@before({ only: ['destroy'] })
ensureOwner() { if (this.record.creatorId !== this.context.userId) throw new Forbidden('Not yours') }
```

### `NotFound` → **404** `{ error: "<Model> not found" }`
`new NotFound(modelName)`. Auto-thrown by default `get/update/destroy/@mutation` when the scoped record is absent (how cross-tenant access surfaces).
```ts
throw new NotFound('Campaign')   // → "Campaign not found"
```

### `ValidationError` → **422** `{ errors: Record<string, string[]> }`
TanStack-Form-compatible field-error map. Thrown on model validation failure, blocked `_event`, and `enforceMutationRules` violations.
```ts
throw new ValidationError({ name: ['is required'], email: ['is invalid'] })
```

### `Conflict` → **409** `{ error, envelope? }`
Optimistic-concurrency violation; carries the current server envelope so the client can reload or overwrite without a round-trip.

### `toValidationError(modelErrors)` · `serializeError(err)`
`toValidationError` converts a model's `.errors` map into a `ValidationError`. `serializeError` maps any `HttpError` to `{ status, body }` (used by the Hono adapter).

> **Client side:** `@active-drizzle/react`'s `parseControllerError(err)` → `{ isValidation, isNotFound, isUnauthorized, isForbidden, isBadRequest, code, message, fields? }`; `applyFormErrors(form, parsed)` pushes field errors into a TanStack form.

## Lifecycle Hooks

### `ActiveController<TContext, TState>`
Base class for all controllers, generic over the auth/request context and mutable per-request state. A fresh instance is created per request by `buildRouter`. Protected members set before each action:
- **`context: TContext`** — auth/request context (user, team, org…).
- **`params` / `input`** — the validated request input (aliases).
- **`relation: Relation`** — the pre-scoped relation for the CRUD model (`@scope` + `scopeBy` applied). Query through this, never `Model.all()`.
- **`record: any`** — the auto-loaded record for `@mutation` / `@action({ load: true })`.
- **`state: TState`** — mutable per-request state populated by `@before` hooks.
```ts
interface AppContext { userId?: number; teamId?: number }
interface AppState  { org: Organization }
class BaseController extends ActiveController<AppContext, AppState> {}

class AssetController extends BaseController {
  @before()
  async resolveOrg() { this.state.org = await Organization.findOrCreateBy({ clerkOrgId: this.context.orgId }) }
}
```

**Execution order** — per action: all matching `@before` hooks (parent-class first, in declaration order; `if` gates each) → `scopeBy` applied → the action → `@after` hooks. On throw: `@rescue` handlers (parent first) → auto-rescue of ORM `RecordNotFound` → 404 → `HttpError` → oRPC error → re-throw unknown.

## Router

### `buildRouter(ControllerClass, builder?)`
Reads a controller's metadata → an oRPC router plus a REST route table. `builder` is an optional oRPC `os` pre-typed with the context.
```ts
interface BuildResult { router: Record<string, any>; routes: RouteRecord[]; basePath: string }
interface RouteRecord { method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'; path: string; procedure: string; action: string }

const { router, routes, basePath } = buildRouter(CampaignController)
```

### `mergeRouters(...results)`
Combines multiple `BuildResult`s, namespacing each by its `basePath`.
```ts
const merged = mergeRouters(buildRouter(CampaignController), buildRouter(TeamSettingsController))
```

### `honoAdapter(router, routes, getContext)`  *(`@active-drizzle/controller/hono`)*
Maps the oRPC router to Hono route descriptors, coercing numeric params, serializing `HttpError`s, and translating DB errors (unavailable → 503, retryable → 409, else 422). Uncaught errors → 500 with a safe message (raw error reported to `reportError`).
```ts
import { Hono } from 'hono'
import { honoAdapter } from '@active-drizzle/controller/hono'

const app = new Hono()
for (const h of honoAdapter(merged.router, merged.routes, (c) => c.var.auth)) {
  app[h.method](h.path, h.handler)
}
```

## Concerns

### `defineControllerConcern(def)`
Defines a reusable bundle of before/after hooks and actions, optionally configurable and with `requires` dependencies. Rails an `ActiveSupport::Concern`.
```ts
const Timestamped = defineControllerConcern({
  name: 'Timestamped',
  before: [{ method: 'stamp', fn: function () { this.state.startedAt = Date.now() }, only: ['create'] }],
})
```

### `Searchable`  *(built-in)*
Injects an `index`-only `@before` that applies `.search(q, fields)` to `this.relation`. Config `{ fields?, paramName?, minLength? }` (defaults `['title','name']`, `'q'`, `1`).
```ts
@includeInController(Searchable, { fields: ['title', 'sku'], paramName: 'query', minLength: 2 })
class ProductController extends BaseController {}
```
