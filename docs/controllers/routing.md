# Routing & URL Structure

ActiveDrizzle generates REST routes automatically from your controller decorators. The URL structure is determined by the class name, `@controller` path, and `@scope` decorators.

## Path Inference

If you don't provide a path to `@controller`, the class name is transformed automatically:

| Class name | Inferred path |
|------------|---------------|
| `PostController` | `/posts` |
| `CampaignController` | `/campaigns` |
| `TeamSettingsController` | `/team-settings` |
| `APIKeyController` | `/api-keys` |

The transformation: strip `Controller`, camelCase → kebab-case, pluralize.

Override at any time:

```ts
@controller('/v2/blog-entries')
export class PostController extends ActiveController<AppContext> {}
```

## Scope Nesting — `@scope`

`@scope` nests the controller under a parent resource. The field name determines the URL segment and the `WHERE` clause applied to all queries:

```ts
@scope('teamId')
// Prefix: /teams/:teamId
// Query filter: WHERE team_id = :teamId  (applied to every action)
```

Scopes stack from the outer decorator inward:

```ts
@controller()
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {}
// Routes: /teams/:teamId/campaigns, /teams/:teamId/campaigns/:id, etc.

@controller()
@scope('teamId')
@scope('campaignId')
export class AssetController extends ActiveController<AppContext> {}
// Routes: /teams/:teamId/campaigns/:campaignId/assets, etc.
```

### Field Inference

The scope field name is used to derive both the resource segment and the param name:

| `@scope(field)` | URL segment | Param name in `this.params` |
|-----------------|-------------|----------------------------|
| `@scope('teamId')` | `/teams/:teamId` | `teamId` |
| `@scope('campaignId')` | `/campaigns/:campaignId` | `campaignId` |
| `@scope('userId')` | `/users/:userId` | `userId` |

Custom resource name:

```ts
// Override by providing an explicit path on @controller
@controller('/orgs/:orgId/workspaces')
@scope('orgId')
export class WorkspaceController extends ActiveController<AppContext> {}
```

## Default CRUD Route Table

For `@crud(Model, config)`, these routes are always generated:

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/resources` | `index` |
| `POST` | `/resources` | `create` |
| `GET` | `/resources/:id` | `get` |
| `PATCH` | `/resources/:id` | `update` |
| `DELETE` | `/resources/:id` | `destroy` |

With `@scope('teamId')`:

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/teams/:teamId/resources` | `index` |
| `POST` | `/teams/:teamId/resources` | `create` |
| `GET` | `/teams/:teamId/resources/:id` | `get` |
| `PATCH` | `/teams/:teamId/resources/:id` | `update` |
| `DELETE` | `/teams/:teamId/resources/:id` | `destroy` |

## Mutation Routes

`@mutation()` adds a `POST /:id/<kebab>` route:

```ts
@mutation()
async launch(campaign: Campaign) { ... }
// → POST /teams/:teamId/campaigns/:id/launch

@mutation({ bulk: true })
async bulkArchive(campaigns: Campaign[]) { ... }
// → POST /teams/:teamId/campaigns/bulk-archive
```

Method names are kebab-cased: `bulkArchive` → `/bulk-archive`.

## Action Routes

`@action` routes default to the method name (kebab-cased). With `load: true`, `:id` is added:

```ts
@action('GET')
async stats() { ... }
// → GET /teams/:teamId/campaigns/stats

@action('POST')
async reindex(input: { force: boolean }) { ... }
// → POST /teams/:teamId/campaigns/reindex

@action('GET', undefined, { load: true })
async score(record: Campaign) { ... }
// → GET /teams/:teamId/campaigns/:id/score

// Custom explicit path
@action('POST', '/teams/:teamId/campaigns/batch-import')
async batchImport(input: { rows: any[] }) { ... }
// → POST /teams/:teamId/campaigns/batch-import
```

## Singleton Routes

`@singleton` generates three routes (no `:id`):

```ts
@singleton(TeamSettings, {
  findOrCreate: true,
  findBy: (ctx) => ({ teamId: ctx.teamId }),
  update: { permit: ['timezone'] },
})
@scope('teamId')
export class TeamSettingsController extends ActiveController<AppContext> {}
```

| Method | Path | Action |
|--------|------|--------|
| `GET` | `/teams/:teamId/team-settings` | `get` |
| `POST` | `/teams/:teamId/team-settings` | `findOrCreate` (if enabled) |
| `PATCH` | `/teams/:teamId/team-settings` | `update` |

## Inspecting Generated Routes

`buildRouter` returns a `routes` array you can print during development:

```ts
const { routes } = buildRouter(CampaignController)
routes.forEach(r => console.log(`${r.method} ${r.path}`))
// GET    /teams/:teamId/campaigns
// POST   /teams/:teamId/campaigns
// GET    /teams/:teamId/campaigns/:id
// PATCH  /teams/:teamId/campaigns/:id
// DELETE /teams/:teamId/campaigns/:id
// POST   /teams/:teamId/campaigns/:id/launch
// POST   /teams/:teamId/campaigns/bulk-archive
// GET    /teams/:teamId/campaigns/stats
```

## oRPC Procedure Keys

Each route also has a dotted procedure key used to address it in the oRPC client:

```ts
routes[0].procedure   // e.g. 'index', 'get', 'create', 'launch', 'stats'
```

When using `mergeRouters`, the keys are namespaced by the base path:

```ts
// /teams/:teamId/campaigns  → teams_teamId_campaigns
router.teams_teamId_campaigns.index
router.teams_teamId_campaigns.create
```

The generated `_client.ts` handles this mapping automatically — you never reference these keys directly.
