# React Query Integration

`@active-drizzle/react` is a pure data layer — no UI components, no design system. The Vite plugin generates a typed **Controller object** per controller file. Each object exposes two access patterns: `.use()` for React Query hooks inside components, and `.with()` for direct async calls outside React.

After reading this guide you will understand:

- What gets generated and how to configure the oRPC client
- The `.use()` pattern for all query and mutation types
- The `.with()` pattern for server actions and event handlers
- How the `mutate*` / `index*` naming convention works
- Search state, infinite scroll, and cache management
- Form integration with TanStack Form
- Error handling with `parseControllerError`

---

## 1. Installation

```bash
npm install @active-drizzle/react @tanstack/react-query
```

Wrap your app with `QueryClientProvider`:

```tsx
// src/main.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient()

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router />
    </QueryClientProvider>
  )
}
```

---

## 2. What Gets Generated

For every `.ctrl.ts` file, the Vite plugin emits a `{controller}.gen.ts` file alongside a shared barrel and client stub:

```
src/
  _generated/
    CampaignController.gen.ts   ← types + hook object per controller
    PostController.gen.ts
    UploadController.gen.ts
    index.ts                    ← barrel re-export (auto-regenerated)
    _client.ts                  ← oRPC client wiring (written once, never overwritten)
```

### `{controller}.gen.ts` exports

| Export | What it is |
|--------|-----------|
| `{Model}Attrs` | Full read shape — all columns + eager-loaded associations from `include:` config |
| `{Model}Write` | Write shape — only `permit`-listed fields from the controller |
| `{Model}Client` | Immutable `ClientModel` subclass with enum predicates and `@pure` methods |
| `{Model}SearchState` | Search/filter/sort state for index queries |
| `{model}Keys` | TanStack Query cache key factory |
| `{ControllerName}` | The controller object with `.use()` and `.with()` |

---

## 3. The oRPC Client — One-Time Setup

Edit `_generated/_client.ts` once. Every generated hook imports from it:

```ts
// _generated/_client.ts
import { createORPCClient } from '@orpc/client'
import { RPCLink }         from '@orpc/client/fetch'
import type { AppRouter }  from '../server/_routes.gen.js'

export const client = createORPCClient<AppRouter>(
  new RPCLink({ url: '/api/rpc' })
)
```

`AppRouter` comes from your server's `_routes.gen.ts` — generated from your `.ctrl.ts` files. The client is fully typed end-to-end: controller → oRPC procedure → hook argument types.

---

## 4. The Two Access Patterns

Every generated controller exports an object with two methods:

```ts
import { CampaignController } from '../_generated'

// ── .use(scopes) ──────────────────────────────────────────────────────
// Call inside React components. Returns hook call results directly.
// The scopes object matches your @scope decorators: @scope('teamId') → { teamId: number }

const ctrl = CampaignController.use({ teamId })

// ── .with(scopes) ─────────────────────────────────────────────────────
// Call outside React — event handlers, server actions, tests.
// Returns direct async functions with the same names.

const api = CampaignController.with({ teamId })
```

### When to use `.use()`

Use `.use()` inside React components. Each property on the returned object is the **result** of calling the corresponding TanStack Query hook — so you destructure it immediately:

```tsx
function CampaignsPage({ teamId }: { teamId: number }) {
  const ctrl = CampaignController.use({ teamId })

  const { data, isLoading } = ctrl.index()      // useQuery result
  const create = ctrl.mutateCreate()             // useMutation result
  const launch = ctrl.mutateLaunch()             // useMutation result

  return (
    <button onClick={() => create.mutate({ name: 'New', status: 'draft' })}>
      New Campaign
    </button>
  )
}
```

### When to use `.with()`

Use `.with()` anywhere hooks aren't available — outside React components, in route loaders, server actions, test files, or CLI scripts:

```ts
// Outside a component (server action, route loader, test)
const campaign = await CampaignController.with({ teamId: 1 }).mutateCreate({
  name: 'Q1 Push',
  status: 'draft',
  budget: 50000,
})
```

---

## 5. Naming Convention

The generated method names follow deterministic prefix rules so autocomplete reveals the full API instantly. **Queries** surface under `index`, `get`, or a named variant. **Mutations** always start with `mutate`.

### Queries

| Source | Generated name | Hook |
|--------|---------------|------|
| `index` (default CRUD) | `ctrl.index(params?)` | `useQuery` |
| `index` (infinite scroll) | `ctrl.infiniteIndex(params?)` | `useInfiniteQuery` |
| `get` (default CRUD) | `ctrl.get(id)` | `useQuery` |
| `@action('GET') stats` | `ctrl.indexStats()` | `useQuery` — `index` prefix added |
| `@action('GET') indexKeypoints` | `ctrl.indexKeypoints()` | `useQuery` — already has `index` |
| `@action('GET') getSummary` | `ctrl.getSummary()` | `useQuery` — already starts with `get` |
| `@action('GET', ..., { load: true }) score` | `ctrl.indexScore(id)` | `useQuery` — takes `id` |

### Mutations

| Source | Generated name | Hook |
|--------|---------------|------|
| `create` | `ctrl.mutateCreate()` | `useMutation` |
| `update` | `ctrl.mutateUpdate()` | `useMutation` |
| `destroy` | `ctrl.mutateDestroy()` | `useMutation` |
| `@mutation() launch` | `ctrl.mutateLaunch()` | `useMutation` |
| `@mutation({ bulk: true }) archive` | `ctrl.mutateBulkArchive()` | `useMutation` |
| `@mutation({ bulk: true }) bulkArchive` | `ctrl.mutateBulkArchive()` | `useMutation` — `bulk` deduped |
| `@action('POST') recalculate` | `ctrl.mutateRecalculate()` | `useMutation` |
| `@action('POST', ..., { load: true }) assign` | `ctrl.mutateAssign()` | `useMutation` — `{ id, ...data }` |

---

## 6. Queries in Detail

### Collection Query — `ctrl.index(params?)`

Returns a paginated list. Pass search state from a search hook or build it manually:

```tsx
const { data, isLoading, isFetching } = ctrl.index({
  scopes:  ['active'],
  sort:    { field: 'createdAt', dir: 'desc' },
  filters: { status: 'active' },
  page:    0,
  perPage: 25,
})

data?.data          // CampaignClient[] — typed instances with enum predicates
data?.pagination    // { page, perPage, totalCount, hasMore }
```

The `{Model}SearchState` type documents every available field in the `params` object — scope names, sort options, filter keys, and pagination fields — all inferred from the controller's `index` configuration.

### Infinite Scroll — `ctrl.infiniteIndex(params?)`

```tsx
const {
  data,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
} = ctrl.infiniteIndex({ scopes: ['active'] })

// Flatten all pages
const campaigns = data?.pages.flatMap(page => page.data) ?? []

return (
  <>
    {campaigns.map(c => <CampaignCard key={c.id} campaign={c} />)}
    {hasNextPage && (
      <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
        Load more
      </button>
    )}
  </>
)
```

### Single Record — `ctrl.get(id)`

Pass `null` or `undefined` to disable fetching (e.g. when the id isn't known yet):

```tsx
const { data: campaign, isLoading } = ctrl.get(selectedId)
// selectedId = null → query is disabled, no network request
// selectedId = 5   → fetches campaign 5
```

### Collection Action — `ctrl.indexStats()`

```tsx
const { data: stats } = ctrl.indexStats()
stats?.total   // number
stats?.active  // number
```

### Record-Level Query — `ctrl.indexScore(id)`

From `@action('GET', ..., { load: true })`:

```tsx
const { data: scoreData } = ctrl.indexScore(campaign.id)
```

---

## 7. Mutations in Detail

All mutation hooks return a TanStack `UseMutationResult`. Call `.mutate()` for fire-and-forget, or `.mutateAsync()` when you need to await the result.

### Create

```tsx
const create = ctrl.mutateCreate()

// Fire-and-forget
create.mutate({ name: 'New Campaign', status: 'draft', budget: 5000 })

// Await and use the result
const campaign = await create.mutateAsync({ name: 'Q4 Push', status: 'draft' })
console.log(campaign.id)

create.isPending    // boolean — in-flight
create.isError      // boolean
create.isSuccess    // boolean
create.error        // ORPCError | null
```

The argument type is `{Model}Write` — TypeScript will reject any field not in the controller's `permit` list.

### Update

```tsx
const update = ctrl.mutateUpdate()
update.mutate({ id: campaign.id, name: 'Updated Name', budget: 10000 })
// id is required; all other fields are optional (Partial<CampaignWrite>)
```

### Destroy

```tsx
const destroy = ctrl.mutateDestroy()
destroy.mutate(campaign.id)
```

### Custom Mutation — `@mutation`

```tsx
const launch = ctrl.mutateLaunch()
launch.mutate(campaign.id)

const archive = ctrl.mutateBulkArchive()
archive.mutate([id1, id2, id3])  // accepts an array of ids
```

### Mutation Options

Pass TanStack Query options when calling the hook:

```tsx
const create = ctrl.mutateCreate({
  onSuccess: (campaign) => {
    toast.success(`Created "${campaign.name}"`)
    router.push(`/campaigns/${campaign.id}`)
    queryClient.invalidateQueries({ queryKey: campaignKeys.lists() })
  },
  onError: (error) => {
    toast.error(parseControllerError(error)?.message ?? 'Something went wrong')
  },
})
```

---

## 8. Cache Management

Each controller's `{model}Keys` factory produces structured cache keys for targeted invalidation:

```ts
import { campaignKeys } from '../_generated'

campaignKeys.all(scopes)          // root — invalidates everything for this controller
campaignKeys.lists(scopes)        // all list queries (index)
campaignKeys.list(scopes, params) // specific list (exact params match)
campaignKeys.details(scopes)      // all detail queries (get)
campaignKeys.detail(id, scopes)   // specific record
campaignKeys.singleton(scopes)    // for @singleton controllers
```

### Invalidating After a Mutation

```tsx
const create = ctrl.mutateCreate({
  onSuccess: () => {
    // Invalidate all list queries — they'll refetch automatically
    queryClient.invalidateQueries({ queryKey: campaignKeys.lists({ teamId }) })
  },
})
```

### Prefetching

Prefetch on hover to make navigation feel instant:

```tsx
<div
  onMouseEnter={() => {
    queryClient.prefetchQuery({
      queryKey: campaignKeys.detail(campaign.id, { teamId }),
      queryFn: () => CampaignController.with({ teamId }).get(campaign.id),
    })
  }}
>
  <Link to={`/campaigns/${campaign.id}`}>{campaign.name}</Link>
</div>
```

---

## 9. Search State

The generated `use{Model}Search()` hook manages search/filter/sort state with URL sync:

```tsx
import { useCampaignSearch, CampaignController } from '../_generated'

function CampaignsPage({ teamId }: { teamId: number }) {
  const search = useCampaignSearch()
  const ctrl   = CampaignController.use({ teamId })

  const { data, isLoading } = ctrl.index(search.state)

  return (
    <div>
      <input
        value={search.state.q ?? ''}
        onChange={e => search.set({ q: e.target.value })}
        placeholder="Search campaigns..."
      />

      <select
        value={search.state.scopes?.[0] ?? 'active'}
        onChange={e => search.set({ scopes: [e.target.value] })}
      >
        <option value="active">Active</option>
        <option value="draft">Drafts</option>
        <option value="paused">Paused</option>
      </select>

      <select
        value={`${search.state.sort?.field}:${search.state.sort?.dir}`}
        onChange={e => {
          const [field, dir] = e.target.value.split(':')
          search.set({ sort: { field, dir: dir as 'asc' | 'desc' } })
        }}
      >
        <option value="createdAt:desc">Newest</option>
        <option value="name:asc">A–Z</option>
        <option value="budget:desc">Highest budget</option>
      </select>

      {data?.data.map(c => <CampaignRow key={c.id} campaign={c} />)}
    </div>
  )
}
```

`search.set(partial)` merges the update with the current state and resets `page` to `0` automatically (because a filter change should restart from the first page).

---

## 10. Form Integration (TanStack Form)

The generated `{model}FormConfig` object provides typed defaults and enum options for TanStack Form:

```tsx
import { useForm }             from '@tanstack/react-form'
import { campaignFormConfig, CampaignController } from '../_generated'
import { parseControllerError, applyFormErrors }  from '@active-drizzle/react'

function CreateCampaignDialog({ teamId, onSuccess }) {
  const create = CampaignController.use({ teamId }).mutateCreate()

  const form = useForm({
    ...campaignFormConfig,
    // campaignFormConfig provides:
    //   defaultValues: { name: '', status: 'draft', budget: null, ... }
    //   validators: { onChange: ..., onSubmit: ... }  (from @validate)
    onSubmit: async ({ value }) => {
      // value is typed as CampaignWrite — only permit-listed fields
      await create.mutateAsync(value)
      onSuccess()
    },
  })

  // Bind server validation errors after a failed submit
  const err = parseControllerError(create.error)
  if (err?.isValidation) applyFormErrors(form, err)

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name" children={(f) => (
        <div>
          <label>Name</label>
          <input
            value={f.state.value}
            onChange={e => f.handleChange(e.target.value)}
          />
          {f.state.meta.errors?.map(msg => (
            <span key={msg} className="text-red-500 text-sm">{msg}</span>
          ))}
        </div>
      )} />

      <form.Field name="status" children={(f) => (
        <select value={f.state.value} onChange={e => f.handleChange(e.target.value)}>
          {campaignFormConfig.enumOptions.status.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )} />

      <form.Field name="budget" children={(f) => (
        <input
          type="number"
          value={f.state.value ?? ''}
          onChange={e => f.handleChange(+e.target.value)}
        />
      )} />

      <button type="submit" disabled={create.isPending}>
        {create.isPending ? 'Creating...' : 'Create'}
      </button>
    </form>
  )
}
```

See [Form Integration](/react/forms) for the complete form guide including update forms, dirty state, and multi-step forms.

---

## 11. Error Handling

```tsx
import { parseControllerError, applyFormErrors } from '@active-drizzle/react'

const create = ctrl.mutateCreate()
const err    = parseControllerError(create.error)

// Generic error banner
if (err) return <ErrorBanner message={err.message} />

// Specific error types
if (err?.isNotFound)    return <Navigate to="/404" />
if (err?.isUnauthorized) return <Navigate to="/login" />
if (err?.isForbidden)   return <p>You don't have permission to do that.</p>

// Validation — bind to form fields
if (err?.isValidation && err.fields) {
  applyFormErrors(form, err)
  // Sets field.state.meta.errors for each field in the response
}
```

See [Error Handling](/react/error-handling) for the complete API reference.

---

## 12. Plain (Model-Free) Controllers

Controllers without `@crud` still get full `.use()` and `.with()` objects with their `@action` methods. This is the pattern for S3 presigned URLs, Clerk invitations, third-party integrations:

```ts
// UploadController.ctrl.ts
@controller('/uploads')
export class UploadController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  @action('POST', '/presign')
  async presign(input: { filename: string; contentType: string }) {
    const key = `uploads/${crypto.randomUUID()}/${input.filename}`
    const url = await getSignedUrl(s3, new PutObjectCommand({ ... }), { expiresIn: 600 })
    return { uploadUrl: url, key }
  }

  @action('GET')
  async storageUsage(): Promise<{ bytes: number; limitBytes: number }> {
    return getUsage(this.context.user.teamId)
  }
}
```

```tsx
function UploadButton({ teamId }) {
  const presign = UploadController.use({}).mutatePresign()
  const { data: usage } = UploadController.use({}).indexStorageUsage()

  const handleFile = async (file: File) => {
    const { uploadUrl, key } = await presign.mutateAsync({
      filename:    file.name,
      contentType: file.type,
    })
    await fetch(uploadUrl, { method: 'PUT', body: file })
  }

  return (
    <div>
      <p>{usage?.bytes} / {usage?.limitBytes} bytes used</p>
      <input type="file" onChange={e => handleFile(e.target.files![0])} />
    </div>
  )
}
```

---

## 13. Complete Component Example

A full page with search, infinite scroll, create, launch, and error handling:

```tsx
import {
  CampaignController, useCampaignSearch, campaignFormConfig,
} from '../_generated'
import { parseControllerError, applyFormErrors } from '@active-drizzle/react'
import { useForm } from '@tanstack/react-form'

function CampaignsPage({ teamId }: { teamId: number }) {
  const search = useCampaignSearch()
  const ctrl   = CampaignController.use({ teamId })

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    ctrl.infiniteIndex(search.state)

  const campaigns = data?.pages.flatMap(p => p.data) ?? []
  const create    = ctrl.mutateCreate()
  const launch    = ctrl.mutateLaunch()
  const destroy   = ctrl.mutateDestroy()

  return (
    <div>
      {/* Search bar */}
      <input
        value={search.state.q ?? ''}
        onChange={e => search.set({ q: e.target.value })}
        placeholder="Search campaigns..."
      />

      {/* List */}
      {campaigns.map(c => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          <span>{c.status}</span>    {/* 'draft' | 'active' | 'paused' */}
          {c.isDraft() && (
            <button onClick={() => launch.mutate(c.id)} disabled={launch.isPending}>
              Launch
            </button>
          )}
          <button onClick={() => destroy.mutate(c.id)}>Delete</button>
        </div>
      ))}

      {hasNextPage && (
        <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
          Load more
        </button>
      )}

      {/* Create form */}
      <CreateCampaignForm
        teamId={teamId}
        onSuccess={() => search.reset()}
      />
    </div>
  )
}

function CreateCampaignForm({ teamId, onSuccess }) {
  const create = CampaignController.use({ teamId }).mutateCreate()
  const err    = parseControllerError(create.error)

  const form = useForm({
    ...campaignFormConfig,
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value)
      onSuccess()
    },
  })

  if (err?.isValidation) applyFormErrors(form, err)

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name" children={(f) => (
        <input value={f.state.value} onChange={e => f.handleChange(e.target.value)} />
      )} />
      <button type="submit" disabled={create.isPending}>Create</button>
      {err && !err.isValidation && <p className="text-red-500">{err.message}</p>}
    </form>
  )
}
```

---

## What's Next

| Topic | Where to go |
|-------|-------------|
| ClientModel types and `TAttrs`/`TWrite` | [ClientModel & Type Safety](/react/client-model) |
| TanStack Form integration deep dive | [Form Integration](/react/forms) |
| Error handling reference | [Error Handling](/react/error-handling) |
| Controller configuration | [Controllers Overview](/controllers/overview) |
| Vite plugin setup | [Vite Plugin & CLI](/codegen/vite-plugin) |
