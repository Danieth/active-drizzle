
## "Changes have happened" — presentation + the toast seam (built)

rehydrate() no longer adopts silently: the session RECORDS what arrived
from elsewhere, and two seams present it —

```tsx
<deal.Changes />                              {/* default: "Updated elsewhere: name, notes ✕" */}
<deal.Changes>{({ fields, dismiss }) => (      /* or your own presentation */
  <Banner onClose={dismiss}>This deal was updated: {fields.join(', ')}</Banner>
)}</deal.Changes>
```

and the global event bus — ONE registration at startup plugs any toast or
telemetry system into every form in the app:

```ts
import { onFormEvents } from '@active-drizzle/react'
onFormEvents((e) => {
  if (e.type === 'rehydrated')     toast.info(`Updated elsewhere: ${e.fields?.join(', ')}`)
  if (e.type === 'conflict')       toast.warn('This record changed elsewhere')
  if (e.type === 'saved')          toast.success('Saved')
  if (e.type === 'draft-restored') toast.info('Restored your unsaved edits')
})
```

Events are SEMANTIC (what happened), never presentational (how to show
it) — the framework stays toast-library-agnostic, mirroring
onClientError. Nested structural changes report the association name;
no-op refetches emit nothing.
