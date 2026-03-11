# The Happy Path

One flow, end to end. This document walks through a single concept: **list campaigns, create one, launch it** — from schema to React, showing how each layer connects.

---

## The Flow

```
Schema → Model → Controller → Generated Client → React Component
  │         │         │              │                  │
  │         │         │              │                  └─ ctrl.index(), ctrl.mutateCreate(), ctrl.mutateLaunch()
  │         │         │              └─ CampaignController.use({ teamId })
  │         │         └─ @crud, @mutation, permit, scopes
  │         └─ ApplicationRecord, associations, hooks
  └─ Drizzle pgTable
```

---

## 1. Schema (Drizzle)

Your tables. Single source of truth for columns and types.

```ts
// db/schema.ts
export const campaigns = pgTable('campaigns', {
  id:        serial('id').primaryKey(),
  teamId:    integer('team_id').notNull(),
  name:      varchar('name', { length: 255 }).notNull(),
  status:    integer('status').notNull().default(0),
  budget:    integer('budget'),
  createdAt: timestamp('created_at').defaultNow(),
})
```

---

## 2. Model (ApplicationRecord)

Business logic: associations, scopes, hooks. Column types flow from the schema via codegen.

```ts
// models/Campaign.model.ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static team   = belongsTo()
  static status = Attr.enum({ draft: 0, active: 1, paused: 2 } as const)

  @scope
  static active() { return this.where({ status: 1 }) }

  @pure
  isLaunchable() { return this.status === 'draft' }
}
```

---

## 3. Controller (HTTP boundary)

Wires the model to HTTP. Defines **permit** (what clients can write), **scopes** (how to filter), and custom mutations.

The `@mutation` decorator auto-loads the record by `:id` and passes it in — no manual `find()` needed.

```ts
// controllers/Campaign.ctrl.ts
@controller('/campaigns')
@crud(Campaign, {
  index: {
    scopes: ['active', 'draft'],
    sortable: ['createdAt', 'name'],
    include: ['creator'],
  },
  create: {
    permit: ['name', 'budget', 'status'],
    autoSet: { teamId: (ctx) => ctx.teamId },
  },
  update: { permit: ['name', 'budget', 'status'] },
})
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {
  @mutation()
  async launch(campaign: Campaign) {
    // campaign is auto-loaded from :id — no manual find() needed
    if (!campaign.isLaunchable()) throw new BadRequest('Already launched')
    campaign.status = 'active'
    return campaign.save()
  }
}
```

---

## 4. Generated Client (codegen)

The Vite plugin generates typed controller objects. You never write this.

```ts
// _generated/Campaign.ctrl.gen.ts (conceptual)
export const CampaignController = {
  use: (scopes: { teamId: number }) => ({
    // Queries
    index:        (params?) => useQuery(...),
    infiniteIndex:(params?) => useInfiniteQuery(...),
    get:          (id) => useQuery(...),

    // Mutations — all prefixed with 'mutate' so autocomplete surfaces them instantly
    mutateCreate:  () => useMutation(...),
    mutateUpdate:  () => useMutation(...),
    mutateDestroy: () => useMutation(...),
    mutateLaunch:  () => useMutation(...),
  }),
  with: (scopes: { teamId: number }) => ({
    // Same names, direct async calls — no hooks
    index:        (params?) => client.campaigns.index(...),
    mutateCreate: (data) => client.campaigns.create(...),
    mutateLaunch: (id) => client.campaigns.launch(...),
  }),
}
```

---

## 5. React Component

Use `.use()` inside components for hooks. The `mutate*` prefix makes it obvious at a glance what will trigger a network request vs what returns query data.

```tsx
// pages/CampaignsPage.tsx
import { CampaignController } from '../_generated'

function CampaignsPage({ teamId }: { teamId: number }) {
  const ctrl = CampaignController.use({ teamId })

  const { data, isLoading } = ctrl.index({ scopes: ['active'], sort: { field: 'createdAt', dir: 'desc' } })
  const create = ctrl.mutateCreate()
  const launch = ctrl.mutateLaunch()

  return (
    <div>
      {data?.items.map(c => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          {c.statusIsDraft() && (
            <button onClick={() => launch.mutate(c.id)}>Launch</button>
          )}
        </div>
      ))}
      <button
        onClick={() => create.mutate({ name: 'New', status: 'draft' })}
        disabled={create.isPending}
      >
        New Campaign
      </button>
    </div>
  )
}
```

---

## Data Flow Summary

| Step | What happens |
|------|---------------|
| **List** | `ctrl.index()` → `useQuery` → oRPC `GET /campaigns` → `Campaign.where({ teamId }).active().load()` → JSON → `ClientModel` instances |
| **Create** | `create.mutate({ name, status })` → `useMutation` → oRPC `POST /campaigns` → `Campaign.create({ ...permit, teamId })` → invalidate → refetch |
| **Launch** | `launch.mutate(id)` → `useMutation` → oRPC `POST /campaigns/:id/launch` → record auto-loaded → `campaign.save()` → invalidate → refetch |

---

## Outside React

Use `.with()` for server actions, form submit handlers, background jobs, or any non-React code:

```ts
const campaign = await CampaignController.with({ teamId: 1 }).mutateCreate({ name: 'Q1', status: 'draft' })
```

---

## One Concept

**Schema** defines structure. **Model** defines behavior. **Controller** defines the HTTP API and permit list. **Codegen** produces typed clients. **React** consumes them via `.use()` and `.with()`.

That's the happy path.
