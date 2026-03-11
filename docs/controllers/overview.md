# Controllers Overview

Controllers are the HTTP layer of ActiveDrizzle. They receive requests, apply security rules, delegate to your models, and return responses — all without you writing a single route handler by hand.

A controller is a TypeScript class decorated with `@controller` and either `@crud` (for standard resources) or `@singleton` (for "one per parent" resources). The `buildRouter()` function turns the class into a fully-typed [oRPC](https://orpc.unnoq.com) procedure tree that maps 1:1 to REST routes. Add custom mutations with `@mutation` and arbitrary endpoints with `@action`. Lifecycle hooks (`@before`/`@after`) and error handlers (`@rescue`) make the edge cases clean.

After reading this guide you will understand:

- How controllers map to URL routes
- How CRUD works by default and how to override it
- How to secure actions with permit lists and `@scope`
- How to write custom mutations and actions
- How `@before`/`@after` hooks and `@rescue` handle cross-cutting concerns
- How to access the request context, params, and the loaded record
- How to build the oRPC router and mount it in your app

---

## 1. Introduction

### What a Controller Does

In Rails, a controller sits between the router and your model. ActiveDrizzle follows the same pattern:

```
HTTP Request
    ↓
URL Router (oRPC / Hono)
    ↓
Controller (scope params → relation → @before hooks → action → @after hooks)
    ↓
Model (ApplicationRecord — querying, validating, saving)
    ↓
HTTP Response
```

The key insight: **you define behavior, the framework handles plumbing**. You declare which fields are permitted for write, which scopes are available for index queries, and which context fields gate access. The router, Zod schemas, error serialisation, and oRPC procedure tree are all generated automatically.

### Creating a Controller

```ts
// src/controllers/Post.ctrl.ts
import {
  controller, crud, scope, mutation, action, before, rescue,
  ActiveController, BadRequest, NotFound, Forbidden,
} from '@active-drizzle/controller'
import { Post } from '../models/Post.model.js'

interface AppContext {
  user: { id: number; role: 'admin' | 'member' }
  teamId: number
}

@controller()                          // → /posts (inferred from class name)
@crud(Post, {
  index:  { scopes: ['published'], include: ['author'] },
  create: { permit: ['title', 'body', 'status'] },
  update: { permit: ['title', 'body', 'status'] },
  get:    { include: ['author', 'comments'] },
})
@scope('teamId')                       // → /teams/:teamId/posts
export class PostController extends ActiveController<AppContext> {

  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  @mutation()
  async publish(post: Post) {
    post.status = 'published'
    post.publishedAt = new Date()
    return post.save()
  }
}
```

Three decorators, one hook, one mutation. That generates:
- `GET    /teams/:teamId/posts`
- `GET    /teams/:teamId/posts/:id`
- `POST   /teams/:teamId/posts`
- `PATCH  /teams/:teamId/posts/:id`
- `DELETE /teams/:teamId/posts/:id`
- `POST   /teams/:teamId/posts/:id/publish`

---

## 2. Parameters

Every controller action has access to the request input via `this.params` (alias: `this.input`). For CRUD actions, this includes all input validated by the oRPC Zod schema — scope params (from the URL), filter/sort options (for index), the `id` (for get/update/destroy), and `data` (for create/update).

```ts
@before()
async logRequest() {
  const { teamId, id, data } = this.params
  console.log(`Action on team=${teamId}, id=${id}`)
}
```

Scope parameters (from `@scope`) are always present in `this.params` as numbers. For example, `@scope('teamId')` puts `this.params.teamId` in scope before any hook runs.

### The Context Object

`this.context` is the request context — whatever you inject at the middleware layer. It's generic over your `AppContext` type:

```ts
export class PostController extends ActiveController<AppContext> {
  @before()
  async requireAdmin() {
    if (this.context.user.role !== 'admin') throw new Forbidden('Admins only')
  }
}
```

Context injection happens at the `buildRouter` call site:

```ts
const { router } = buildRouter(PostController, os.context<AppContext>())
```

### `this.relation`

For CRUD controllers, `this.relation` is a pre-scoped `Relation` for the model — scoped by all `@scope` parameters before any action runs. Always use `this.relation` instead of `Model.all()` inside controller methods to guarantee scope isolation:

```ts
@action('GET')
async stats() {
  // Already filtered by teamId — safe
  const count  = await this.relation.count()
  const active = await this.relation.where({ status: 'published' }).count()
  return { count, active }
}
```

### `this.record`

For `@mutation` and `@action({ load: true })` actions, `this.record` holds the auto-loaded record — available in `@before` hooks that apply to that action:

```ts
@before({ only: ['publish', 'archive'] })
async ensureOwner() {
  if (this.record.userId !== this.context.user.id) {
    throw new Forbidden('You do not own this post')
  }
}
```

---

## 3. Strong Parameters — The `permit` List

Strong parameters protect against mass assignment. Only fields listed in `permit` can be written. Everything else is stripped silently.

```ts
@crud(Post, {
  create: {
    permit: ['title', 'body', 'status'],
    // Even if the client sends { id: 999, createdAt: '2020-01-01', title: 'X' },
    // only title is used — id and createdAt are always blocked.
  },
  update: {
    permit: ['title', 'body'],  // can write less than create
  },
})
```

**Fields that are NEVER permitted regardless of your list:**
- `id`
- `createdAt` / `created_at`
- `updatedAt` / `updated_at`
- Any field in the `@scope` list (those come from the URL, not the request body)

### `autoSet` — Context-Injected Fields

Use `autoSet` to inject fields from the request context that the client should never control:

```ts
create: {
  permit: ['title', 'body', 'status'],
  autoSet: {
    userId: (ctx) => ctx.user.id,    // always from the authenticated user
    teamId: (ctx) => ctx.teamId,     // always from the URL scope
  },
}
```

`autoSet` fields bypass the permit list and are applied after filtering — the client cannot override them.

---

## 4. Default CRUD Actions

When you use `@crud`, five default actions are wired automatically. You can override any of them by defining a method with the same name on the controller class.

### index — Collection Query

Returns a paginated list with metadata.

```ts
// Configured in @crud
index: {
  scopes:        ['published', 'draft', 'archived'],  // user-requestable named scopes
  defaultScopes: ['published'],                        // applied unless user requests others
  paramScopes:   ['byTitle'],                          // ?byTitle=foo → Post.byTitle('foo')
  sortable:      ['createdAt', 'title', 'publishedAt'],
  defaultSort:   { field: 'createdAt', dir: 'desc' },
  filterable:    ['status', 'userId'],
  include:       ['author'],                           // always eager-loaded
  perPage:       25,
  maxPerPage:    100,
}
```

Response shape:
```json
{
  "data": [...],
  "pagination": {
    "page": 0,
    "perPage": 25,
    "totalCount": 142,
    "hasMore": true
  }
}
```

### get — Single Record

```ts
get: {
  include: ['author', 'comments', 'tags'],  // eager-load for the detail view
}
```

Returns the record as a plain object. Throws `NOT_FOUND` if the `:id` doesn't exist within the current scope.

### create

```ts
create: {
  permit: ['title', 'body', 'status'],
  autoSet: { userId: (ctx) => ctx.user.id },
}
```

Validates and saves the record. On success, returns the created record. On validation failure, throws `UNPROCESSABLE_ENTITY` with the field errors.

### update

```ts
update: {
  permit: ['title', 'body'],  // update can permit less than create
}
```

Partial update — only columns in `data` are touched. Runs validations. Returns the updated record or throws `UNPROCESSABLE_ENTITY`.

### destroy

Loads the record by `:id`, runs `@beforeDestroy` hooks, deletes it, returns `{ success: true }`.

### Overriding a Default Action

Define a method with the name `index`, `get`, `create`, `update`, or `destroy` on the controller class to replace the default:

```ts
@controller()
@crud(Post, { /* ... */ })
export class PostController extends ActiveController<AppContext> {
  async index() {
    // Full control — this.relation is already scoped by @scope params
    const results = await this.relation
      .includes('author')
      .order('publishedAt', 'desc')
      .limit(10)
      .load()
    return { data: results, pagination: { totalCount: results.length } }
  }
}
```

---

## 5. Singleton Controllers

For "one per parent" resources — team settings, user profile, notification preferences — use `@singleton` instead of `@crud`:

```ts
@controller()
@singleton(TeamSettings, {
  findBy:       (ctx) => ({ teamId: ctx.teamId }),
  findOrCreate: true,                          // creates with defaults if missing
  defaultValues: { timezone: 'UTC', locale: 'en' },
  update: { permit: ['timezone', 'locale', 'notifications'] },
  get:    { include: ['plan'] },
})
@scope('teamId')
export class TeamSettingsController extends ActiveController<AppContext> {}
```

Routes generated:
- `GET   /teams/:teamId/team-settings` — find or null
- `POST  /teams/:teamId/team-settings` — findOrCreate (if `findOrCreate: true`)
- `PATCH /teams/:teamId/team-settings` — update

No `:id` parameter — the record is identified by the context, not a URL segment.

---

## 6. Scopes — URL Nesting and Multi-tenancy

`@scope` nests the controller under a parent resource and automatically filters all queries by the scope parameter. This is the primary mechanism for multi-tenancy:

```ts
@scope('teamId')
// → /teams/:teamId/posts
// All queries: WHERE team_id = :teamId (applied automatically)
```

Multiple scopes stack, outermost first:

```ts
@scope('teamId')
@scope('campaignId')
// → /teams/:teamId/campaigns/:campaignId/assets
// All queries: WHERE team_id = :teamId AND campaign_id = :campaignId
```

The scope field values are available in `this.params.teamId`, `this.params.campaignId`, etc., and in `this.context` (if your context object includes them).

**Security guarantee**: every query on `this.relation` already has the scope WHERE clauses applied. A client can never access records outside their scope, even if they manipulate the request.

---

## 7. Custom Mutations — `@mutation`

`@mutation` marks a method as a custom record-level state change. The record is **auto-loaded by `:id`** from the scoped relation and passed as the first argument. If the record doesn't exist, `NOT_FOUND` is thrown before the method runs.

```ts
@mutation()
async publish(post: Post) {
  if (post.isPublished()) throw new BadRequest('Already published')
  post.status = 'published'
  post.publishedAt = new Date()
  return post.save()
}
// Route: POST /posts/:id/publish
// Frontend: ctrl.mutatePublish()

@mutation({ bulk: true })
async archive(posts: Post[]) {
  for (const post of posts) {
    post.status = 'archived'
    await post.save()
  }
  return posts
}
// Route: POST /posts/archive  (accepts { ids: number[] })
// Frontend: ctrl.mutateBulkArchive()
```

The loaded record is also available as `this.record` in any `@before` hooks that apply to the action — useful for ownership checks that happen before the method body runs.

```ts
@before({ only: ['publish', 'archive'] })
async checkOwnership() {
  if (this.record.userId !== this.context.user.id) throw new Forbidden('Not your post')
}
```

---

## 8. Custom Actions — `@action`

`@action` gives you a fully customizable endpoint. Unlike `@mutation`, it doesn't auto-load a record by default — it's for collection-level operations, analytics, background jobs, integrations, and any endpoint that doesn't fit the CRUD pattern.

```ts
// Collection-level GET — analytics
@action('GET')
async stats(): Promise<{ totalPosts: number; publishedCount: number }> {
  const [total, published] = await Promise.all([
    this.relation.count(),
    this.relation.where({ status: 'published' }).count(),
  ])
  return { totalPosts: total, publishedCount: published }
}
// Route: GET /posts/stats
// Frontend: ctrl.indexStats()   (GET → 'index' prefix)

// Collection-level POST — background job trigger
@action('POST')
async reindex(input: { force?: boolean }) {
  await SearchIndex.scheduleReindex({ teamId: this.params.teamId, force: input.force ?? false })
  return { scheduled: true }
}
// Route: POST /posts/reindex
// Frontend: ctrl.mutateReindex()  (POST → 'mutate' prefix)
```

### Record-Loading Actions

Pass `{ load: true }` to auto-load the record by `:id`, just like `@mutation`:

```ts
@action('GET', undefined, { load: true })
async score(post: Post): Promise<{ score: number; factors: string[] }> {
  return computeRelevanceScore(post)
}
// Route: GET /posts/:id/score
// Frontend: ctrl.indexScore(id)
```

See [Actions & Custom Endpoints](/controllers/actions) for the complete reference including plain controllers and naming conventions.

---

## 9. Controller Lifecycle Hooks — `@before` / `@after`

Hooks run before and after actions. They're defined as instance methods and inherited from parent classes — parent hooks always fire before child hooks (just like Rails `before_action` inheritance).

```ts
export class BaseController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }
}

@controller()
@crud(Post, { /* ... */ })
@scope('teamId')
export class PostController extends BaseController {
  // requireAuth() fires automatically — inherited from BaseController

  @before({ only: ['create', 'update'] })
  async checkWritePermissions() {
    const team = await Team.find(this.params.teamId)
    if (!team.canWrite(this.context.user.id)) throw new Forbidden('Read only')
  }
}
```

### Hook Options

```ts
@before({ only: ['create', 'update'] })   // runs only for these actions
@before({ except: ['index', 'get'] })     // runs for all EXCEPT these
@before({ if: 'isAdmin' })                // calls this.isAdmin(), skips if false
@before({ if: () => process.env.NODE_ENV !== 'test' })
```

### `@after`

```ts
@after({ only: ['create', 'update'] })
async logAudit() {
  await AuditLog.create({
    action: 'post_changed',
    userId: this.context.user.id,
    resourceId: this.params.id,
  })
}
```

---

## 10. Error Handling

### Built-in HTTP Errors

Throw these from anywhere in the dispatch cycle — action bodies, hooks, rescue handlers — and they're automatically serialized to the correct oRPC error code:

```ts
throw new BadRequest('Budget must be positive')     // 400 BAD_REQUEST
throw new Unauthorized()                            // 401 UNAUTHORIZED
throw new Forbidden('Not your resource')            // 403 FORBIDDEN
throw new NotFound('Post')                          // 404 NOT_FOUND
throw toValidationError(record.errors)              // 422 UNPROCESSABLE_ENTITY
```

### Auto-Rescue: RecordNotFound → 404

If any code inside a controller action calls `Model.find(id)` and the record doesn't exist, the resulting `RecordNotFound` error is automatically converted to a `NOT_FOUND` response. You never need to catch it manually:

```ts
@action('POST', undefined, { load: true })
async duplicate(post: Post) {
  const team = await Team.find(this.params.teamId)  // throws RecordNotFound if missing
  // ↑ automatically becomes: throw new ORPCError('NOT_FOUND', ...)
  return Post.create({ ...post.attributes, teamId: team.id, title: `${post.title} (copy)` })
}
```

### `@rescue` — Rails `rescue_from`

Define error handler methods to convert or swallow specific error types:

```ts
import { rescue } from '@active-drizzle/controller'

class ExternalAPIError extends Error {}

@controller()
@crud(Post, { /* ... */ })
export class PostController extends ActiveController<AppContext> {

  // Convert third-party errors → user-friendly 400
  @rescue(ExternalAPIError)
  async handleExternalError(e: ExternalAPIError) {
    throw new BadRequest(`External service unavailable: ${e.message}`)
  }

  // Swallow a non-critical error and return a fallback
  @rescue(SearchIndexError, { only: ['index'] })
  async handleSearchError(_e: SearchIndexError) {
    // Return unfiltered results instead of failing
    return this.relation.order('createdAt', 'desc').limit(25).load()
  }
}
```

Handlers are **inherited** — define common rescues on a base controller and all subclasses get them.

See [Error Handling](/controllers/error-handling) for `parseControllerError` (the frontend utility), the full `@rescue` API, and validation error binding to TanStack Form.

---

## 11. Building the Router

### Single Controller

```ts
// src/server/router.ts
import { buildRouter } from '@active-drizzle/controller'
import { os } from '@orpc/server'
import { PostController } from '../controllers/Post.ctrl.js'

const { router, routes, basePath } = buildRouter(PostController, os.context<AppContext>())
// router  = oRPC procedure tree { index, get, create, update, destroy, publish, ... }
// routes  = RouteRecord[] for REST adapter registration
// basePath = '/teams/:teamId/posts'
```

### Multiple Controllers

```ts
import { buildRouter, mergeRouters } from '@active-drizzle/controller'
import { PostController }        from './Post.ctrl.js'
import { TeamSettingsController } from './TeamSettings.ctrl.js'
import { UploadController }      from './Upload.ctrl.js'

export const { router, routes } = mergeRouters(
  buildRouter(PostController),
  buildRouter(TeamSettingsController),
  buildRouter(UploadController),
)

export type AppRouter = typeof router
```

### Mounting with Hono

```ts
import { Hono } from 'hono'
import { createServer } from '@orpc/server/fetch'
import { router } from './router.js'

const app = new Hono()

// Mount the oRPC handler under /api
app.all('/api/*', (c) => {
  return createServer({ router, context: () => buildContext(c) }).fetch(c.req.raw)
})
```

### With the Vite Plugin

If you use the Vite plugin, `_routes.gen.ts` is generated automatically from all your `.ctrl.ts` files. You never need to write `buildRouter` or `mergeRouters` yourself:

```ts
// src/server/router.ts — fully generated
export { router, routes, AppRouter } from './_generated/_routes.gen.js'
```

See [Vite Plugin & CLI](/codegen/vite-plugin) for the complete codegen setup.

---

## 12. Controller Naming Convention

Following the naming convention lets ActiveDrizzle infer the URL path automatically:

| Class name | Inferred path |
|------------|---------------|
| `PostController` | `/posts` |
| `TeamSettingsController` | `/team-settings` |
| `CampaignController` | `/campaigns` |
| `APIKeyController` | `/api-keys` |

The path is pluralized and kebab-cased. Override with an explicit path at any time:

```ts
@controller('/v2/blog-posts')
export class PostController extends ActiveController<AppContext> {}
```

---

## 13. Complete Example

A production-ready controller with auth, multi-tenancy, custom mutations, a collection action, and error handling:

```ts
// src/controllers/Campaign.ctrl.ts
import {
  controller, crud, scope, mutation, action, before, rescue,
  ActiveController, BadRequest, Forbidden, NotFound,
  toValidationError,
} from '@active-drizzle/controller'
import { Campaign } from '../models/Campaign.model.js'
import { Team }     from '../models/Team.model.js'

interface AppContext {
  user: { id: number; role: string }
  teamId: number
}

@controller()
@crud(Campaign, {
  index: {
    scopes:        ['active', 'draft', 'paused', 'completed'],
    defaultScopes: ['active'],
    paramScopes:   ['byName'],
    sortable:      ['createdAt', 'name', 'budget'],
    defaultSort:   { field: 'createdAt', dir: 'desc' },
    filterable:    ['status'],
    include:       ['creator'],
    perPage:       25,
    maxPerPage:    100,
  },
  create: {
    permit:  ['name', 'budget', 'status', 'startDate'],
    autoSet: { creatorId: (ctx) => ctx.user.id },
  },
  update: { permit: ['name', 'budget', 'status', 'startDate'] },
  get:    { include: ['creator', 'team'] },
})
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {

  // Auth + team ownership — runs before every action
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  // Ownership check for mutations — record is already in this.record
  @before({ only: ['launch', 'pause', 'update', 'destroy'] })
  async ensureOwner() {
    if (this.record.creatorId !== this.context.user.id) {
      throw new Forbidden('Only the creator can modify this campaign')
    }
  }

  // Convert any external service errors into friendly messages
  @rescue(AnalyticsServiceError)
  async handleAnalyticsError(e: AnalyticsServiceError) {
    throw new BadRequest(`Analytics unavailable: ${e.message}`)
  }

  // POST /campaigns/:id/launch
  @mutation()
  async launch(campaign: Campaign) {
    if (!campaign.isDraft()) throw new BadRequest('Only draft campaigns can be launched')
    campaign.status    = 'active'
    campaign.startDate = new Date()
    if (!await campaign.save()) throw toValidationError(campaign.errors)
    return campaign
  }

  // POST /campaigns/:id/pause
  @mutation()
  async pause(campaign: Campaign) {
    campaign.status = 'paused'
    if (!await campaign.save()) throw toValidationError(campaign.errors)
    return campaign
  }

  // POST /campaigns/bulk-archive  (accepts { ids: number[] })
  @mutation({ bulk: true })
  async bulkArchive(campaigns: Campaign[]) {
    await Promise.all(campaigns.map(c => c.update({ status: 'archived' })))
    return campaigns
  }

  // GET /campaigns/stats
  @action('GET')
  async stats() {
    const rel = this.relation
    const [total, active, draft] = await Promise.all([
      rel.count(),
      rel.where({ status: 'active' }).count(),
      rel.where({ status: 'draft' }).count(),
    ])
    return { total, active, draft }
  }
}
```

Frontend usage (generated):
```typescript
const ctrl = CampaignController.use({ teamId })

const { data }    = ctrl.index({ scopes: ['active'] })
const { data: st} = ctrl.indexStats()
const launch      = ctrl.mutateLaunch()
const pause       = ctrl.mutatePause()
const archive     = ctrl.mutateBulkArchive()

launch.mutate(campaignId)
archive.mutate([id1, id2, id3])
```

---

## What's Next

| Topic | Where to go |
|-------|-------------|
| URL structure and scope nesting | [Routing & URL Structure](/controllers/routing) |
| Detailed CRUD action configuration | [CRUD Actions](/controllers/crud-actions) |
| All decorators reference | [Decorators](/controllers/decorators) |
| `@action` deep dive | [Actions & Custom Endpoints](/controllers/actions) |
| Error handling, `@rescue`, `parseControllerError` | [Error Handling](/controllers/error-handling) |
| React Query hooks (generated) | [React Query Overview](/react/overview) |
