# ClientModel

`ClientModel<TAttrs>` is an immutable client-side record. Codegen emits a typed subclass for each model with:

- Predicate methods (`isDraft()`, `isActive()`)
- `@pure` method stubs (`assetCount()`, `hasAssets()`)
- Typed `set()` for producing a new instance with updated fields

## API

```typescript
// Read attributes
const c = campaign.get()          // { id: 1, name: 'Launch', status: 'active', ... }
c.name                             // 'Launch'
c.status                           // 'active' (enum label, not raw int)

// Produce updated copy (immutable)
const updated = c.set({ name: 'Relaunched' })  // new ClientModel instance

// Convert to plain object
c.toObject()                        // { id: 1, name: 'Launch', ... }

// Create from raw server data
CampaignClient.from({ id: 1, name: 'Launch', status: 1, teamId: 42 })
```

## Generated Predicates

For every `defineEnum` in the model, codegen emits a predicate per variant:

```typescript
// Model:
static status = defineEnum({ draft: 0, active: 1, paused: 2, completed: 3 })

// Generated ClientModel:
isDraft():      boolean { return this.status === 'draft' }
isActive():     boolean { return this.status === 'active' }
isPaused():     boolean { return this.status === 'paused' }
isCompleted():  boolean { return this.status === 'completed' }
```

## Cache Key Factories

```typescript
import { modelCacheKeys } from '@active-drizzle/react'

const keys = modelCacheKeys('campaigns', { teamId: 1 })
keys.all()                  // ['campaigns', { teamId: 1 }]
keys.index(searchState)     // ['campaigns', { teamId: 1 }, 'index', searchState]
keys.record(42)             // ['campaigns', { teamId: 1 }, 42]
keys.search(q)              // ['campaigns', { teamId: 1 }, 'search', q]
```

Cache keys are scoped, so invalidating one team's campaign cache never affects another's.
