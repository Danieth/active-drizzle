# Storage & File Attachments

ActiveDrizzle has a first-class file attachment system built on S3-compatible object storage. One call to `configureStorage()` at boot is all the configuration you need — the framework handles presigned URL generation, upload verification, key management, and React hooks from there.

Supports **AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, Backblaze B2**, and any S3-compatible provider.

---

## 1. Install the AWS SDK

The S3 SDK is an optional peer dependency. Install it in your server package:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

---

## 2. Configure Storage

Call `configureStorage()` once at server startup, before handling any requests:

```ts
// src/server.ts
import { configureStorage } from '@active-drizzle/core'

configureStorage({
  bucket:          process.env.S3_BUCKET!,
  region:          process.env.S3_REGION!,
  accessKeyId:     process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
})
```

### S3-Compatible Providers

Pass `endpoint` for any non-AWS provider:

```ts
// Cloudflare R2
configureStorage({
  bucket:          'my-bucket',
  region:          'auto',
  accessKeyId:     process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  endpoint:        `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  publicUrlBase:   'https://cdn.example.com',   // your R2 custom domain
})

// MinIO (self-hosted)
configureStorage({
  bucket:    'uploads',
  region:    'us-east-1',
  accessKeyId: 'minio',
  secretAccessKey: 'minio123',
  endpoint:  'http://localhost:9000',
})
```

### Full Config Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `bucket` | `string` | required | S3 bucket name |
| `region` | `string` | required | AWS region (use `'auto'` for R2) |
| `accessKeyId` | `string` | required | Access key ID |
| `secretAccessKey` | `string` | required | Secret access key |
| `endpoint` | `string` | — | Override for S3-compatible providers |
| `publicUrlBase` | `string` | — | CDN domain for public asset URLs (e.g. `https://cdn.example.com`) |
| `privateUrlExpiry` | `number` | `3600` | Expiry in seconds for presigned GET URLs on private assets |
| `defaultMaxSize` | `number` | `104857600` | Global max upload size in bytes (100MB). Overridable per attachment. |

---

## 3. Run Migrations

ActiveDrizzle needs two tables: `active_drizzle_assets` (file metadata) and `active_drizzle_attachments` (the polymorphic join). Add them to your schema:

```ts
// db/schema.ts
import {
  pgTable, serial, text, integer, varchar,
  timestamp, jsonb
} from 'drizzle-orm/pg-core'

export const active_drizzle_assets = pgTable('active_drizzle_assets', {
  id:          serial('id').primaryKey(),
  key:         text('key').notNull().unique(),
  filename:    varchar('filename', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  byteSize:    integer('byte_size'),
  checksum:    varchar('checksum', { length: 255 }),
  status:      varchar('status', { length: 50 }).notNull().default('pending'),
  access:      varchar('access', { length: 50 }).notNull().default('private'),
  metadata:    jsonb('metadata').notNull().default({}),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
  updatedAt:   timestamp('updated_at').defaultNow().notNull(),
})

export const active_drizzle_attachments = pgTable('active_drizzle_attachments', {
  id:             serial('id').primaryKey(),
  assetId:        integer('asset_id').notNull().references(() => active_drizzle_assets.id),
  attachableType: varchar('attachable_type', { length: 255 }).notNull(),
  attachableId:   integer('attachable_id').notNull(),
  name:           varchar('name', { length: 255 }).notNull(),
  position:       integer('position').notNull().default(0),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
})
```

Then run `npx drizzle-kit generate` and `npx drizzle-kit migrate` as normal.

---

## 4. How Uploads Work

The upload flow is a three-step handshake entirely handled by the generated hooks:

```
1. presign   →  POST /campaigns/presign
               Creates a pending Asset row, returns a presigned S3 PUT URL

2. PUT       →  Direct browser → S3 (bypasses your server entirely)
               Content-Type is enforced by the S3 signature

3. confirm   →  POST /campaigns/confirm
               Verifies the upload landed in S3, marks Asset as 'ready'
```

After confirmation, `attach` connects the ready Asset to a record. When using `useUpload` / `useMultiUpload`, all three steps happen automatically.

---

## 5. Environment Variables

```bash
# .env
S3_BUCKET=my-app-uploads
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Optional CDN
CDN_URL=https://cdn.example.com
```

---

## 6. Orphan Cleanup (optional)

Pending assets that were never confirmed (user abandoned mid-upload) accumulate over time. Run the cleanup task periodically:

```ts
import { runAssetCleanup } from '@active-drizzle/core'

// Runs as a cron job or startup task
// Removes pending assets older than 24 hours (default) and deletes from S3
await runAssetCleanup()

// Custom max age
await runAssetCleanup({ olderThanMs: 6 * 60 * 60 * 1000 }) // 6 hours
```

---

## 7. Server-side Uploads (AssetService)

To upload files programmatically from your backend (e.g. importing existing files, processing webhooks):

```ts
import { AssetService } from '@active-drizzle/core'

const asset = await AssetService.createFromService({
  filename:    'report.pdf',
  contentType: 'application/pdf',
  buffer:      pdfBuffer,     // Buffer | Uint8Array
  access:      'private',
})

// asset.id is ready to attach to a record
await campaign.attach('documents', asset.id)
```
