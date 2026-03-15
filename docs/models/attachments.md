# File Attachments

Models declare file attachments as static properties — the same pattern as `belongsTo` and `hasMany`.

```ts
import { hasOneAttachment, hasManyAttachments } from '@active-drizzle/core'

@model('campaigns')
export class Campaign extends ApplicationRecord {
  // One logo — must be an image, public CDN URL
  static logo = hasOneAttachment('logo', {
    accepts:  'image/*',
    maxSize:  5 * 1024 * 1024,   // 5MB
    access:   'public',
  })

  // Many documents — up to 10, private presigned URLs
  static documents = hasManyAttachments('documents', {
    accepts:  'application/pdf',
    maxSize:  20 * 1024 * 1024,  // 20MB
    max:      10,
    access:   'private',
  })
}
```

---

## `hasOneAttachment(name, options?)`

Declares a single file slot. At most one asset is attached at a time — attaching a new one automatically replaces the previous one.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `accepts` | `string` | — | MIME filter: `'image/*'`, `'audio/*'`, `'application/pdf'`, `'*/*'` |
| `maxSize` | `number` | `configureStorage().defaultMaxSize` | Max file size in bytes |
| `access` | `'public' \| 'private'` | `'private'` | Controls `asset.url` resolution and S3 object ACL |

```ts
static avatar = hasOneAttachment('avatar', {
  accepts: 'image/*',
  maxSize: 2 * 1024 * 1024,
  access:  'public',
})

static resume = hasOneAttachment('resume', {
  accepts: 'application/pdf',
  access:  'private',    // default
})
```

---

## `hasManyAttachments(name, options?)`

Declares an ordered list of file attachments.

### Options

All options from `hasOneAttachment`, plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max` | `number` | — | Maximum number of attachments. Enforced by `attach()`. |

```ts
static images = hasManyAttachments('images', {
  accepts:  'image/*',
  maxSize:  10 * 1024 * 1024,
  max:      20,
  access:   'public',
})
```

---

## Access: `public` vs `private`

`access` determines how `asset.url` is resolved:

| Value | `asset.resolveUrl()` returns | Use when |
|-------|------------------------------|----------|
| `'public'` | Direct CDN/S3 URL (permanent, cacheable) | Profile photos, product images, public docs |
| `'private'` (default) | Presigned GET URL (expires per `privateUrlExpiry`) | Invoices, contracts, user uploads |

```ts
// In a controller or serializer:
const campaign = await Campaign.find(1)

// Public asset — synchronous URL
const url = campaign.logo?.url

// Private asset — must await
const url = await campaign.resume?.resolveUrl()
```

> **Note**: `asset.url` throws if called on a private asset. Use `await asset.resolveUrl()` for any asset regardless of access level.

---

## Runtime Methods

These are available on any `ApplicationRecord` instance after declaring attachments:

### `.attach(name, assetId)`

Connects a confirmed `Asset` to this record. For `hasOneAttachment`, replaces the existing attachment.

```ts
await campaign.attach('logo', asset.id)
await campaign.attach('documents', doc.id)
```

### `.detach(name, assetId?)`

Removes attachment(s). For `hasManyAttachments`, pass `assetId` to remove one specific asset, or omit to remove all.

```ts
await campaign.detach('logo')              // remove the single logo
await campaign.detach('documents')         // remove all documents
await campaign.detach('documents', doc.id) // remove one specific document
```

### `.replace(name, assetId)`

Atomic detach + attach wrapped in a transaction. Equivalent to `detach` then `attach`.

```ts
await campaign.replace('logo', newLogo.id)
```

### `.reorder(name, orderedAssetIds)`

Updates the `position` column on the attachment join rows, enabling ordered display.

```ts
await campaign.reorder('images', [id3, id1, id2])
```

---

## Accessing Attached Assets

Attachments are accessed via the proxy, just like associations. They are either pre-loaded via `includes` or lazily loaded:

```ts
// Eager load — single query
const campaign = await Campaign
  .includes('logo', 'documents')
  .where({ id })
  .first()

// campaign.logo is an Asset instance (or null)
// campaign.documents is an array of Asset instances

// Lazy load (additional query per access)
const logo = await campaign.logo        // Promise<Asset | null>
const docs = await campaign.documents   // Promise<Asset[]>
```

### Auto-attach via `permit`

When `logo` is in the `permit` list and the controller is decorated with `@attachable()`, submitting `logoAssetId` in a create/update request automatically calls `attach()`:

```ts
// Client sends:
{ name: 'Q4 Campaign', logoAssetId: 42 }

// Server auto-attaches asset 42 to the new record's 'logo' slot
```

No manual `attach()` call needed in your controller.

---

## The `Asset` Model

Every uploaded file creates an `Asset` record. Key properties:

```ts
asset.id           // number — use this as the foreign key
asset.filename     // 'photo.jpg'
asset.contentType  // 'image/jpeg'
asset.byteSize     // number | null (set after confirm)
asset.status       // 'pending' | 'ready'
asset.access       // 'public' | 'private'
asset.key          // 'uploads/{uuid}/photo.jpg' (S3 object key)

// Content type predicates
asset.isImage      // true if image/*
asset.isVideo      // true if video/*
asset.isAudio      // true if audio/*
asset.isPdf        // true if application/pdf
asset.isReady      // true if status === 'ready'

// URL resolution
asset.url          // string — public assets only (throws for private)
await asset.resolveUrl()  // string — works for both public and private
```
