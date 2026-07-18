# The Forms Surface

The endgame: the field is the component, the controller is the truth, and the
form assembles itself from the backend model's metadata.

```tsx
import { useEditForm } from '@active-drizzle/react'

const loan = useEditForm({ draft, envelope, submit })

<loan.Form>
  <loan.amount edit />
  <loan.targetRate edit="bpsSlider" label="Target (bps)" />
  <loan.status />
  <loan.BaseErrors />
  <loan.Submit>Save draft</loan.Submit>
  <loan.Submit event="submit">Submit application</loan.Submit>
</loan.Form>
```

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

`<loan.Submit>` sends only `changedData()` plus the optimistic-lock
`version`. `<loan.Submit event="submit">` also carries `_event` — the server
fires the [state machine](/models/state-machines) transition **in the same
save**, and the button disables itself from the server's `can` map.

Because the PATCH response is the same envelope as GET, a transition that
narrows `permit` re-masks the session: **the exact same JSX re-renders
read-only.** Submitting an application freezes the form into a summary with
zero client code.

Other guarantees, all tested:

- Stale `version` → 409; the client refetches, never silently overwrites.
- A 401 mid-form sets `$status: 'unauthenticated'` and **keeps the draft** —
  re-auth, click again, the same diff submits.
- Programmatic writes (`loan.$draft.amount = 5`) re-render subscribed fields.
- A keystroke re-renders one field, not the form (per-field subscriptions;
  only predicate-bearing fields watch the whole session).

## Wiring transports

`useForm` is transport-agnostic — generated controller hooks will wire the
GET envelope and PATCH for you; until then (and in tests) inject anything:

```tsx
const loan = useEditForm({
  draft: LoanClient.from(payload.record),
  envelope: payload,                       // { abilities, can, version }
  submit: async ({ data, version, _event }) => {
    const res = await client.loans.update({ id, data: { ...data, _event }, version })
    return { ok: true, envelope: res }
  },
})
```

## Coming next

Autosave contexts (`<loan.Form autosave>` and standalone fields), nested
attribute arrays (`loan.assets` with render-prop unfurl and `_key`-routed
errors), and generated typed handles per controller.
