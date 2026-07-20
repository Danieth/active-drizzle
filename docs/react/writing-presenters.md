# Writing a Presenter

ActiveDrizzle ships **zero** presenters. Every field you render —
`<deal.amount edit />` — resolves to a component *you* registered, and that
component receives everything it needs as props. That component is a
presenter, and this guide is about writing good ones.

Here is the one idea to internalize before anything else:

> **A presenter just presents.** By the time your component renders, the
> model has already decided what's valid, the controller has already
> decided who may edit, the session has already staged the draft, run the
> validators, and detected any conflict. You receive finished state. Your
> whole job is to turn it into pixels — with as much care as you can
> afford, because pixels are now the *only* thing you're responsible for.

That narrowness is not a restriction. It's the reason presenters can be
excellent. Every hour that other form stacks spend wiring validation and
save logic, you get to spend on the questions users actually feel:

- What does **unsaved** look like?
- What does **someone else changed this** look like?
- What does **saving** feel like — per field, not per page?
- What does **you can see this but not edit it** look like?
- What does an **error** look like, at the right moment, next to the
  right control?

Those five questions are the entire craft. They're also finite — which is
what makes real fidelity achievable.

## Your focus is on ______, not on ______

| Your focus is on… | …not on |
| --- | --- |
| **Rendering the value** in your design language | Deciding what's valid — the model declared it once (`Validates.email()` and friends); codegen shipped those validators to the browser; the session runs them |
| **Displaying `errors[]`** clearly, next to the control | Writing rules or error messages — errors arrive as finished strings |
| **A real read-only twin** for view mode | Permission logic — `mode` arrives already resolved from the server's abilities mask |
| **Reflecting save state** (spinner, saved tick) | Saving — `bind.onCommit()` is a *signal*; the surrounding context decides what it does |
| **Presenting a conflict** and offering "take theirs" | Detecting conflicts — `elsewhere` arrives when the server moved a field under your user's edit |
| **A few deep, configurable inputs** | One component per semantic kind — an "email field" is your string input receiving email errors from above |
| **Formatting for humans** (`$4.5M`, `7.25%`) | Parsing and persistence — codecs live on the model |

If a change you're about to make decides what's valid, what a field
*means*, or who may touch it — you're on the wrong side of the socket.
Put it in the model or controller, where it's declared once and enforced
everywhere.

## The contract: what arrives, and what to do with it

Every presenter receives `PresenterProps`:

| Prop | What it is | What you do with it |
| --- | --- | --- |
| `value` | The current draft value | Render it beautifully |
| `bind` | `{ name, onChange, onCommit, onBlur, onCompositionStart/End, disabled }` | Wire your input to it (see commit, below) |
| `meta` | The field's static metadata: `kind`, `label`, `help`, `options`, … | Default copy and choices — never invent your own |
| `overrides` | Call-site props from the JSX | They always win: `overrides.label ?? meta.label` |
| `mode` | `'edit'` or `'view'` | Render the input, or the read-only twin |
| `errors` | `string[]`, already gated to the right moment | Show them; set `aria-invalid`; never re-derive |
| `dirty` | Draft differs from the saved baseline | Show it — a dot, and ideally "was *X*" with one-click revert |
| `state` | Per-field save lifecycle: `ready · saving · saved · error · pending` | Narrate it *on this field* — a small spinner, a brief ✓ pulse |
| `elsewhere` | `{ value, at, by }` — the server changed this field under a dirty edit | Offer theirs: show it, and adopt on click |
| `draft` | The entire projected draft | Free cross-field *display* (format an amount with `draft.currency`) — read-only awareness, never cross-field logic |

Two details worth knowing:

- `bind.onBlur` passes the focus event through; blurring into an element
  marked `data-ad-cancel` (your Cancel button) skips the autosave commit.
- The composition handlers suppress commit-on-change during IME input.
  Pass them to your `<input>` and international text just works.

## A complete presenter

Small on purpose — most presenters are 20–40 lines:

```tsx
import { registerPresenter, type PresenterProps } from '@active-drizzle/react'

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toLocaleString('en-US')}`

function MoneyInput({ value, bind, meta, overrides, errors, mode }: PresenterProps) {
  // Half the job: the view twin. `mode` is the server's abilities verdict.
  if (mode === 'view') return <span className="money">{usd(value)}</span>

  return (
    <label className="field">
      {overrides.label ?? meta.label}
      <input
        inputMode="decimal"
        value={value ?? ''}
        disabled={bind.disabled}
        aria-invalid={errors.length > 0 || undefined}
        onChange={(e) => bind.onChange(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={(e) => { bind.onCommit(); bind.onBlur?.(e) }}
        onCompositionStart={bind.onCompositionStart}
        onCompositionEnd={bind.onCompositionEnd}
      />
      {errors.map((msg) => <p key={msg} className="field-error">{msg}</p>)}
    </label>
  )
}

registerPresenter('moneyInput', {
  kind: 'money',        // which semantic kinds this accepts ('*' = any)
  commit: 'blur',       // continuous input → commit when the user leaves it
  component: MoneyInput,
})
```

From then on, `<deal.amount edit />` resolves to it automatically (kind
default), and `<deal.anything edit="moneyInput" />` requests it by name.
Resolution is fail-loud: call-site name → the Attr's `presenters:` → your
kind default → **throw**. A presenter registered for the wrong kind is a
descriptive dev error — and a compile error once you add the
`AdPresenterKinds` module augmentation.

## Commit: `'change'` or `'blur'` — and the one trap

Discrete inputs (toggles, pickers, dates, steppers) commit on change:
their handlers call `bind.onChange(v)` then `bind.onCommit()`. Continuous
inputs (text, numbers) commit on blur.

What commit *does* is never your concern — context decides:

- inside `<deal.Form>` → stages; Submit sends one diff
- inside `<deal.Form autosave>` → debounced, validity-gated whole-diff
  flush (rapid commits coalesce into one PATCH)
- outside any form → a single-field PATCH per commit

**The trap:** some gestures fire change and commit in the *same tick* (a
"split" button, a click-stepper). If your wrapper commits a value captured
at render time, it commits the stale value and silently reverts the
gesture. Track the latest change in a ref:

```tsx
const latest = useRef(value)
latest.current = value

<Stepper
  onChange={(next) => { latest.current = next; bind.onChange(next) }}
  onCommit={() => bind.onCommit()}   // session reads the staged latest — fine
/>
```

(When your inner component reports "commit" without a value, always commit
through the ref, never through a captured prop.)

## View mode is half the job

`mode === 'view'` means this user can *see* the field but not edit it —
the server said so. Render a **real** display twin (formatted money, a
status badge, a progress bar), not a greyed-out input. Two rules:

- **Not exposed ≠ view.** A field outside the user's projection doesn't
  exist on the handle at all. Don't reserve layout holes for it.
- **`mode` can flip mid-session.** Submitting a record can narrow
  permissions; the fresh envelope re-masks the live form in place. Your
  presenter should handle switching between twin and input without
  ceremony.

## Dirty, saving, elsewhere — where presenters earn their keep

These three props are the difference between a form and a *good* form,
and they cost the framework nothing to give you — so spend your effort
here.

**Dirty.** A dot is the floor. The ceiling: show what the user changed
*from* — "↩ was 7.10%" — and let one click revert (set the draft back to
the baseline). Works for every value type if you format at one shared
spot.

**Saving.** `state` is per *field*. When an autosave flush lands, pulse a
small ✓ on exactly the fields that saved — never a global spinner. Users
learn to trust the form because it narrates precisely.

**Elsewhere.** When `elsewhere` is set, another user changed this field
while yours holds a different value. The framework has already withheld
the version (a blind save will 409), so there's no race to fear — your
whole job is presentation:

```tsx
{elsewhere && (
  <button onClick={() => { bind.onChange(elsewhere.value); bind.onCommit() }}>
    {elsewhere.by ?? 'Someone'} changed this to {fmt(elsewhere.value)}
    {elsewhere.at && ` · ${elsewhere.at}`} — take theirs
  </button>
)}
```

Patterns that have proven out, in ascending ambition:

1. a chip near the label (value · who · when) with adopt/dismiss,
2. a *visual diff* on hover — for a range, draw both ranges on one rail;
   for a set, mark added/removed; for a number, show the delta,
3. a **ghost**: render *their* value inside your control's own vocabulary
   — a second band on the slider rail, a dot on their option — warning-
   toned, non-interactive, never blocking the user's editing.

This machinery is also the landing pad for realtime: when changes arrive
over websockets instead of refetches, the same `elsewhere` props light up
— presenters written this way become multiplayer without modification.

## What *not* to build (each of these has been tried)

- **A validation library.** `email()`, `max(15)` in the UI layer is a
  second authority on validity, guaranteed to drift from the model. If a
  rule matters, it belongs on the Attr — it will run in the browser
  anyway, via codegen.
- **A presenter per semantic kind.** Kinds without a registered presenter
  fall back (`email`/`url`/`uuid` → your string presenter) — on purpose.
  Reach for a new presenter when the *interaction* is new, not when the
  meaning is.
- **A form layout generator.** JSX is already the layout language, and
  the generated scaffold form covers the ugly-default case. Ship dumb
  layout components; compose at the call site.
- **Handle spelunking.** The field handle exposes reads
  (`.value .errors .meta .dirty .elsewhere .ability`) — the bind is
  deliberately not among them. For portals, joint fields, or any novel
  composition, use the public hook:

```tsx
const props = useFieldProps(form, 'amount')   // full PresenterProps,
// built by the same code path as a generated field — IME guards, commit
// routing from the surrounding <Form>, everything.
```

## Testing

Don't hand-roll `PresenterProps` fixtures — you'd be testing your
imitation of the contract instead of the contract. The testing kit
arranges *real* sessions:

```tsx
import { createTestSession, buildTestProps, fieldStateFixtures } from '@active-drizzle/react/testing'

const session = createTestSession(fieldMeta, { amount: 4_500_000 })
const props   = buildTestProps(session, 'amount')          // real bind, real staging
const states  = fieldStateFixtures(session, 'amount')      // every lifecycle state
```

`fieldStateFixtures` walks the full lifecycle — ready, dirty, saving,
saved, error, conflict — so a Storybook page can show every state of your
presenter against genuine machinery.

## The checklist

A presenter is *done* when every prop has a first-class answer:

- [ ] `value` renders beautifully — including empty (`—`, a placeholder)
- [ ] `errors` show as full sentences, next to the control, `aria-invalid` set
- [ ] `dirty` is visible — ideally with "was X" and one-click revert
- [ ] `state` narrates saving → saved on this field
- [ ] `elsewhere` offers theirs — visibly, adoptably
- [ ] `mode='view'` renders a real twin, and survives flipping mid-session
- [ ] `bind.disabled` dims *and* explains (a `title` beats a mystery)
- [ ] Keyboard and IME work (pass the composition handlers through)

Everything upstream of those boxes — validity, permissions, saving,
conflicts, sync — is already handled, and handled well. Stay in your
inch. Make it perfect.
