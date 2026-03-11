# Controllers Overview

Controllers wire your models to HTTP endpoints. Decorate a class with `@controller` and `@crud`, and active-drizzle generates a fully-typed oRPC router — index, get, create, update, destroy, plus any custom mutations you define.

## Installation

```bash
npm install @active-drizzle/controller @orpc/server zod
```

## Quick Start

```typescript
// src/controllers/Campaign.ctrl.ts
import { controller, crud, scope, mutation, before, ActiveController } from '@active-drizzle/controller'
import { Campaign } from '../models/Campaign.model'
import { NotFound } from '@active-drizzle/controller'

@controller()
@crud(Campaign, {
  index: {
    scopes: ['active', 'draft', 'paused'],
    defaultScopes: [],
    paramScopes: ['byName'],      // ?byName=foo  →  Campaign.byName('foo')
    sortable: ['createdAt', 'name', 'budget'],
    defaultSort: { field: 'createdAt', dir: 'desc' },
    filterable: ['status'],       // codegen infers type from model's Attr.enum
    include: ['creator'],
    perPage: 25,
    maxPerPage: 100,
  },
  create: {
    permit: ['name', 'budget', 'status', 'startDate'],
    autoSet: { teamId: (ctx) => ctx.user.teamId },
  },
  update: { permit: ['name', 'budget', 'status', 'startDate'] },
  get:    { include: ['team', 'creator'] },
})
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {
  @mutation()
  async launch(campaign: Campaign) {
    // campaign is auto-loaded from :id — no manual find() needed
    if (!campaign.hasAssets()) throw new BadRequest('Add assets before launching')
    campaign.status = 'active'
    campaign.startDate = new Date()
    return campaign.save()
  }
}
```

## Building the oRPC Router

```typescript
// src/server/router.ts
import { buildRouter, mergeRouters } from '@active-drizzle/controller'
import { CampaignController } from './controllers/Campaign.ctrl'
import { TeamSettingsController } from './controllers/TeamSettings.ctrl'

export const { router, routes } = mergeRouters(
  buildRouter(CampaignController),
  buildRouter(TeamSettingsController),
)

export type AppRouter = typeof router
```

With the Vite plugin, this file is generated automatically as `_routes.gen.ts`.
