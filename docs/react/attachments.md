# File Upload Hooks

The Vite plugin generates `useUpload` and `useMultiUpload` hooks for every `@attachable` controller. They handle the full three-step upload lifecycle — presign, XHR to S3, confirm — with instant previews, progress tracking, validation, and cancellation.

---

## What Gets Generated

For a `CampaignController` decorated with `@attachable()` and a `Campaign` model that declares:

```ts
static logo      = hasOneAttachment('logo',      { accepts: 'image/*', maxSize: 5_000_000, access: 'public' })
static documents = hasManyAttachments('documents', { accepts: 'application/pdf', max: 10 })
```

The generator emits:

```ts
// CampaignController.gen.ts (excerpt)
export const campaignAttachments = {
  logo:      { kind: 'one',  accepts: 'image/*',        maxSize: 5000000,  access: 'public'  },
  documents: { kind: 'many', accepts: 'application/pdf', max: 10,           access: 'private' },
} as const

// Inside CampaignController.use({ teamId }):
ctrl.useUpload('logo')             // → UseUploadReturn
ctrl.useMultiUpload('documents')   // → UseMultiUploadReturn
```

The Write type is also expanded:

```ts
export type CampaignWrite = {
  name:              string
  budget?:           number
  logoAssetId?:      number       // ← added by generator
  documentsAssetIds?: number[]    // ← added by generator
}
```

---

## `ctrl.useUpload(name, options?)`

For `hasOneAttachment` slots. Manages the lifecycle of a single file upload.

### Returned object

| Property | Type | Description |
|----------|------|-------------|
| `status` | `UploadStatus` | `'idle' \| 'validating' \| 'presigning' \| 'uploading' \| 'confirming' \| 'ready' \| 'error'` |
| `progress` | `number` | 0–100, updated via `xhr.upload.onprogress` |
| `loaded` | `number` | Bytes uploaded so far |
| `total` | `number` | Total file size in bytes |
| `file` | `UploadFileInfo \| null` | `{ name, size, type, previewUrl }` |
| `asset` | `AssetData \| null` | Populated after `confirm` succeeds |
| `assetId` | `number \| null` | `asset.id` — ready to submit in a form |
| `error` | `string \| null` | Human-readable error message |
| `upload(file)` | `(file: File) => Promise<AssetData>` | Starts the upload |
| `reset()` | `() => void` | Clears state, revokes preview URL |

### Options

| Option | Type | Description |
|--------|------|-------------|
| `initialAsset` | `AssetData` | Pre-populate an already-uploaded asset (for edit forms) |
| `onReady` | `(asset: AssetData) => void` | Called when confirm completes |

### Basic example

```tsx
import { CampaignController } from '../_generated'

function CampaignLogoField({ teamId, campaignId, initialAsset, onChange }) {
  const ctrl  = CampaignController.use({ teamId })
  const upload = ctrl.useUpload('logo', {
    initialAsset,
    onReady: (asset) => onChange(asset.id),
  })

  return (
    <div>
      {upload.file?.previewUrl && (
        <img src={upload.file.previewUrl} alt="Logo preview" width={80} />
      )}

      <input
        type="file"
        accept="image/*"
        onChange={e => upload.upload(e.target.files![0])}
        disabled={upload.status === 'uploading'}
      />

      {upload.status === 'uploading' && (
        <progress value={upload.progress} max={100} />
      )}

      {upload.error && <p className="text-red-500">{upload.error}</p>}
    </div>
  )
}
```

### Using in a TanStack Form

`assetId` is ready to include in `form.handleSubmit`:

```tsx
function CreateCampaignForm({ teamId }) {
  const ctrl   = CampaignController.use({ teamId })
  const create = ctrl.mutateCreate()
  const upload = ctrl.useUpload('logo')

  const form = useForm({
    ...campaignFormConfig,
    onSubmit: async ({ value }) => {
      await create.mutateAsync({
        ...value,
        logoAssetId: upload.assetId ?? undefined,
      })
    },
  })

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name">{(f) =>
        <input value={f.state.value} onChange={e => f.handleChange(e.target.value)} />
      }</form.Field>

      <input
        type="file"
        accept="image/*"
        onChange={e => upload.upload(e.target.files![0])}
      />
      {upload.status === 'uploading' && <progress value={upload.progress} max={100} />}
      {upload.error && <p>{upload.error}</p>}

      <button type="submit" disabled={create.isPending}>Save</button>
    </form>
  )
}
```

---

## `ctrl.useMultiUpload(name, options?)`

For `hasManyAttachments` slots. Manages concurrent uploads with reordering.

### Returned object

| Property | Type | Description |
|----------|------|-------------|
| `uploads` | `MultiUploadSlot[]` | One entry per file — each has `fileId`, `status`, `progress`, `file`, `asset`, `error` |
| `uploadFiles(files)` | `(files: File[]) => Promise<AssetData[]>` | Add and upload multiple files (respects `maxConcurrent`) |
| `removeFile(fileId)` | `(id: string) => void` | Cancel and remove one upload |
| `reorder(fileIds)` | `(ids: string[]) => void` | Reorder the slot list by fileId |
| `reset()` | `() => void` | Clear all slots, abort in-flight XHRs |
| `isUploading` | `boolean` | True while any slot is not idle/ready/error |
| `readyAssets` | `AssetData[]` | Assets that have been confirmed |
| `readyAssetIds` | `number[]` | `readyAssets.map(a => a.id)` — ready to submit |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `initialAssets` | `AssetData[]` | `[]` | Pre-populate from existing attachments (edit forms) |
| `maxConcurrent` | `number` | `3` | Maximum simultaneous XHR uploads |
| `onReady` | `(assets: AssetData[]) => void` | — | Called whenever the list of ready assets changes |
| `onFileReady` | `(asset: AssetData) => void` | — | Called each time a single upload completes |

### Basic example

```tsx
function DocumentUploader({ teamId }) {
  const ctrl    = CampaignController.use({ teamId })
  const multi   = ctrl.useMultiUpload('documents', {
    onFileReady: (a) => console.log('Ready:', a.filename),
  })

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      multi.uploadFiles(Array.from(e.target.files))
    }
  }

  return (
    <div>
      <input type="file" multiple accept="application/pdf" onChange={handleChange} />

      {multi.uploads.map(slot => (
        <div key={slot.fileId}>
          <span>{slot.file?.name ?? 'Uploading...'}</span>
          {slot.status === 'uploading' && (
            <progress value={slot.progress} max={100} />
          )}
          {slot.status === 'ready' && <span>✓</span>}
          {slot.error && <span className="text-red-500">{slot.error}</span>}
          <button onClick={() => multi.removeFile(slot.fileId)}>Remove</button>
        </div>
      ))}
    </div>
  )
}
```

### Drag-and-drop with reordering

```tsx
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext }           from '@dnd-kit/sortable'

function SortableGallery({ teamId }) {
  const ctrl  = CampaignController.use({ teamId })
  const multi = ctrl.useMultiUpload('images')

  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const ids    = multi.uploads.map(s => s.fileId)
    const from   = ids.indexOf(active.id as string)
    const to     = ids.indexOf(over.id as string)
    const reordered = [...ids]
    reordered.splice(from, 1)
    reordered.splice(to, 0, active.id as string)
    multi.reorder(reordered)
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={multi.uploads.map(s => s.fileId)}>
        {multi.uploads.map(slot => (
          <SortableItem key={slot.fileId} id={slot.fileId} slot={slot} />
        ))}
      </SortableContext>
    </DndContext>
  )
}
```

---

## Validation Errors

Both hooks validate client-side **before** calling `presign`:

- **Wrong MIME type** — checked against the `accepts` constraint from the model declaration
- **File too large** — checked against `maxSize`

If validation fails, `status` becomes `'error'` and `error` contains a human-readable message. No server call is made.

```ts
// If the model declares: accepts: 'image/*', maxSize: 5_000_000
upload.upload(videoFile)
// → status: 'error'
// → error: "File type 'video/mp4' is not accepted. Accepted: image/*"
```

---

## Upload Status Reference

| Status | Description |
|--------|-------------|
| `'idle'` | No upload started |
| `'validating'` | Running client-side MIME / size checks |
| `'presigning'` | Calling `POST /presign` on your server |
| `'uploading'` | Streaming file to S3 via XHR (`progress` updates here) |
| `'confirming'` | Calling `POST /confirm` to verify and mark ready |
| `'ready'` | Upload complete — `asset` and `assetId` are populated |
| `'error'` | Any step failed — `error` has details |

---

## Edit Forms (pre-populated uploads)

Pass `initialAsset` / `initialAssets` to pre-populate state from an existing record:

```tsx
function EditCampaignForm({ campaign, teamId }) {
  const ctrl   = CampaignController.use({ teamId })
  const upload = ctrl.useUpload('logo', {
    initialAsset: campaign.logo,  // AssetData from the server
  })

  // upload.status === 'ready'
  // upload.file.previewUrl === campaign.logo.url (direct URL for public assets)
  // upload.assetId === campaign.logo.id
}
```

For multi-upload:

```tsx
const multi = ctrl.useMultiUpload('documents', {
  initialAssets: campaign.documents,  // AssetData[]
})

// multi.readyAssetIds === [doc1.id, doc2.id, doc3.id]
```

---

## Cancellation

Individual uploads are aborted via `removeFile(fileId)` (multi) or `reset()` (single). In-flight XHRs are aborted immediately. Pending `Asset` rows are cleaned up by `runAssetCleanup()` — see [Storage Setup](/guide/storage).

Cleanup also runs automatically on component unmount.
