# Abilities & the Forms Envelope

The controller is where *who may see and edit what* lives. Three pieces of
config turn a CRUD controller into a permission-aware form backend:

```ts
@controller()
@crud(Loan, {
  get: {
    expose: ['id', 'amount', 'termMonths', 'status'],   // read ceiling
    abilities: true,                                     // ship the mask
  },
  update: {
    permit: (_ctx, _ctrl, loan) =>
      loan.isDraft() ? ['amount', 'termMonths'] : [],    // record-aware writes
  },
})
export class LoanController extends ActiveController<AppContext> {}
```

## `expose` — the read ceiling

`expose` lists the **only** fields this controller ever serializes. Everything
else never crosses the wire — not in `record`, not in `abilities`, not in
generated Client types.

- Omitting `expose` keeps the default behavior (all fields), but disables the
  abilities envelope — Forms require an explicit ceiling.
- `expose` is also the **codegen projection**: generated Clients ship exactly
  these fields, and a validator/guard/predicate ships to a Client **iff its
  deps fit the projection**. Data availability — not editability — is the
  boundary: a rule that reads a view-only field still runs client-side,
  because the draft carries that field.

## `permit(ctx, ctrl, record)` — record-aware writes

`permit` accepts a static list or a function. The function now receives the
**record** as its third argument — the loaded record on update, a
defaults-draft on create — so state-dependent editing is one line:

```ts
permit: (_ctx, ctrl, loan) =>
  ctrl.state.canAdmin || loan.isDraft() ? ['amount', 'termMonths'] : []
```

Roles come from `ctx`/`ctrl.state`; record state comes from the record. Both
belong here — and *only* here. Model-level predicates that reference identity
are codegen errors.

Enforcement is unchanged: non-permitted fields in a write are silently
stripped server-side. With `abilities: true` they are *also* reported (see
below), so the generated UI can't hide a permit bug.

## `abilities: true` — the envelope

`get`, `update`, and `create` respond with:

```jsonc
{
  "record":    { "id": 1, "amount": 250000, "status": "draft", … },  // expose-filtered
  "abilities": { "amount": "edit", "termMonths": "edit", "status": "view" },
  "can":       { "submit": true, "approve": false, "reject": false }
}
```

- **`abilities[f]`** = `'edit'` iff `f ∈ permit(ctx, ctrl, record)`, else
  `'view'` iff `f ∈ expose`, else absent. The mask can only **narrow** the
  ceiling — the UI consumes permissions; it never creates them.
- **`can[event]`** — server-computed verdict for every
  [`Attr.state`](/models/state-machines) event, with full data. Generated
  client `can()` only ever narrows this.
- **Nested arrays are governed too**: every `acceptsNestedAttributesFor`
  association gets an `"<assoc>Attributes": "edit" | "view"` entry from the
  same resolved permit. `view` locks the whole array client-side —
  Add/Remove disappear, rows render through their view presenters, and the
  client sends nothing for it. The generated nested form only exists at all
  when the permit can accept the writes (codegen refuses to emit an editable
  array the server would always strip).

## Nested writes ride the permit

`notesAttributes` is a **permitted write surface** like any field:

```ts
update: { permit: ['name', 'amount', 'notesAttributes'] }
```

Omit it and the server strips every nested write (reported as a `forbidden`
issue). A record-aware permit locks the association exactly like a scalar:
`deal.isDraft() ? [...EDITABLE, 'notesAttributes'] : []` means notes freeze
with the rest of the form after submission.

### The two-layer rule (model allows, controller gates)

`acceptsNested` on the **model** only makes an association *nestable*. It is
never sufficient authorization on its own — the **controller** must still
permit `<assoc>Attributes` for a request to write it. This split matters:
one model can back several controllers with different exposure (an admin
controller that permits nested writes, a public one that doesn't).

The server hardens every nested write regardless of what the client sends:

- **Ownership is enforced.** A child `id` that isn't already a child of this
  record can't be updated, re-parented, or destroyed — forging one fails the
  save with a 422 (`row N is not part of this record's <assoc>`). A
  nonexistent id fails identically, so ids can't be probed.
- **The parent foreign key is forced**, never taken from the wire — a row
  can't be moved between parents by sending a different fk.
- **Server-owned fields strip** from every child row: `id` is protocol,
  timestamps are server-owned, and the STI discriminator `type` is stripped
  so subclasses can't be forged through nesting.
- **Destroying is a separate opt-in.** `acceptsNested: true` accepts creates
  and updates only; a `_destroy` marker is ignored. Destroying persisted
  children requires `acceptsNested: { allowDestroy: true }` (Rails'
  `allow_destroy`). The generated form hides Remove on persisted rows when
  it's off.
- **Grandchildren must be declared.** A nested `<x>Attributes` inside a child
  row is only honored when the child model itself declares `acceptsNested`
  for it — undeclared nested keys drop before they can reach an INSERT.

## Stripped writes are reported

When the envelope is on, a PATCH **or POST** containing non-permitted fields
still strips them (server-authoritative), and the response carries:

```jsonc
{ …envelope, "issues": [{ "field": "amount", "code": "forbidden" }] }
```

The generated client never swallows these: they surface as a base error and
a console warning, so a permit/UI mismatch cannot hide.

## Save responses echo the GET includes

The PATCH/POST envelope reloads the record with `get.include` before
serializing. This is what lets the client **settle** nested rows: freshly
created children come back with their ids, new rows re-key, and a second
save sends nothing. A controller with nested forms should always include
the association in `get.include` — without the echo the client warns in dev
that new rows cannot adopt their server ids.

## `_event` — submit as transition

A PATCH may carry `_event` alongside the diff:

```jsonc
{ "amount": 250000, "_event": "submit" }
```

The server applies the permitted diff, checks the transition guard with full
data, and fires the event **in the same save** — there is no
saved-but-not-transitioned limbo. A blocked event → 422 with a
`transition_blocked` base error, and nothing is saved.

`_event` is a **strict allowlist**: it may only name a declared `Attr.state`
transition. It never reaches mass assignment, and it cannot be used to invoke
an arbitrary record method — `_event: 'destroy'` (or any other non-transition
method) is a 400, not a call.

Because the PATCH response is the same envelope as GET, a transition that
narrows `permit` (DRAFT → SUBMITTED → `permit: []`) re-masks the response:
every field comes back `view`, and the same UI renders read-only. **The form
locks itself after submission with zero client code.**

## The layering, in one picture

```
expose  (codegen ceiling)   what CAN ever be seen        — static, per controller
  ⊇ abilities (runtime mask) what THIS user sees/edits    — per request, per record
      ⊇ client validation    what the browser can check   — deps ⊆ expose, fail-closed
```

The server enforces at every layer regardless of what the client renders.
`expose` also governs **`index`** — the list endpoint serializes each row
through the same ceiling, so a list can't leak a column the detail envelope
hides.

## The envelope is a wire contract (v1)

The envelope is **not** an implementation detail of the generated client — it
is the stable seam a second client (mobile, another team, curl) builds
against. Contract, versioned here:

```
GET  <base>/:id            → { record, abilities, can }
PATCH <base>/:id
  body: { data: { ...changedFields, <assoc>Attributes?: [...], _event?: string } }
  →   the same envelope, recomputed against the SAVED record
POST <base>                → the same envelope (when abilities is enabled)

record     expose-filtered serialization (+ get includes — save responses
           reload with them, so nested children echo back WITH ids)
abilities  { [field]: 'edit' | 'view' } — edit iff permitted for THIS user on
           THIS record; view iff exposed; absent otherwise. acceptsNested
           associations appear as '<assoc>Attributes' entries governed by
           the same permit
can        { [stateEvent]: boolean } — server-computed with full data
issues     [{ field, code: 'forbidden' }] — present when a PATCH/POST
           contained stripped non-permitted fields

Errors: 401/403 (auth) · 404 ·
        422 { errors: { [field | 'base' | 'assoc[id:N|new:K].field']: string[] } }
        (transition failures arrive as base with code transition_blocked)

Writes are last-writer-wins, like Rails. No version tokens, no client-side
lock bookkeeping. If your domain needs idempotent retries, put an
idempotency key on the specific endpoint that needs it — it is not a
framework concern.

Nested writes: [{ id, ...diff } | { id, _destroy: true } | { ...fields, _key }]
               — _key is client-ephemeral identity, echoed in 422 paths,
               never stored
```

Compatibility promise: additive fields may appear on the envelope; the
meanings above don't change without a major version.
