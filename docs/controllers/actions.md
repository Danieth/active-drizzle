# Actions & Custom Endpoints

`@action` covers everything that isn't a standard CRUD operation — collection analytics, bulk imports, third-party integrations, presigned URLs, background job triggers. These are the endpoints that don't fit neatly into create/update/destroy but still deserve the full controller lifecycle: `@before` hooks, `@rescue` handlers, scoped relations, and typed client generation.

---

## Overview

| Decorator | Record loaded? | Typical use |
|-----------|---------------|-------------|
| `@mutation()` | Yes — by `:id` | Single-record state change (`launch`, `publish`, `approve`) |
| `@mutation({ bulk: true })` | Yes — by `ids[]` | Multi-record operations (`archive`, `tag`, `assign`) |
| `@action('GET')` | No | Collection analytics, stats, search suggestions |
| `@action('POST')` | No | Imports, recalculations, background jobs |
| `@action('GET', path, { load: true })` | Yes — by `:id` | Per-record computed data, derived views |
| `@action('POST', path, { load: true })` | Yes — by `:id` | Complex per-record mutations that need full control |

---

## Collection Actions (no record loading)

```typescript
import { action } from '@active-drizzle/controller'

@controller('/campaigns')
@crud(Campaign, { /* ... */ })
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {

  // GET /campaigns/stats
  @action('GET')
  async stats(): Promise<{ totalBudget: number; activeCount: number; draftCount: number }> {
    const rel = this.relation  // already scoped to teamId by @scope
    const [totalBudget, activeCount, draftCount] = await Promise.all([
      rel.sum('budget'),
      rel.active().count(),
      rel.where({ status: 0 }).count(),
    ])
    return { totalBudget, activeCount, draftCount }
  }

  // POST /campaigns/recalculate
  @action('POST')
  async recalculate(input: { fieldset: 'budget' | 'all' }) {
    await recalculateAllCampaigns(this.relation, input.fieldset)
    return { ok: true }
  }
}
```

On the frontend:
```typescript
const ctrl = CampaignController.use({ teamId })

// @action('GET') → prefixed with 'index' (useQuery)
const { data: stats } = ctrl.indexStats()

// @action('POST') → prefixed with 'mutate' (useMutation)
const recalc = ctrl.mutateRecalculate()
recalc.mutate({ fieldset: 'all' })
```

---

## Record-Level Actions (`{ load: true }`)

Pass `{ load: true }` as the third argument to automatically load the record by `:id` from the scoped relation. The loaded record is passed as the first argument, and is also available as `this.record` in any `@before` hooks that apply to the action.

```typescript
// GET /campaigns/:id/score
@action('GET', undefined, { load: true })
async score(record: Campaign): Promise<{ score: number; breakdown: string[] }> {
  return computeScore(record)
}

// POST /campaigns/:id/duplicate
@action('POST', undefined, { load: true })
async duplicate(record: Campaign) {
  return Campaign.create({
    ...record.attributes,
    name: `${record.name} (copy)`,
    status: 'draft',
  })
}

// POST /campaigns/:id/assign
@action('POST', undefined, { load: true })
async assign(record: Campaign, input: { userId: number }) {
  record.assignedUserId = input.userId
  return record.save()
}
```

Ownership check via `@before` — the record is already loaded when hooks run:

```typescript
@before({ only: ['score', 'duplicate', 'assign'] })
async ensureOwner() {
  if (this.record.teamId !== this.context.teamId) throw new Forbidden('Wrong team')
}
```

On the frontend, `load: true` actions take an `id`:
```typescript
// @action('GET', ..., { load: true }) → indexScore(id) — useQuery
const { data: scoreData } = ctrl.indexScore(campaignId)

// @action('POST', ..., { load: true }) → mutateAssign() — useMutation
const assign = ctrl.mutateAssign()
assign.mutate({ id: campaignId, userId: 5 })
```

---

## Plain Controllers (No CRUD Model)

For endpoints with no associated model — S3 presigned URLs, Clerk invitations, background job triggers — use `@action` on a plain controller (no `@crud`):

```typescript
@controller('/uploads')
export class UploadController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  // POST /uploads/presign
  @action('POST', '/presign')
  async presign(input: { filename: string; contentType: string }) {
    const key = `uploads/${crypto.randomUUID()}/${input.filename}`
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: input.contentType,
    }), { expiresIn: 600 })
    return { uploadUrl, key, publicUrl: `https://cdn.example.com/${key}` }
  }

  // GET /uploads/storage-usage
  @action('GET')
  async storageUsage(): Promise<{ bytes: number; limit: number }> {
    return getStorageUsage(this.context.user.teamId)
  }
}
```

Frontend:
```typescript
// POST → mutate prefix
const presign = UploadController.use({}).mutatePresign()

// GET → index prefix
const { data: usage } = UploadController.use({}).indexStorageUsage()

// Or outside React with .with():
const { uploadUrl, key } = await UploadController.with({}).mutatePresign({
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
})
```

---

## Naming Conventions (Generated Frontend)

The generated frontend method names follow deterministic rules so autocomplete always shows the full picture:

| Backend | HTTP | `load` | Generated `.use()` name | Hook type |
|---------|------|--------|--------------------------|-----------|
| `stats` | GET | — | `indexStats()` | `useQuery` |
| `indexKeypoints` | GET | — | `indexKeypoints()` | `useQuery` — no double-prefix |
| `getSummary` | GET | — | `getSummary()` | `useQuery` — already starts with `get` |
| `score` | GET | true | `indexScore(id)` | `useQuery` |
| `recalculate` | POST | — | `mutateRecalculate()` | `useMutation` |
| `presign` | POST | — | `mutatePresign()` | `useMutation` |
| `assign` | POST | true | `mutateAssign()` | `useMutation` — `{ id, ...data }` |

The `.with()` object uses the exact same names as direct async functions — no learning overhead.

---

## Context, Params, and Relation

Every `@action` (and `@mutation`) has access to:

```typescript
@action('POST')
async myAction(input: { foo: string }) {
  this.context    // AppContext — user, auth, team, etc.
  this.params     // full input object (same as `input` arg for @action)
  this.input      // alias for this.params
  this.relation   // scoped Relation for @crud controllers (null for plain)
  this.record     // loaded record (only when load: true or @mutation)
}
```

Use `this.relation` on CRUD controllers to build queries that respect the `@scope` chain — it's already filtered by all URL scope params (e.g., `teamId`). Never call `Model.all()` directly inside a controller; use `this.relation`.

---

## Error Handling in Actions

All error handling works identically to regular CRUD actions. See [Error Handling](/controllers/error-handling) for `@rescue`, `parseControllerError`, and the frontend integration patterns.

Quick recap:

```typescript
// Throw from action body
@action('POST')
async batchImport(input: { rows: any[] }) {
  if (input.rows.length > 1000) throw new BadRequest('Max 1000 rows per import')
  // RecordNotFound thrown inside is auto-rescued to 404
}

// @rescue handles third-party errors
@rescue(ExternalApiError)
async handleExternalError(e: ExternalApiError) {
  throw new BadRequest(`External API failed: ${e.message}`)
}
```
