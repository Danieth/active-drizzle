# Multi-Tenant Controllers

Every SaaS app that uses an external auth provider (Clerk, Auth0, WorkOS) faces the same controller-layer problem: the session gives you an external org ID (`org_2xk9abc`), but your database has an internal integer (`organizations.id = 47`). Every org-scoped query needs this translation — and it gets copy-pasted into every controller.

ActiveDrizzle solves this with **controller state** and **typed resolvers**: you write the org-loading logic once in a base controller class, and every child controller inherits it for free.

## The Design

Three primitives work together:

| Primitive | What it is |
|-----------|-----------|
| `this.state` | Mutable per-request object, typed via `TState` generic. `@before` hooks write to it; actions and child controllers read from it. |
| `scopeBy` | `@crud` config option — a function `(ctrl) => whereClause` applied to `this.relation` after `@before` hooks run. Scopes all CRUD queries from resolved state. |
| `autoSet` (updated) | `create` config — now receives `(ctx, ctrl)`, so you can stamp fields from `ctrl.state`. |

## Your First OrgController

Define a typed base class that resolves the org once per request:

```ts
// src/controllers/OrgController.ts
import { ActiveController, before } from '@active-drizzle/controller'
import { Forbidden, Unauthorized } from '@active-drizzle/controller'
import { Organization } from '../models/Organization.model'

type AppContext = {
  userId:  string | null
  orgId:   string | null   // Clerk org ID (external)
  orgRole: string | null   // 'org:admin' | 'org:member'
}

type OrgState = {
  org: typeof Organization.prototype
}

export class OrgController extends ActiveController<AppContext, OrgState> {
  @before()
  async resolveOrg() {
    if (!this.context.userId) throw new Unauthorized()
    if (!this.context.orgId)  throw new Forbidden('No active organization')

    // Trust the Clerk session: if orgId is in the token, membership is verified.
    // Find-or-create the internal org record. Race-safe on concurrent requests.
    this.state.org = await Organization.findOrCreateBy(
      { clerkOrgId: this.context.orgId },
      { name: 'Unknown' },
    )
  }

  protected requireAdmin() {
    if (this.context.orgRole !== 'org:admin') {
      throw new Forbidden('Requires admin role')
    }
  }
}
```

`this.state.org` is now fully typed in every child controller — autocomplete works, TypeScript catches typos.

## Scoping CRUD with scopeBy

Use `scopeBy` to automatically filter all queries to the resolved org. The function receives the controller instance (with `this.state` populated):

```ts
// src/controllers/AssetController.ts
import { controller, crud } from '@active-drizzle/controller'
import { OrgController } from './OrgController'
import { Asset } from '../models/Asset.model'

@controller('/assets')
@crud(Asset, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),

  index: {
    sortable: ['createdAt', 'filename'],
    include: ['uploader'],
  },

  create: {
    permit: ['key', 'url', 'filename', 'contentType', 'sizeBytes'],
    autoSet: {
      organizationId: (_ctx, ctrl) => ctrl.state.org.id,
      uploadedById:   (ctx) => ctx.userId,
    },
  },

  update: {
    permit: ['filename'],
  },
})
export class AssetController extends OrgController {
  // No org loading. No scope SQL. No stamping.
  // 5 CRUD actions, all scoped, all stamped.
}
```

`scopeBy` runs after `@before` hooks complete, so `ctrl.state.org` is guaranteed to be set. It applies `.where({ organizationId: ctrl.state.org.id })` to `this.relation` before every action.

## How scopeBy and autoSet Work Together

| Config | When it runs | What it does |
|--------|-------------|-------------|
| `scopeBy` | After `@before` hooks, before every action | Filters `this.relation` (index, get, update, destroy) |
| `autoSet` | On create, inside `buildPermittedData` | Stamps fields on new records |

For creates, `scopeBy` alone isn't enough — new records need `organizationId` stamped explicitly via `autoSet`. Both are usually needed:

```ts
@crud(Campaign, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),  // queries
  create: {
    permit: ['name', 'budget'],
    autoSet: {
      organizationId: (_ctx, ctrl) => ctrl.state.org.id,       // new records
    },
  },
})
```

## @actions and @mutations

`@action` and `@mutation` methods have full access to `this.state` inside the method body. No extra setup needed:

```ts
@controller('/invitations')
export class InvitationController extends OrgController {
  @action('POST')
  async invite() {
    this.requireAdmin()
    const { email, role } = this.params
    return await clerkApi.inviteToOrg(this.state.org.clerkOrgId, email, role)
  }
}
```

```ts
@controller('/uploads')
export class UploadController extends OrgController {
  @action('POST')
  async presign() {
    const { filename, contentType } = this.params
    const key = `orgs/${this.state.org.id}/uploads/${crypto.randomUUID()}/${filename}`
    const url = await s3.getSignedUrl(key, contentType)
    return { url, key }
  }
}
```

## Singleton Resources

`@singleton`'s `findBy` now receives `(ctx, ctrl)` so it can use `ctrl.state`:

```ts
@controller('/settings')
@singleton(OrgSettings, {
  findBy: (_ctx, ctrl) => ({ organizationId: ctrl.state.org.id }),
  findOrCreate: true,
  defaultValues: { timezone: 'UTC', notificationsEnabled: true },
  update: { permit: ['timezone', 'notificationsEnabled'] },
})
export class OrgSettingsController extends OrgController {
  // GET  /settings → find-or-create settings for this org
  // PATCH /settings → update permitted fields
}
```

## Role-Based Field Permissions

`permit` can be a function `(ctx, ctrl) => string[]`, enabling dynamic field lists based on state:

```ts
@crud(Campaign, {
  update: {
    permit: (_ctx, ctrl) => ctrl.state.canAdmin
      ? ['name', 'budget', 'status', 'startDate']
      : ['name'],
  },
})
export class CampaignController extends OrgController {}
```

The resolved `permit` list is enforced at runtime. TypeScript won't catch it statically, but the runtime filter ensures non-admins can only change `name`.

## Nested State: Org → Team → Resource

State accumulates layer by layer as you go deeper in the inheritance chain:

```ts
// OrgState is provided by OrgController
type TeamState = OrgState & { team: typeof Team.prototype }

export class TeamController extends OrgController {
  @before()
  async resolveTeam() {
    const team = await Team
      .where({ organizationId: this.state.org.id, id: this.params.teamId })
      .first()
    if (!team) throw new NotFound('Team')
    this.state.team = team
  }
}

@controller('/campaigns')
@scope('teamId')
@crud(Campaign, {
  create: {
    permit: ['name', 'budget'],
    autoSet: {
      teamId:    (_ctx, ctrl) => ctrl.state.team.id,
      creatorId: (ctx) => ctx.userId,
    },
  },
})
export class CampaignController extends TeamController {
  // this.state.org  — from OrgController
  // this.state.team — from TeamController
  // All CRUD scoped to team (via @scope + autoSet)
}
```

Hook execution order is always **parent-first** — `OrgController.resolveOrg()` runs before `TeamController.resolveTeam()`, so `this.state.org` is set when `resolveTeam` needs it.

## Security Model

`scopeBy` adds defence-in-depth, but the primary security gate is your `@before` hook:

1. **Authentication**: Your middleware runs before the controller, validates the session, sets `context.userId` and `context.orgId`.
2. **Authorization**: `resolveOrg()` throws `Unauthorized` / `Forbidden` if the user can't act on the requested org.
3. **Scoping**: `scopeBy` ensures all queries are filtered to the org, preventing accidental cross-tenant data reads.
4. **Stamping**: `autoSet` ensures new records are always written to the correct org.

For cross-tenant safety with `@mutation` routes, note that the record is pre-loaded from the URL-scoped relation (before `@before` hooks). `scopeBy` then filters `this.relation` for any further queries inside the action. If you need strict per-mutation verification, add a `@before({ only: ['mutationName'] })` check:

```ts
@before({ only: ['transfer'] })
async verifyOwnership() {
  if (this.record.organizationId !== this.state.org.id) {
    throw new Forbidden('Record belongs to a different organization')
  }
}
```

## findOrCreateBy with Defaults

`ApplicationRecord.findOrCreateBy` now accepts a second `defaults` argument. The race-safe variant is automatically used:

```ts
// Finds or creates in a single call. Safe for concurrent requests.
const org = await Organization.findOrCreateBy(
  { clerkOrgId: 'org_abc123' },      // find conditions
  { name: 'Unknown', slug: 'default' }, // extra fields for create only
)
```

If two concurrent requests both call this for the same `clerkOrgId`, the losing request catches the unique-constraint error, retries the `SELECT`, and returns the row created by the winner — no duplicates, no crashes.

## Example: The Complete AdioPilot Setup

```ts
// src/controllers/OrgController.ts
type AppContext = { userId: string | null; orgId: string | null; orgRole: string | null }
type OrgState   = { org: OrganizationRecord }

export class OrgController extends ActiveController<AppContext, OrgState> {
  @before()
  async resolveOrg() {
    if (!this.context.userId) throw new Unauthorized()
    if (!this.context.orgId)  throw new Forbidden('No active org')
    this.state.org = await Organization.findOrCreateBy({ clerkOrgId: this.context.orgId }, { name: 'Unknown' })
  }

  protected requireAdmin() {
    if (this.context.orgRole !== 'org:admin') throw new Forbidden('Admin only')
  }
}

// src/controllers/AssetController.ts
@controller('/assets')
@crud(Asset, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),
  create: {
    permit: ['key', 'url', 'filename', 'contentType', 'sizeBytes'],
    autoSet: {
      organizationId: (_ctx, ctrl) => ctrl.state.org.id,
      uploadedById:   (ctx) => ctx.userId,
    },
  },
  update: { permit: ['filename'] },
})
export class AssetController extends OrgController {}

// src/controllers/InvitationController.ts
@controller('/invitations')
export class InvitationController extends OrgController {
  @action('POST')
  async invite() {
    this.requireAdmin()
    return await clerkApi.inviteToOrg(this.state.org.clerkOrgId, this.params.email, this.params.role)
  }
}

// src/controllers/OrgSettingsController.ts
@controller('/settings')
@singleton(OrgSettings, {
  findBy: (_ctx, ctrl) => ({ organizationId: ctrl.state.org.id }),
  findOrCreate: true,
  defaultValues: { timezone: 'UTC' },
  update: { permit: ['timezone', 'notificationsEnabled'] },
})
export class OrgSettingsController extends OrgController {}
```

Four controllers. Zero repeated org-loading SQL. Zero chance of forgetting to scope a query. That's the point.
