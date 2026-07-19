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

---

## Live forms — the cache-coherence stack (built)

Mutate a record from ANY surface; every other surface — including live,
half-edited forms — gets fresh without losing a keystroke:

- **The edge table** (`_coherence.gen.ts`): codegen composes the include
  graph with the write-effect graph (counterCache/touch/dependent/nested,
  transitively), so a proposal mutation that touches its loan invalidates
  the doors that embed LOANS too. Every generated mutation fans out
  through one `applyEntityChange` call — WebSocket-ready by construction
  (signals feed the same entry point).
- **rehydrate()**: refetches three-way-merge into live forms — clean
  fields adopt, dirty fields survive, true conflicts withhold the version
  token so the next save 409s into the conflict UX. Nested children merge
  by id.
- **`<handle.Conflict>{resolve => ...}`** — renders only during a 409;
  wire "Take theirs"/"Keep mine" to `resolve('reload'|'overwrite')`.
- **Draft parking**: navigate away mid-edit and back — unsaved diffs park
  (LRU/TTL, cleared on save) and restore through the same merge; a field
  the server moved meanwhile conflicts honestly instead of silently.
- **poll + pendingIf**: `useDealEditForm(id, { poll: { every: 3000,
  until: d => d.reportStatus === 'ready' } })` +
  `<deal.reportUrl view pendingIf={d => d.reportStatus !== 'ready'}
  pendingLabel="Generating…"/>` for backend-job fields.

## The index surface (built)

```tsx
<Deals.Index>                       {/* the head is a component — no hooks */}
  <Deals.Search />                  {/* from index.searchable */}
  <Deals.Filters />                 {/* tier-1: enum→facet chips, boolean→toggle */}
  <Deals.Items>{(deal, row) => <deal.name view />}</Deals.Items>
  <Deals.Pagination />
</Deals.Index>
<Deals.One id={5}>{form => <form.Form>…</form.Form>}</Deals.One>
```

Declared server-side, allowlisted, codec-normalized, narrowing-only.
Tier-2 NAMED filters keep product semantics on the server:

```ts
index: {
  filterable: ['stage', 'priority', 'isFeatured'],
  filters: { bigDeals: { label: 'Big deals', kind: 'toggle',
    apply: (rel) => rel.where({ amount: { gte: 20_000 } }) } },
}
```

(Range `where` hashes — `{ gte, lte, gt, lt, ne }` — now work everywhere,
with bounds running through the Attr codecs.) Drive named filters from any
widget via `Deals.use().session.setFilter('bigDeals', true)` — change what
"big" means in the controller, no client redeploy. Individual placement:
`<Deals.Filters.stage/>`. The raw hooks stay exported underneath.

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

## Filter presenters — the socket, not the bulb (built)

`<Deals.Filters/>` now mirrors `<deal.name edit>` exactly. Three altitudes:

```tsx
// register once at startup — kind-defaults take over everywhere
registerFilterPresenter('segmented', { kind: 'facet', component: MySegmented })
setDefaultFilterPresenters({ facet: 'segmented', toggle: 'mySwitch' })

<Deals.Filters />                                  // all filters, resolved by kind
<Deals.Filters.stage presenter="segmented" />      // per-site override (kind-gated)
<Deals.Filter name="stage">                        {/* render-prop: raw state, no registry */}
  {({ meta, value, set, clear }) => <MyWidget options={meta.options} value={value} onChange={set} />}
</Deals.Filter>
```

`FilterPresenterProps = { name, meta, value, set, clear, session, counts? }`
— the list-state analogue of PresenterProps (`counts` reserved for facet
counts). Until you register presenters, built-in SCAFFOLDING renders so
demos work out of the box — unstyled, marked `data-ad-scaffold`, and it
announces itself once in the console. It is demo furniture, not the
product; the framework yields state and owns no display logic.

## Combinators — "this or this", weightless and airtight (built)

The default stays boring and right: array = OR-within a field, separate
keys = AND-across. Two additions, no query-builder:

```ts
// value operators (Attr-codec-transformed, work in where() and filters):
{ priority: { nin: ['low'] } }          // NOT IN
{ tags: { all: ['hot', 'q3'] } }        // array column contains ALL

// ONE cross-field combinator — depth-1 $or of flat allowlisted branches:
filters: { $or: [{ stage: 'submitted' }, { priority: 'high' }],
           bigDeals: true }             // → bigDeals AND (submitted OR high)
```

Security by construction: every branch key must be tier-1 allowlisted,
every value runs the same codecs, max 10 branches, nesting rejected
(`$or cannot nest`), named filters excluded from branches, and the whole
group ANDs onto the door-scoped relation — narrowing only. Anything more
complex than one flat OR belongs in a NAMED filter's server-side
`apply()` — that escape hatch already takes arbitrary logic and changes
without a client redeploy. Runtime primitive: `Relation.whereAny([...])`.
