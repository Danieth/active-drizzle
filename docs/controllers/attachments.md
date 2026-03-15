# File Attachment Controllers

The `@attachable()` decorator adds three endpoints to any controller — `presign`, `confirm`, and `attach` — enabling the browser-to-S3 upload flow without touching your server's memory or disk.

---

## `@attachable()`

Add it to any `@crud` or `@singleton` controller:

```ts
import { controller, crud, scope, attachable, ActiveController } from '@active-drizzle/controller'
import { Campaign } from '../models/Campaign.model.js'

@controller()
@crud(Campaign, {
  create: { permit: ['name', 'budget', 'logo', 'documents'] },
  update: { permit: ['name', 'budget', 'logo', 'documents'] },
})
@scope('teamId')
@attachable()
export class CampaignController extends ActiveController<AppContext> {}
```

That's it. The decorator registers three procedures on the router:

| Procedure | Route | What it does |
|-----------|-------|--------------|
| `presign` | `POST /campaigns/presign` | Creates a pending `Asset`, returns a presigned S3 PUT URL |
| `confirm` | `POST /campaigns/confirm` | Verifies the upload landed in S3, marks asset as `'ready'` |
| `attach`  | `POST /campaigns/attach`  | Connects a ready asset to a record by slot name |

---

## `presign` procedure

The client sends the filename, content type, and the attachment slot name:

```ts
const result = await client.campaigns.presign({
  teamId:      1,
  filename:    'logo.png',
  contentType: 'image/png',
  name:        'logo',         // matches hasOneAttachment('logo') on the model
})

// result.asset      → { id, key, filename, status: 'pending', ... }
// result.uploadUrl  → presigned S3 PUT URL (valid 15 minutes)
// result.constraints → { accepts, maxSize, access }
```

The server:
1. Looks up the `hasOneAttachment` / `hasManyAttachments` declaration on the model
2. Validates the content type against `accepts`
3. Creates a pending `Asset` row in the database
4. Returns a presigned PUT URL with `Content-Type` baked into the signature

> The presigned URL is only valid for 15 minutes. If validation fails (wrong MIME type), a `400 Bad Request` is thrown before any S3 call.

---

## `confirm` procedure

After the browser has PUT the file to S3, call `confirm` to mark it ready:

```ts
const asset = await client.campaigns.confirm({
  teamId:  1,
  assetId: result.asset.id,
})

// asset.status === 'ready'
// asset.byteSize is populated from the HeadObject response
// asset.checksum is the S3 ETag
```

The server calls `HeadObject` on the S3 key. If the object doesn't exist (upload failed or was tampered), `confirm` returns a storage error. If it exists, `byteSize`, `checksum`, and `status: 'ready'` are set.

---

## `attach` procedure

Connects a ready asset to a specific record:

```ts
await client.campaigns.attach({
  teamId:       1,
  attachableId: 42,         // the Campaign's id
  assetId:      asset.id,
  name:         'logo',     // the attachment slot name
})
```

In practice, you rarely call `attach` directly — the generated `useUpload` hook calls it automatically. It's exposed for cases where you upload outside of a form (e.g. gallery, drag-and-drop).

---

## `autoSet` — scoping assets to users/organisations

Use `autoSet` to stamp uploaded assets with context values (user ID, organisation ID, etc.). This is how you associate assets with the current user without exposing that logic to the client:

```ts
@attachable({
  autoSet: {
    uploadedById: (ctx) => ctx.user.id,
    orgId:        (ctx) => ctx.orgId,
  },
})
export class CampaignController extends ActiveController<AppContext> {}
```

Your `active_drizzle_assets` table needs the corresponding columns. The fields are set on the `Asset` row created during `presign`, before the upload happens.

---

## Auto-attach on Create/Update

When attachment names appear in a controller's `permit` list, the CRUD handlers automatically call `attach()` / `detach()` after saving — no manual wiring needed.

### `hasOneAttachment` — `logoAssetId`

Include the attachment slot name in `permit`:

```ts
@crud(Campaign, {
  create: { permit: ['name', 'budget', 'logo'] },
})
```

The client submits `logoAssetId: 42` alongside the other fields. After `Campaign.create()` succeeds, the controller calls `record.attach('logo', 42)` automatically.

```ts
// Client:
create.mutate({ name: 'Q4', budget: 5000, logoAssetId: 42 })

// Server auto-runs:
await campaign.replace('logo', 42)
```

To explicitly detach (clear the logo), submit `logoAssetId: null`.

### `hasManyAttachments` — `documentsAssetIds`

```ts
@crud(Campaign, {
  create: { permit: ['name', 'documents'] },
})
```

Submit `documentsAssetIds: [1, 2, 3]`. The controller detaches all existing attachments and re-attaches in the submitted order.

```ts
// Client:
create.mutate({ name: 'Q4', documentsAssetIds: [1, 2, 3] })

// Server auto-runs:
await campaign.detach('documents')
await campaign.attach('documents', 1)
await campaign.attach('documents', 2)
await campaign.attach('documents', 3)
```

---

## Before Hooks

`@before` hooks work on attachment procedures the same as any other action:

```ts
@attachable()
export class CampaignController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  @before({ only: ['presign', 'confirm', 'attach'] })
  async requireActivePlan() {
    if (!this.context.org.hasActivePlan) throw new Forbidden('Upgrade to upload files')
  }
}
```

---

## Generated Types

`CampaignWrite` includes `logoAssetId` / `documentsAssetIds` automatically when those attachment names are in the permit list:

```ts
// From CampaignController.gen.ts (auto-generated, do not edit)
export type CampaignWrite = Pick<CampaignAttrs, 'name' | 'budget'> & {
  logoAssetId?:      number
  documentsAssetIds?: number[]
}
```

The `campaignAttachments` constant carries the constraints for client-side validation:

```ts
export const campaignAttachments = {
  logo: {
    kind:     'one',
    accepts:  'image/*',
    maxSize:  5242880,
    access:   'public',
  },
  documents: {
    kind:     'many',
    accepts:  'application/pdf',
    maxSize:  20971520,
    max:      10,
    access:   'private',
  },
} as const
```
