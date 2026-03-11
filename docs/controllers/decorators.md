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

// Bulk mutation (operates on multiple records)
@mutation({ bulk: true })
async archive(campaigns: Campaign[]) {
  for (const c of campaigns) { c.status = 'archived'; await c.save() }
  return campaigns
}
```

Routes generated:
- Non-bulk: `POST /campaigns/:id/launch`
- Bulk: `POST /campaigns/archive`

## @before / @after

Hooks that run before/after actions. Inherited from parent classes (parent hooks fire first, like Rails `before_action` inheritance).

```typescript
export class BaseTeamController extends ActiveController<AppContext> {
  protected team!: Team

  @before()
  async loadTeam() {
    this.team = await Team.find(this.params.teamId)
    if (!this.team) throw new NotFound('Team')
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

Options:
- `only: ['create', 'update']` — run only for these actions
- `except: ['index']` — run for all EXCEPT these actions
- `if: 'methodName'` or `if: () => boolean` — conditional execution
