# Controller Decorators

## @controller

Marks a class as a controller and optionally sets the URL path prefix.

```typescript
@controller()                    // infers: CampaignController → /campaigns
@controller('/v2/campaigns')     // explicit path
export class CampaignController extends ActiveController<AppContext> {}
```

If no path is given, the class name is transformed: `CampaignController` → `/campaigns`, `TeamSettingsController` → `/team-settings`.

## @scope

Nests the controller under a parent resource URL. Multiple scopes stack.

```typescript
@scope('teamId')
// → /teams/:teamId/campaigns

@scope('teamId')
@scope('campaignId')
// → /teams/:teamId/campaigns/:campaignId/assets
```

The scope field name is also used as a WHERE clause: every query automatically filters by the scope parameter. This prevents cross-tenant data leaks — you can never get a campaign for the wrong team.

## @crud

Attaches a model and CRUD configuration to the controller.

```typescript
@crud(Campaign, {
  index: {
    scopes: ['active', 'draft'],    // named scopes (user can request)
    defaultScopes: ['active'],       // always applied
    paramScopes: ['byName'],         // ?byName=foo → Campaign.byName('foo')
    sortable: ['createdAt', 'name'],
    defaultSort: { field: 'createdAt', dir: 'desc' },
    filterable: ['status', 'teamId'],
    include: ['creator'],            // always eager-loaded
    perPage: 25,
    maxPerPage: 100,
  },
  create: {
    permit: ['name', 'budget'],      // only these fields are written
    autoSet: { teamId: ctx => ctx.user.teamId },  // forced from context
  },
  update: { permit: ['name', 'budget'] },
  get:    { include: ['team', 'creator'] },
})
```

**Security rules:**
- `id`, `createdAt`, `updatedAt` are NEVER writeable (excluded from all permits)
- `@scope` fields cannot be included in `permit` — they're set from the URL
- Unknown filter fields throw `400 Bad Request`
- Unknown sort fields throw `400 Bad Request`

## @singleton

For "one per parent" resources (like user settings, team profile):

```typescript
@singleton(TeamSettings, {
  findBy: (ctx) => ({ teamId: ctx.user.teamId }),
  findOrCreate: true,           // creates if missing (race-safe)
  defaultValues: { timezone: 'UTC' },
  update: { permit: ['timezone', 'locale'] },
})
@scope('teamId')
export class TeamSettingsController extends ActiveController<AppContext> {}
```

Generates routes: `GET /teams/:teamId/team-settings`, `PATCH /teams/:teamId/team-settings`, and optionally `POST /teams/:teamId/team-settings` (findOrCreate).

## @mutation

Marks an instance method as a custom mutation. The record is auto-loaded and passed as the first argument.

```typescript
@mutation()
async launch(campaign: Campaign) {
  campaign.status = 'active'
  return campaign.save()
}
```

### Bulk Mutations

Use `bulk: true` to operate on multiple records. By default, all records are loaded into memory and passed as an array.

```typescript
// For 3-10 records: load them all
@mutation({ bulk: true })
async archive(campaigns: Campaign[]) {
  for (const c of campaigns) { c.status = 'archived'; await c.save() }
  return campaigns
}
```

For large batches (100+), use `records: false` to skip loading and perform a single SQL update instead:

```typescript
// For 100+ records: efficient bulk update
@mutation({ bulk: true, records: false })
async archive(ids: number[]) {
  // this.relation is already scoped to organizationId (via scopeBy)
  // and filtered to the requested ids
  await this.relation.updateAll({ status: 'archived' })
  return { count: ids.length }
}
```

Routes generated:
- Non-bulk: `POST /campaigns/:id/launch`
- Bulk: `POST /campaigns/archive` (accepts `{ ids: [1, 2, 3] }`)

## @action

Marks a method as an explicit REST endpoint. Unlike `@mutation` (which always loads a single record by `:id`), `@action` gives you full control over the route shape.

```typescript
// Collection-level: no record loading
@action('GET')
async stats(): Promise<{ totalBudget: number; activeCount: number }> {
  const rel = this.relation
  const totalBudget = await rel.sum('budget')
  const activeCount = await rel.active().count()
  return { totalBudget, activeCount }
}
// → GET /campaigns/stats

@action('POST')
async recalculate(input: { fieldset: string }) {
  await recalculateAll(this.relation, input.fieldset)
  return { ok: true }
}
// → POST /campaigns/recalculate
```

**Record-loading actions** — pass `{ load: true }` as the third argument to auto-load the record by `:id`, just like `@mutation`:

```typescript
@action('GET', undefined, { load: true })
async score(record: Campaign): Promise<{ score: number }> {
  return { score: await computeScore(record) }
}
// → GET /campaigns/:id/score

@action('POST', undefined, { load: true })
async duplicate(record: Campaign) {
  const copy = await Campaign.create({ ...record.attributes, name: `${record.name} (copy)` })
  return copy
}
// → POST /campaigns/:id/duplicate
```

When `load: true`, the loaded record is also available as `this.record` inside `@before` hooks that run for that action — useful for ownership checks.

**Custom paths:**

```typescript
@action('POST', '/campaigns/batch-import')
async batchImport(input: { rows: { name: string; budget: number }[] }) { ... }
// → POST /campaigns/batch-import
```

**Generated frontend names follow the prefix rules:**
- `@action('GET') stats` → `ctrl.indexStats()` — prefixed with `index`
- `@action('GET') indexKeypoints` → `ctrl.indexKeypoints()` — already has `index`, no double-prefix
- `@action('POST') recalculate` → `ctrl.mutateRecalculate()` — prefixed with `mutate`
- `@action('GET', ..., { load: true }) score` → `ctrl.indexScore(id)` — takes an id

---

## @before / @after

Hooks that run before/after actions. Inherited from parent classes (parent hooks fire first, like Rails `before_action` inheritance).

```typescript
export class BaseTeamController extends ActiveController<AppContext> {
  protected team!: Team

  @before()
  async loadTeam() {
    this.team = await Team.find(this.params.teamId)
    // Team.find() throws RecordNotFound if missing — auto-converted to 404
  }
}

@controller()
@crud(Campaign, { /* ... */ })
@scope('teamId')
export class CampaignController extends BaseTeamController {
  // loadTeam() fires before every action automatically

  @before({ only: ['create', 'update'] })
  async checkPlanLimits() {
    if (!this.team.canCreateCampaigns()) throw new Forbidden('Upgrade your plan')
  }
}
```

**`this.record` in hooks:** When an action auto-loads a record (`@mutation` or `@action({ load: true })`), the record is set on `this.record` *before* before-hooks run:

```typescript
@before({ only: ['launch', 'update'] })
async ensureOwner() {
  if (this.record.creatorId !== this.context.user.id) {
    throw new Forbidden('Not your campaign')
  }
}
```

Options:
- `only: ['create', 'update']` — run only for these actions
- `except: ['index']` — run for all EXCEPT these actions
- `if: 'methodName'` or `if: () => boolean` — conditional execution

---

## @rescue

Rails-style error handler. Declare a method that receives the thrown error and either converts it to a different error or returns a fallback value.

```typescript
class SomeServiceError extends Error {}

@controller('/campaigns')
@crud(Campaign, { /* ... */ })
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {

  // Convert third-party errors into user-friendly 400s
  @rescue(SomeServiceError)
  async handleServiceError(e: SomeServiceError) {
    throw new BadRequest(`Service unavailable: ${e.message}`)
  }

  // Swallow a transient error with a fallback (only for 'index')
  @rescue(CacheError, { only: ['index'] })
  async handleCacheMiss(_e: CacheError) {
    return { data: [], pagination: { totalCount: 0 } }
  }
}
```

`@rescue` handlers are **inherited** — define them in a base controller and every subclass gets them automatically.

Options:
- `only: ['create', 'update']` — rescue only for these actions
- `except: ['index']` — rescue for all actions except these

::: tip Auto-rescue for RecordNotFound
You don't need `@rescue` for `RecordNotFound`. Any `RecordNotFound` error thrown anywhere in the dispatch cycle is automatically converted to a `NOT_FOUND` (404) response — including errors thrown by `Model.find()` inside action bodies.
:::
