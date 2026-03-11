# React Query Integration

`@active-drizzle/react` is a pure React Query data layer — no UI components, no design system opinions. The Vite plugin generates a typed controller object per controller file, plus a barrel index and a one-time client wiring stub.

## Installation

```bash
npm install @active-drizzle/react @tanstack/react-query
```

## What Gets Generated

For every controller file, codegen emits a `{controller}.gen.ts` with:

| Export | What it is |
|--------|-----------|
| `{Model}Attrs` | Full read shape — columns + eager-loaded associations |
| `{Model}Write` | Write shape — only `permit`-listed fields |
| `{Model}Client` | Immutable `ClientModel` subclass with enum predicates |
| `{Model}SearchState` | Search/filter state interface |
| `{model}Keys` | Scoped cache key factory |
| `{ControllerName}` | The controller object with `.use()` and `.with()` |

Plus two shared files:

| File | What it is |
|------|-----------|
| `_generated/index.ts` | Barrel re-exporting all controllers (always regenerated) |
| `_generated/_client.ts` | oRPC client wiring stub (written once, never overwritten) |

## The Two Access Patterns

Every controller exports an object with two methods:

```typescript
import { CampaignController, UploadController } from '../_generated'

// .use(scopes) — call inside React components, returns hook results directly
const ctrl = CampaignController.use({ teamId })

// Queries
const { data }     = ctrl.index(search.state)     // useQuery   — collection
const { data: pg } = ctrl.infiniteIndex(params)   // useInfiniteQuery — infinite scroll
const { data: c }  = ctrl.get(id)                 // useQuery   — single record
const { data: st } = ctrl.indexStats()            // useQuery   — @action('GET') stats
const { data: kp } = ctrl.indexKeypoints()        // useQuery   — @action('GET') keypoints

// Mutations (all prefixed with 'mutate')
const create     = ctrl.mutateCreate()            // useMutation — create
const update     = ctrl.mutateUpdate()            // useMutation — update
const destroy    = ctrl.mutateDestroy()           // useMutation — destroy
const launch     = ctrl.mutateLaunch()            // useMutation — @mutation launch
const archive    = ctrl.mutateBulkArchive()       // useMutation — @mutation({ bulk: true }) archive
const recalc     = ctrl.mutateRecalculate()       // useMutation — @action('POST') recalculate

// .with(scopes) — direct async calls outside React (same names, same types)
const result = await CampaignController.with({ teamId }).mutateCreate({ name: 'New' })
const url    = await UploadController.with({}).mutateGetUploadUrl({ filename: 'img.png', contentType: 'image/png' })
```

**Destructure once** — `CampaignController.use({ teamId })` returns a plain object (no hooks inside). The hook calls happen when you call `.index()`, `.create()` etc. on the returned object.

## CRUD Controller

```typescript
// src/pages/campaigns.tsx
import { CampaignController } from '../_generated'

function CampaignsPage({ teamId }: { teamId: number }) {
  const ctrl = CampaignController.use({ teamId })

  const { data, isLoading } = ctrl.index({ scopes: ['active'], sort: { field: 'createdAt', dir: 'desc' } })
  const create = ctrl.mutateCreate()
  const launch = ctrl.mutateLaunch()  // @mutation

  return (
    <div>
      {data?.items.map(c => (
        <div key={c.id}>
          <h3>{c.name}</h3>
          {/* c.status is 'draft' | 'active' | 'paused' | 'completed' */}
          {c.statusIsActive() && <span>Live</span>}
          {/* c.creator is typed as UserAttrs from include: ['creator'] */}
          <span>by {c.creator?.name}</span>

          {c.statusIsDraft() && (
          <button onClick={() => launch.mutate(c.id)}>Launch</button>
          )}
        </div>
      ))}

      <button
        onClick={() => create.mutate({ name: 'New Campaign', status: 'draft' })}
        disabled={create.isPending}
      >
        New Campaign
      </button>
    </div>
  )
}
```

## Plain (Model-Free) Controller

Plain controllers have no CRUD — only `@action` methods. They still get `.use()` and `.with()`, and all `@before`/`@after` hooks apply. This is the right pattern for S3 uploads, Clerk invites, background job triggers, etc.

```typescript
// src/controllers/Upload.ctrl.ts
@controller('/upload')
export class UploadController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  @action('POST', '/presign')
  async getUploadUrl(input: { filename: string; contentType: string }) {
    const key = `uploads/${crypto.randomUUID()}/${input.filename}`
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }), { expiresIn: 600 })
    return { uploadUrl, key, publicUrl: `https://cdn.example.com/${key}` }
  }
}
```

Generated usage:

```typescript
import { UploadController } from '../_generated'

function UploadButton() {
  const upload = UploadController.use({}).mutateGetUploadUrl()  // useMutation (@action POST /presign)

  const handleFile = async (file: File) => {
    const { uploadUrl, key } = await upload.mutateAsync({
      filename: file.name,
      contentType: file.type,
    })
    await fetch(uploadUrl, { method: 'PUT', body: file })
    // then create the asset record...
  }

  return <input type="file" onChange={e => handleFile(e.target.files![0])} />
}

// Or outside React entirely:
const { uploadUrl } = await UploadController.with({}).mutateGetUploadUrl({
  filename: 'report.pdf',
  contentType: 'application/pdf',
})
```

## Form Integration (TanStack Form)

```tsx
import { useForm } from '@tanstack/react-form'
import { campaignFormConfig, CampaignController } from '../_generated'

function CreateCampaignForm({ teamId, onSuccess }) {
  const create = CampaignController.with({ teamId }).mutateCreate  // direct call

  const form = useForm({
    ...campaignFormConfig,
    onSubmit: async ({ value }) => {
      // value is typed as CampaignWrite — permit-listed fields only
      await create(value)
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
      <button type="submit">Create</button>
    </form>
  )
}
```

## Wiring the oRPC Client (one time)

Edit `_generated/_client.ts` once. Every generated file imports from it automatically:

```typescript
// _generated/_client.ts
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { AppRouter } from '../server/_routes.gen'

export const client = createORPCClient<AppRouter>(
  new RPCLink({ url: '/api/rpc' })
)
```

The `AppRouter` type comes from `_routes.gen.ts` — generated alongside your controllers. The client is fully typed end-to-end from controller → procedure → hook.
