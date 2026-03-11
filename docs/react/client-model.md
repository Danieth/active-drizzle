# ClientModel & Type Safety

`ClientModel<TAttrs, TWrite>` is the client-side representation of a server record. It is immutable, type-safe in both reading and writing, and fully generated — you never write it by hand.

## Two Type Parameters, Two Guarantees

```typescript
class ClientModel<
  TAttrs,   // Everything the backend can return (columns + included associations)
  TWrite,   // Only what the backend accepts for writes (from the permit list)
>
```

**`TAttrs`** — the read shape. Derived at codegen time from:
- All Drizzle schema columns (typed correctly, with enum columns converted from raw integers to string-literal unions)
- Any associations the controller eager-loads via `include: [...]`

**`TWrite`** — the write shape. A `Pick<TAttrs, ...>` using exactly the fields in the controller's `permit` list. Attempting `.set({ id: 99 })`, `.set({ createdAt: new Date() })`, or `.set({ teamId: 1 })` is a **compile-time error** — those fields are not in the permit list.

## Generated Example

Given this controller config:

```typescript
@crud(Campaign, {
  get:    { include: ['team', 'creator'] },
  create: { permit: ['name', 'budget', 'status', 'startDate'] },
  update: { permit: ['name', 'budget', 'status'] },
})
```

The generator emits:

```typescript
// useCampaign.gen.ts — DO NOT EDIT

import type { TeamAttrs }  from './useTeam.gen'
import type { UserAttrs }  from './useUser.gen'

// All fields the backend returns
export interface CampaignAttrs {
  id: number
  name: string
  budget: number | null
  status: 'draft' | 'active' | 'paused' | 'completed'  // ← string union, not 0/1/2/3
  teamId: number
  creatorId: number | null
  startDate: string | null
  createdAt: string
  updatedAt: string

  // Eager-loaded associations (from include config)
  team?:    TeamAttrs      // from get: { include: ['team'] }
  creator?: UserAttrs      // from get: { include: ['creator'] }
}

// Union of create + update permit lists — what .set() accepts
export type CampaignWrite = Pick<CampaignAttrs,
  'name' | 'budget' | 'status' | 'startDate'>

export class CampaignClient extends ClientModel<CampaignAttrs, CampaignWrite> {
  declare id: number
  declare name: string
  declare budget: number | null
  declare status: 'draft' | 'active' | 'paused' | 'completed'
  declare team?:    TeamAttrs
  declare creator?: UserAttrs

  // Enum predicates — one per variant
  statusIsDraft()     { return this.status === 'draft' }
  statusIsActive()    { return this.status === 'active' }
  statusIsPaused()    { return this.status === 'paused' }
  statusIsCompleted() { return this.status === 'completed' }
}
```

## What This Means at the Call Site

```typescript
const c = CampaignClient.from(serverPayload)

// ✓ Reading — all typed
c.name                   // string
c.status                 // 'draft' | 'active' | 'paused' | 'completed'
c.creator?.email         // string | undefined  (typed from UserAttrs)
c.team?.name             // string | undefined  (typed from TeamAttrs)
c.statusIsActive()       // boolean

// ✓ Writing — only permit-listed fields accepted
c.set({ name: 'New' })           // fine
c.set({ status: 'active' })      // fine
c.set({ startDate: '2026-01-01' }) // fine

// ✗ TypeScript errors — not in CampaignWrite
c.set({ id: 99 })                // ERROR: 'id' not in permit list
c.set({ createdAt: new Date() }) // ERROR: 'createdAt' not in permit list
c.set({ teamId: 5 })             // ERROR: 'teamId' not in permit list (scope field)
c.set({ creator: { ... } })      // ERROR: 'creator' not in permit list (association)
```

## Immutability

`set()` always returns a **new instance** — it never mutates `this`. This plays well with React's rendering model and object identity checks in TanStack Query.

```typescript
const original = CampaignClient.from(serverData)
const updated  = original.set({ name: 'Updated' })

original === updated          // false — new object
original.name === 'Campaign'  // true — original unchanged
updated.name  === 'Updated'   // true
```

## Association Types Extend Automatically

When you add `include: ['media']` to a controller, the generator:

1. Finds the `media` association on the Campaign model
2. Resolves its target table → `medium` model → `MediumClient`
3. Imports `MediumAttrs` from `./useMedium.gen`
4. Adds `media?: MediumAttrs` to `CampaignAttrs`
5. Adds `declare media?: MediumAttrs` to `CampaignClient`

The type automatically tracks what the backend is actually returning. No manual type maintenance.

## Cache Keys

```typescript
export const campaignKeys = modelCacheKeys<{ teamId: number }>('campaigns')

campaignKeys.list({ teamId: 1 }, searchParams)
// → ['campaigns', { teamId: 1 }, 'list', searchParams]

campaignKeys.detail(42, { teamId: 1 })
// → ['campaigns', { teamId: 1 }, 42]
```

Scoped cache keys ensure that invalidating one team's campaigns never touches another's.
