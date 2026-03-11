# Form Integration (TanStack Form)

The generated `{model}FormConfig` object wires your controller's permit list, model validations, and enum options directly into TanStack Form. Client-side validation runs from the same rules as server-side validation — you never write them twice.

## What `formConfig` Provides

```ts
import { campaignFormConfig } from '../_generated'

campaignFormConfig.defaultValues     // { name: '', status: 'draft', budget: null, ... }
campaignFormConfig.validators        // { onChange, onSubmit } — from @validate methods
campaignFormConfig.enumOptions       // { status: [{ value: 'draft', label: 'Draft' }, ...] }
```

Spread it into `useForm` and the basics are handled:

```tsx
import { useForm } from '@tanstack/react-form'
import { campaignFormConfig } from '../_generated'

const form = useForm({
  ...campaignFormConfig,
  onSubmit: async ({ value }) => {
    // value is typed as CampaignWrite — permit-listed fields only
    await create.mutateAsync(value)
  },
})
```

## Create Form

```tsx
import { useForm }              from '@tanstack/react-form'
import { campaignFormConfig, CampaignController } from '../_generated'
import { parseControllerError, applyFormErrors }  from '@active-drizzle/react'

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

  // Apply server validation errors to the form after a failed submit
  if (err?.isValidation) applyFormErrors(form, err)

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="name">
        {(f) => (
          <div>
            <label>Name</label>
            <input
              value={f.state.value}
              onChange={e => f.handleChange(e.target.value)}
              onBlur={f.handleBlur}
            />
            {f.state.meta.errors?.map(msg => (
              <p key={msg} className="text-sm text-red-500">{msg}</p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="status">
        {(f) => (
          <div>
            <label>Status</label>
            <select value={f.state.value} onChange={e => f.handleChange(e.target.value)}>
              {campaignFormConfig.enumOptions.status.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
      </form.Field>

      <form.Field name="budget">
        {(f) => (
          <div>
            <label>Budget</label>
            <input
              type="number"
              value={f.state.value ?? ''}
              onChange={e => f.handleChange(e.target.value ? +e.target.value : null)}
            />
            {f.state.meta.errors?.map(msg => (
              <p key={msg} className="text-sm text-red-500">{msg}</p>
            ))}
          </div>
        )}
      </form.Field>

      <button type="submit" disabled={create.isPending || form.state.isSubmitting}>
        {create.isPending ? 'Creating...' : 'Create Campaign'}
      </button>

      {err && !err.isValidation && (
        <p className="text-sm text-red-500">{err.message}</p>
      )}
    </form>
  )
}
```

## Update Form

Update forms pre-populate from an existing record. TanStack Form's `defaultValues` accepts the record directly since `CampaignClient` is a subtype of `CampaignWrite`:

```tsx
function EditCampaignForm({ campaign, teamId, onSuccess }) {
  const update = CampaignController.use({ teamId }).mutateUpdate()
  const err    = parseControllerError(update.error)

  const form = useForm({
    ...campaignFormConfig,
    defaultValues: {
      name:   campaign.name,
      status: campaign.status,   // 'draft' | 'active' | 'paused' — enum label
      budget: campaign.budget,
    },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({ id: campaign.id, ...value })
      onSuccess()
    },
  })

  if (err?.isValidation) applyFormErrors(form, err)

  return (
    <form onSubmit={e => { e.preventDefault(); form.handleSubmit() }}>
      {/* same fields as create form */}
      <button type="submit" disabled={update.isPending}>Save Changes</button>
    </form>
  )
}
```

## Validation Error Binding

`applyFormErrors(form, parsed)` maps each field in `parsed.fields` to the corresponding TanStack Form field's error state:

```tsx
// After a 422 UNPROCESSABLE_ENTITY response, the form fields
// will show server-side errors inline — no extra code.

const err = parseControllerError(update.error)
if (err?.isValidation) {
  applyFormErrors(form, err)
  // Internally calls:
  //   form.setFieldMeta('name', m => ({ ...m, errors: ['can\'t be blank'] }))
  //   form.setFieldMeta('budget', m => ({ ...m, errors: ['must be >= 0'] }))
}
```

This works with any field structure your backend returns — even nested field paths like `'address.zip'`.

## Enum Options

```tsx
// Access enum options from formConfig
campaignFormConfig.enumOptions.status
// [{ value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' }, ...]

// Use in a <select>
<select>
  {campaignFormConfig.enumOptions.status.map(o => (
    <option key={o.value} value={o.value}>{o.label}</option>
  ))}
</select>
```

Enum option labels are derived from your `Attr.enum` definition — the same labels used throughout the model. They're consistent by construction.
