# The Forms Surface

The endgame: the field is the component, the controller is the truth, and the
form assembles itself from the backend model's metadata. The API you use is
**generated from your own controllers** — you import from your codegen
output, not from the framework:

```tsx
import { useLoanEditForm } from './_generated/loan.gen'

const { status, form: loan } = useLoanEditForm(id)
if (status !== 'ready') return <Spinner />

<loan.Form>
  <loan.amount edit />
  <loan.targetRate edit="bpsSlider" label="Target (bps)" />
  <loan.status />
  <loan.BaseErrors />
  <loan.Submit>Save draft</loan.Submit>
  <loan.Submit event="submit">Submit application</loan.Submit>
</loan.Form>
```

The generated hook owns the whole lifecycle: it fetches the envelope,
builds the typed handle, keys the session by id (navigating between records
rebuilds), rehydrates a clean draft when a refetch lands (a dirty draft is
never clobbered), and PATCHes the diff on submit.

## The naming law

- **camelCase — your fields.** `loan.amount` is a callable component (JSX
  member expressions don't need capitalization). Bare = view. `edit` =
  editable with the Attr's declared/default presenter. `edit="name"` = named
  override. **`edit` is never inferred.**
- **PascalCase — components.** `loan.Form`, `loan.Submit`, `loan.BaseErrors`.
- **`$` — framework API.** `loan.$draft`, `loan.$errors`, `loan.$dirty`,
  `loan.$status`, `loan.$submit()`, `loan.$can('submit')` — so a column named
  `status` can never collide with the handle's own state.

## What renders, and why

Each field resolves through a deterministic ladder:

1. Not in the server `abilities` mask → **null** (T3)
2. `presentIf(draft)` false → **null** — and the value survives on the draft
3. Ability is `edit` AND the call site passed `edit` AND not `lockedIf` →
   **edit presenter**
4. Otherwise → **view presenter**

The same JSX renders an input for an editor and text for a viewer — the
[abilities envelope](/controllers/abilities) decides, not your template.

## Presenters — headless, yours

ActiveDrizzle ships **zero** presenters: the socket, never the bulbs.

```tsx
registerPresenter('moneyInput', {
  kind: 'money',
  commit: 'blur',              // discrete inputs (toggles, selects): 'change'
  requires: ['label'],         // meta this presenter refuses to render without
  component: MoneyInput,       // your markup, your styling
})

setDefaultPresenters({
  money:   { edit: 'moneyInput', view: 'moneyText' },
  boolean: { edit: 'switch',     view: 'check' },
})
```

A presenter receives one props contract and stays ~30 lines:

```ts
{ value, bind, meta, overrides, mode, draft, errors, state }
```

- `bind` carries all behavior — `onChange`, `onBlur`, `onCommit`, `disabled`.
  Staging, error timing, and (soon) autosave live in FormSession, not here.
- `meta` is the field's backend Attr metadata — label, help, info, resolved
  per-discriminant copy, your custom `meta:` keys.
- `draft` is the entire projected object — safe by construction: unexposed
  fields never crossed the wire.
- Resolution is loud: unknown names, kind mismatches, and missing `requires`
  meta throw descriptive dev errors instead of rendering wrong.

## Error timing (the polite form)

Validation runs on change; errors **display** on blur or after a submit
attempt — and once visible they clear live as the user types. Server 422s
bind to their fields; errors on fields outside this form's projection
re-field to `<loan.BaseErrors />`.

## Submit, transitions, and the self-locking form

`<loan.Submit>` sends only `changedData()`. `<loan.Submit event="submit">`
also carries `_event` — the server
fires the [state machine](/models/state-machines) transition **in the same
save**, and the button disables itself from the server's `can` map.

Because the PATCH response is the same envelope as GET, a transition that
narrows `permit` re-masks the session: **the exact same JSX re-renders
read-only.** Submitting an application freezes the form into a summary with
zero client code.

Other guarantees, all tested:

- A 401 mid-form sets `$status: 'unauthenticated'` and **keeps the draft** —
  re-auth, click again, the same diff submits.
- Programmatic writes (`loan.$draft.amount = 5`) re-render subscribed fields.
- A keystroke re-renders one field, not the form (per-field subscriptions;
  only predicate-bearing fields watch the whole session).

## Autosave — the commit policy

Presenters declare their natural **commit moment** at registration (discrete
inputs like toggles: `commit: 'change'`; continuous inputs: `'blur'`). The
*context* decides what commit does:

- `<loan.Form>` — commits **stage**; Submit sends the batch.
- `<loan.Form autosave>` — every commit sends a **single-field PATCH**.
- A field with **no Form at all** — autosave by definition. The handle owns
  the transport; a toggle is one line:

```tsx
<loan.isPublished edit />   // flip → optimistic → PATCH → rollback on failure
```

Autosave is optimistic with rollback, gated by the field's own validators
(a locally-invalid value never PATCHes), and exposes per-field
`saving | saved | error` through the presenter's `state` prop — a
spinner-in-the-switch is one prop read. Two footguns are handled for you:
a blur into an element marked `data-ad-cancel` skips the commit (the classic
autosave-races-the-Cancel-button bug), and commits are suppressed during IME
composition, firing once at composition end.

## Nested forms — `accepts_nested_attributes_for`, unfurled

Mark the association meta `kind: 'nested'` and the field becomes an array
handle with a render-prop — keys are internal, never written by you:

```tsx
<loan.Form>
  <loan.assets>
    {(asset) => (<>
      <asset.name edit />
      <asset.value edit />
      <asset.Remove />
    </>)}
  </loan.assets>
  <loan.assets.Add defaults={{ value: 0 }}>Add asset</loan.assets.Add>
  <loan.Submit>Save</loan.Submit>
</loan.Form>
```

- **Identity keys** — persisted rows key on `id`, new rows on an ephemeral
  `_key`. Removing a middle row can never shift a sibling's state.
- **Remove semantics** — persisted rows mark `_destroy`; new rows vanish.
- **One PATCH** — submit folds child changes into `assetsAttributes:
  [{ id, ...diff } | { id, _destroy: true } | { ...fields, _key }]`, landing
  on the server runtime that already processes it transactionally.
- **Errors route by identity** — a 422 addressed `assets[new:3].name` lands
  on exactly the right child form, even for rows that don't exist in the
  database yet. Invalid children block the parent submit.
- After a successful save, new rows adopt their server ids and re-key.
- **Nested-nested works** — a child form can carry its own nested arrays;
  grandchildren fold as `liensAttributes` inside the child's payload, and
  the server's recursive save processes the whole tree in one transaction.
- **Drag-and-drop reordering** — declare `orderBy: 'position'` on the nested
  meta and wire any DnD library's drop handler to
  `loan.assets.move(key, toIndex)`: the rows reorder, every child's position
  rewrites, and the diffs ride the next submit like any other edit.

## Generated hooks — the zero-wiring path

For an [envelope controller](/controllers/abilities), codegen emits a fully
wired, fully typed surface:

```tsx
import { useLoanEditForm } from './_generated'

const { status, form: loan } = useLoanEditForm(id)
if (status !== 'ready') return <Spinner />

<loan.Form>
  <loan.amount edit />        {/* TypedFieldComponent<'money'> */}
  <loan.Submit event="submit">Submit application</loan.Submit>
</loan.Form>
```

`useLoanEditForm` fetches the GET envelope through the generated client,
builds the Client draft + FormSession, PATCHes the diff (+`_event`) on
submit, invalidates the model's cache keys, and maps transport failures onto
the session (422 → fields, 401 → draft-preserving re-auth state).
`useLoanNewForm` does the same over `create` with a defaults draft.

## Files are fields

`@attachable` controllers make attachments first-class form fields. The
generated meta carries the upload contract, and writes automatically target
the permitted `<name>AssetId` column — the presenter deals in assets, the
wire deals in ids, nobody wires it:

```tsx
<loan.contract edit />
// meta: { kind: 'attachmentOne', accepts: 'application/pdf', maxSize: 5242880 }
// value: the loaded asset payload   ·   bind.onChange(asset) → writes contractAssetId
```

An upload presenter renders a correct dropzone from `meta.accepts`/`maxSize`
alone, calls the existing upload hooks to presign + upload, then hands the
ready asset to `bind.onChange`. `attachmentMany` fields write
`<name>AssetIds` arrays.

## Styling — it's just your components

Presenters are your components, so Tailwind (or anything) works the obvious
way. Three layers:

1. **In the presenter** — bake your design system in once.
2. **At the call site** — `className` passes through on every field and
   every built-in: `<loan.amount edit className="w-full rounded" />`,
   `<loan.Form className="space-y-4">`, `<loan.Submit className="btn" />`.
3. **Per instance** — the `props` prop forwards arbitrary extras to the presenter.

AD ships zero CSS and zero markup opinions beyond `<form>`/`<button>`
semantics on its built-ins.

## Validators travel — `Validates.*` runs in the browser

The [declarative validators](/hooks/validators) ship to generated Clients
automatically: codegen detects `Validates.*` in an Attr's `validates:`,
emits the import, and the same rule runs as-you-type client-side and again
server-side. Three safety rules make this DRY *and* safe:

- **App helpers stay server-only.** A validator referencing anything a
  client can't resolve (`validates: v => myHelper(v)`) is excluded from the
  client with a build **warning** naming the culprit — graceful degradation,
  never a browser ReferenceError. Use `Validates.*` or inline the logic to
  ship it.
- **Record gates degrade.** `Validates.presence({ if: (r) => r.isAdmin() })`
  where the gate touches something outside this client's projection throws
  client-side — the generated runner catches it and skips that rule. The
  server remains authoritative; the client never crashes and never
  false-blocks.
- **Semantic kinds for free.** `Validates.email()` / `url()` / `uuid()`
  refine the field's kind: typed handles emit
  `TypedFieldComponent<'email' | 'string'>`, so both `emailInput` and plain
  `text` presenters are legal, and runtime resolution falls back to the
  string defaults until you register something prettier. One registration
  upgrades every email field in the app.

## The presenter kind gate — compile-time wiring checks

Tell TypeScript what your presenters accept, once:

```ts
declare module '@active-drizzle/react' {
  interface AdPresenterKinds {
    moneyInput: 'money'
    moneyText: 'money'
    switch: 'boolean'
    badge: '*'                 // any kind
  }
}
```

Generated handles then constrain every call site:
`<loan.amount edit="switch" />` is a **compile error** — `amount` is a
`money` field and `switch` only accepts `boolean`. Until you augment the
interface, the gate stays open (plain strings), so adoption is incremental.
The `requires` gate (presenter demands meta the Attr doesn't declare) backs
this up with a loud dev-mode error.

## Escape hatch: wiring a session by hand

You will rarely want this — the generated hooks are the API. But for tests,
storybooks, and non-codegen contexts, `useForm` (from
`@active-drizzle/react`) accepts a draft, an envelope, and any transport:

```tsx
import { useForm } from '@active-drizzle/react'

const loan = useForm({
  draft, mode: 'edit', envelope,           // { abilities, can }
  submit: async ({ data, _event }) => {
    const res = await client.loans.update({ id, data: { ...data, _event } })
    return { ok: true, envelope: res }
  },
})
```
