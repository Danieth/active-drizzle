# New features — fold into the main README

> Working notes for README sections, written as features land. Each section
> is self-contained: what it is, the one-decorator opt-in, and the JSX it
> buys you. Trim the verification notes when folding into the real README.

---

## hasOne — singular nested forms

Every association now works in forms. `hasOne` was the last gap: it had a
read side (lazy load, includes) but no write path. Now it opts into nested
attributes exactly like `hasMany` — except everything is singular.

### Model

```ts
@model('deals')
class Deal extends ApplicationRecord {
  // ONE brief per deal. acceptsNested opens the nested write surface;
  // allowDestroy is the Rails-style opt-in for deleting through the form.
  static brief = hasOne('briefs', {
    acceptsNested: { allowDestroy: true },
    dependent: 'destroy',
  })
}

@model('briefs')
class Brief extends ApplicationRecord {
  static deal = belongsTo('deals', { foreignKey: 'dealId' })
  static summary = Attr.string({ label: 'Summary', validates: Validates.presence() })
  static nextStep = Attr.string({ label: 'Next step' })
}
```

### Controller

The write surface is governed like any field — permit `briefAttributes`
and include `brief` so saves echo the child (with its id) back:

```ts
@crud(Deal, {
  get:    { expose: [...], abilities: true, include: ['brief'] },
  update: { permit: ['name', 'briefAttributes'] },
})
```

### The wire

`briefAttributes` is a **single object**, not an array:

```
{ summary: '...' }                → create the child (no id)
{ id: 7, summary: '...' }         → update it (ownership-gated)
{ id: 7, _destroy: true }         → destroy it (allowDestroy only)
```

Two singular-only guarantees:

- **The singular invariant.** An id-less write when a child already exists
  UPDATES that row (Rails' `update_only`, always on) — a second row can
  never appear, which also makes autosave/double-save idempotent by
  construction.
- **Shape is arity.** An array sent for a hasOne (or a bare object for a
  hasMany) is a protocol violation and drops whole, fail-closed.

Same security as hasMany rows: a forged/foreign child id 422s before
touching anything; the parent fk, timestamps, and STI `type` strip
server-side; `nestedAutoSet` paths walk through singular nodes.

### JSX

`<deal.brief>` render-props the ONE child handle (nothing renders while no
child exists). `Build` is the singular Add — it hides once the child exists:

```tsx
<deal.brief>
  {(brief) => (
    <>
      <brief.summary edit />
      <brief.nextStep edit />
      <brief.Remove>remove brief</brief.Remove>
    </>
  )}
</deal.brief>
<deal.brief.Build>+ add brief</deal.brief.Build>
```

Programmatic surface: `deal.brief.form` (child handle or null),
`.exists`, `.build(defaults?)`, `.remove()`, `.use()` (subscribe hook for
custom widgets). Child validation gates the parent submit; server errors
route as `brief.summary`. Meta kind is `nestedOne` (vs `nested` for
arrays); the child always stages into the parent save — there is no
instant mode for singular children.

*Verified end-to-end in the Dealdesk demo: browser edit→save→reload,
remove→save, Build→save, double-save idempotence at a stable id; curl
checks for the forged-id 422 and the id-less update-in-place.*

---

## Optimistic concurrency — the 409 conflict story

Before this, two tabs editing the same record silently last-write-wins —
and `<Form autosave>` makes that race easy to hit (both tabs flush). Now a
controller can version its updates; a stale write is refused with a 409
that carries everything the client needs to recover, and the form surfaces
the choice instead of clobbering.

### Controller (the whole opt-in)

```ts
@crud(Deal, {
  update: {
    optimisticLock: true,   // version from updatedAt
    // or: optimisticLock: 'lockVersion'  — numeric fields auto-increment
    permit: [...],
  },
})
```

- `true` versions on `updatedAt` — the model must advance it on save
  (a `@beforeSave` touch or DB trigger). Date tokens compare by epoch
  millis, so serialization round-trips can't produce false conflicts.
- A **numeric** field (`lock_version` style) auto-increments server-side
  on every governed update; the client never writes it.
- A PATCH **without** `_version` skips the check — pre-lock clients and
  scripts keep working. The lock only binds clients that hold a token.

### The wire

- Every envelope (GET, and the PATCH echo) carries `version` — an opaque
  token.
- The generated form echoes it as `_version` in every submit (batch
  submit, whole-diff autosave flush, and single-field autosave PATCHes).
- Mismatch → **409 CONFLICT** with `data.envelope` = the server's CURRENT
  envelope (fresh record + fresh version) — recovery needs no extra
  round-trip.

### The form side (automatic)

On a 409 the session parks in `'conflict'`: the draft is untouched (no
keystroke is ever dropped by a race), autosave pauses (no stale-token
retry loop), `<handle.SaveStatus/>` shows **"Changed elsewhere"**, and a
base error explains. Two exits:

```tsx
{deal.$status === 'conflict' && (
  <div role="alertdialog">
    Someone else changed this deal.
    <button onClick={() => deal.$resolveConflict('reload')}>
      Take theirs
    </button>
    <button onClick={() => deal.$resolveConflict('overwrite')}>
      Keep mine
    </button>
  </div>
)}
```

- `'reload'` — the server wins: the 409's envelope folds into the draft
  (nested children force-sync too), version adopts, session is clean.
- `'overwrite'` — you win, deliberately: adopt the fresh token and
  resubmit your still-dirty diff. This is an explicit user action — the
  framework never overwrites on its own.

`deal.$conflict` exposes the fresh envelope for richer UIs (e.g. a
field-by-field "theirs vs mine" diff before choosing).

*Verified over HTTP with a two-tab race: fresh save rotates the token,
the stale tab 409s with the fresh envelope, overwrite lands, and a
version-less PATCH still saves.*

---

## Create-from-picker (a recipe, not a feature)

"Add a new user from inside the owner picker" needs ZERO framework
machinery — that's the point of pickers taking a controller (`from`), not
a model. The door you handed the picker already has `create`. The whole
pattern is app code:

```tsx
// Inside your RefSelect presenter's menu:
<button onClick={() => setModalOpen(true)}>+ New user…</button>

// The modal's save:
const created = await UserController.with({}).mutateCreate({ data: { name, email } })
queryClient.invalidateQueries({ queryKey: userKeys.all })  // picker lists refresh
bind.onChange(created.id)                                  // select the new row

// The same permission story as everywhere else: if this user can't create
// users, the controller 403s — the modal just surfaces it.
```

Notes:
- `from` names the DOOR — which controller's index/search feeds the picker
  and which create governs the modal. Different pickers, different doors,
  different rules; the framework never guesses a canonical controller.
- Works identically for habtm multi-pickers (`bind.onChange([...ids, created.id])`).

---

## Polymorphic associations — the inverse side (`as:`)

Polymorphic `belongsTo` always worked (`commentable` resolves through the
`commentableType`/`commentableId` pair). The INVERSE was the trap: a plain
`hasMany('comments', { foreignKey: 'commentableId' })` scoped only by id —
so `Deal#1.comments` and `Company#1.comments` leaked into each other. Now
there's Rails' `:as`:

```ts
@model('comments')
class Comment extends ApplicationRecord {
  static commentable = belongsTo({ polymorphic: true })  // → commentableType/commentableId
}

@model('deals')
class Deal extends ApplicationRecord {
  static comments = hasMany('comments', { as: 'commentable' })
}
```

- The relation scopes by **both** columns: `commentableId = this.id AND
  commentableType = 'Deal'`. The foreign key defaults to `${as}Id`.
- Nested attributes honor it too: the ownership gate checks the type column
  (a forged child id from another parent TYPE 422s), and writes force both
  columns.
- `hasOne(..., { as: ... })` gets the same treatment.

### Association-scoped create/build

Relations reached through an association now carry their scope into writes:

```ts
await deal.comments.create({ body: 'hi' })  // commentableId + commentableType set
const draft = deal.comments.build({ body })  // unsaved, same defaults
```

Works for any simple hasMany/hasOne (plain fk too, not just polymorphic).
through/habtm relations carry no defaults — create the join row through its
own model, or sync habtm via `<singular>Ids`.

*Verified empirically (demo `scripts/poly-through-probe.mts`): same-id Deal
and Company each see only their own comments; created-through-association
rows land on the right parent.*

---

## has-many-through: `source` actually works now

`source` (Rails' `:source`) was documented in `HasManyOptions` but the
runtime never read it — it silently fell through to a naive `<target>Id`
guess and returned an UNSCOPED relation (all rows). Now:

```ts
@model('companies')
class Company extends ApplicationRecord {
  // Deal.owner is belongsTo('users', { foreignKey: 'ownerId' })
  static stakeholders = hasMany('users', { through: 'deals', source: 'owner' })
}
```

`source: 'owner'` resolves the `owner` belongsTo ON THE THROUGH MODEL and
uses its foreign key (`ownerId`). Precedence: `sourceForeignKey` (explicit
column, now in the public type — no more `as any`) → `source` → naive
`<target>Id`.

---

## Concerns are on the main entry now

`include` was exported but everything you'd pass it wasn't — the concern
system was unreachable without a subpath the exports map didn't expose.
All of it now ships from `active-drizzle`:

```ts
import { include, SoftDeletable, Sluggable, Publishable, Trackable,
         defineModelConcern } from 'active-drizzle'

@model('posts')
@include(SoftDeletable, Sluggable({ from: 'title' }))
class Post extends ApplicationRecord {}
```

---

## `recordOf()` — door-agnostic get() unwrapping

A controller with `abilities: true` answers `get()` with the Forms envelope
`{ record, abilities, can }`; one without answers with the bare row. A
picker pointed at an arbitrary door must not care which:

```ts
import { recordOf } from '@active-drizzle/react'
const row = recordOf(await DoorController.get({ id }))   // works for both
label = row?.name
```

Without it, every UI kit independently rediscovers `data.record ?? data`
(the demo's company picker rendered `#1` because `data.name` was undefined
on the enveloped door).

---

## Generated output is now `tsc --noEmit`-clean

A batch of DX fixes so a fresh project typechecks out of the box:

- **The augmentations actually apply now.** Model type declarations moved
  from `X.model.gen.d.ts` to **`X.model.types.gen.d.ts`** — a `.d.ts`
  sharing its basename with a sibling `.ts` is treated by tsc's include
  rules as that file's build output and silently EXCLUDED, so every
  `declare module` augmentation (instance fields on `this`, typed statics,
  scopes) had never been in the program. Delete old `*.model.gen.d.ts`
  files after regenerating.
- Own statics (scopes, enum groups, `@computed`) are no longer redeclared
  in the merged namespace — that's TS2451 the moment the augmentation
  applies; the class's own declaration is the type. Inherited STI scopes
  still get namespace declarations.
- `@model` no longer type-errors on classes with `static name = Attr…`
  (the decorator's target is a free generic, not `Function`).
- `serverValidates` accepts `AsyncAttrValidator` — so
  `serverValidates: Validates.uniqueness()` typechecks as documented.
- Controller-less nested children (`NoteAttrs` etc.) INLINE their wire
  shape instead of importing from a `.gen` module that only exists for
  models with controllers.
- `{Model}FormHandle` now types the nested members the JSX uses
  (`deal.notes: ArrayFieldHandle`, `deal.brief: OneFieldHandle`), and
  `Form`/`Submit`/`BaseErrors` accept `className`.
- Polymorphic belongsTo no longer fabricates a client class for a target
  that can't exist statically (`CommentableClient`).
- `ClientModel` takes `Partial<TAttrs>` (drafts are sparse by nature) and
  declares `id?` (a new-form draft genuinely has none).
