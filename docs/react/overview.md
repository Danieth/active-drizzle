# React Integration Overview

`@active-drizzle/react` provides immutable client-side models, TanStack Query hook factories, and composable UI components. Combined with the hook codegen, you only write the component — everything else is generated.

## Installation

```bash
npm install @active-drizzle/react @tanstack/react-query @tanstack/react-form react
```

## Generated Hooks

The Vite plugin emits a `use{Model}.gen.ts` file next to every controller. These hooks wire directly to the oRPC client.

```typescript
// src/models/_generated/useCampaign.gen.ts  — GENERATED, do not edit

export const useCampaigns = (teamId: number) =>
  createModelHook<CampaignClient, CampaignSearchState>({
    keys: campaignCacheKeys(teamId),
    client: campaignClient,
    searchDefaults: { q: '', scopes: ['active'], sort: 'createdAt', dir: 'desc' },
    formConfig: campaignFormConfig,
  })

export const useCampaignSearch = () =>
  createSearchHook<CampaignSearchState>({
    defaults: { q: '', scopes: ['active'], sort: 'createdAt', dir: 'desc' },
  })
```

## Using Hooks in a Component

```tsx
import { useCampaigns, useCampaignSearch } from '../models/_generated/useCampaign.gen'
import { IntersectionTrigger } from '@active-drizzle/react'

function CampaignsPage({ teamId }: { teamId: number }) {
  const search = useCampaignSearch()
  const campaigns = useCampaigns(teamId)

  const { data, isEmpty, hasNextPage, fetchNextPage } = campaigns.index(search.state)
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
          <span>{c.assetCount()} assets</span>
          {c.isDraft() && <button>Launch</button>}
        </div>
      ))}

      {hasNextPage && <IntersectionTrigger onVisible={fetchNextPage} />}
    </div>
  )
}
```

## Form Integration (TanStack Form)

The generated `formConfig` object provides default values, validators, and enum option lists:

```tsx
import { useForm } from '@tanstack/react-form'
import { campaignFormConfig } from '../models/_generated/useCampaign.gen'

function CreateCampaignForm({ teamId, onSuccess }) {
  const campaigns = useCampaigns(teamId)
  const createMutation = campaigns.create()

  const form = useForm({
    ...campaignFormConfig,
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync(value)
      onSuccess()
    },
  })

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name" children={(f) => (
        <div>
          <label>Name</label>
          <input value={f.state.value} onChange={e => f.handleChange(e.target.value)} />
          {f.state.meta.errors?.map(e => <span className="text-red-500">{e}</span>)}
        </div>
      )} />

      <form.Field name="status" children={(f) => (
        <div>
          <label>Status</label>
          <select value={f.state.value} onChange={e => f.handleChange(e.target.value)}>
            {campaignFormConfig.fields.status.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )} />

      <button type="submit" disabled={createMutation.isPending}>
        {createMutation.isPending ? 'Creating…' : 'Create'}
      </button>
    </form>
  )
}
```
