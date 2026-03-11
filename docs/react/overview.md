# React Query Integration

`@active-drizzle/react` ships **React Query hook factories and a type-safe client model**. There are no UI components — bring your own design system. The package gives you the data layer; you own the presentation.

## Installation

```bash
npm install @active-drizzle/react @tanstack/react-query
```

## What Gets Generated

The Vite plugin emits a `use{Model}.gen.ts` file for every controller. Each file contains:

| Export | What it is |
|--------|-----------|
| `{Model}Attrs` | Full read shape — columns + eager-loaded associations |
| `{Model}Write` | Write shape — only `permit`-listed fields |
| `{Model}Client` | Immutable `ClientModel` subclass with typed predicates |
| `{Model}SearchState` | Search/filter state interface |
| `{model}Keys` | Scoped cache key factory |
| `use{Model}s` | TanStack Query hook factory (CRUD or singleton) |
| `use{Model}Search` | Search state hook |
| `{model}FormConfig` | Default values + enum options for TanStack Form |

## Using Generated Hooks

```typescript
// src/pages/campaigns.tsx
import { useCampaigns, useCampaignSearch } from '../models/_generated/useCampaign.gen'

function CampaignsPage({ teamId }: { teamId: number }) {
  const search = useCampaignSearch()
  const campaigns = useCampaigns(teamId)

  const { data, isFetching } = campaigns.index(search.state)
  const createMutation = campaigns.create()

  return (
    <div>
      <input
        value={search.state.q}
        onChange={e => search.set({ q: e.target.value })}
        placeholder="Search campaigns..."
      />

      {data?.pages.flatMap(p => p.items).map(c => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          {/* status is typed: 'draft' | 'active' | 'paused' | 'completed' */}
          {c.statusIsActive() && <span>Live</span>}
          {/* creator typed from UserAttrs (include: ['creator'] in controller) */}
          <span>by {c.creator?.name}</span>
        </div>
      ))}
    </div>
  )
}
```

## Form Integration (TanStack Form)

```tsx
import { useForm } from '@tanstack/react-form'
import { campaignFormConfig } from '../models/_generated/useCampaign.gen'

function CreateCampaignForm({ teamId, onSuccess }) {
  const campaigns = useCampaigns(teamId)
  const createMutation = campaigns.create()

  const form = useForm({
    ...campaignFormConfig,  // typed defaultValues + enum options
    onSubmit: async ({ value }) => {
      // value is typed as CampaignWrite — only permit-listed fields
      await createMutation.mutateAsync(value)
      onSuccess()
    },
  })

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name" children={(f) => (
        <input value={f.state.value} onChange={e => f.handleChange(e.target.value)} />
      )} />

      <form.Field name="status" children={(f) => (
        <select value={f.state.value} onChange={e => f.handleChange(e.target.value)}>
          {campaignFormConfig.enumOptions.status.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )} />

      <button type="submit" disabled={createMutation.isPending}>Create</button>
    </form>
  )
}
```

## Type Safety at Every Layer

The generated code enforces backend rules at the TypeScript layer:

```typescript
const c = CampaignClient.from(serverPayload)

c.set({ name: 'New' })        // ✓ in permit list
c.set({ id: 99 })             // ✗ compile error — not in permit list
c.set({ teamId: 5 })          // ✗ compile error — scope field, backend rejects it
c.creator?.email              // ✓ typed from UserAttrs (via include)
```

See [ClientModel & Type Safety](/react/client-model) for the full explanation.

## Wiring the oRPC Client

The generated hook stubs throw at runtime until you replace them with real oRPC client calls. The pattern looks like:

```typescript
// src/lib/hooks/useCampaigns.ts — your customised wrapper
import { createModelHook, campaignKeys, CampaignClient } from '../models/_generated/useCampaign.gen'
import { client } from '../lib/orpc-client'

export const useCampaigns = (teamId: number) =>
  createModelHook<CampaignClient, { teamId: number }>({
    keys: campaignKeys,
    indexFn:   (scopes, params) => client.campaigns.index({ ...scopes, ...params }),
    getFn:     (id, scopes)     => client.campaigns.get({ id, ...scopes }),
    createFn:  (scopes, data)   => client.campaigns.create({ ...scopes, ...data }),
    updateFn:  (id, scopes, data) => client.campaigns.update({ id, ...scopes, ...data }),
    destroyFn: (id, scopes)     => client.campaigns.destroy({ id, ...scopes }),
    mutationFns: {
      launch: (id, scopes) => client.campaigns.launch({ id, ...scopes }),
      pause:  (id, scopes) => client.campaigns.pause({ id, ...scopes }),
    },
  })
```

The oRPC client is fully typed from `_routes.gen.ts` — the argument shapes and return types are inferred end-to-end.
