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
  "can":       { "submit": true, "approve": false, "reject": false },
  "version":   "1721294460000"
}
```

- **`abilities[f]`** = `'edit'` iff `f ∈ permit(ctx, ctrl, record)`, else
  `'view'` iff `f ∈ expose`, else absent. The mask can only **narrow** the
  ceiling — the UI consumes permissions; it never creates them.
- **`can[event]`** — server-computed verdict for every
  [`Attr.state`](/models/state-machines) event, with full data. Generated
  client `can()` only ever narrows this.
- **`version`** — optimistic-lock token derived from `updatedAt`.

## Optimistic locking

PATCH echoes `version`. A stale token means the record changed under the
form → **409 Conflict**, nothing saved. The client should refetch and retry —
never silently overwrite.

## Stripped writes are reported

When the envelope is on, a PATCH containing non-permitted fields still strips
them (server-authoritative), and the response carries:

```jsonc
{ …envelope, "issues": [{ "field": "amount", "code": "forbidden" }] }
```

## `_event` — submit as transition

A PATCH may carry `_event` alongside the diff:

```jsonc
{ "amount": 250000, "_event": "submit" }
```

The server applies the permitted diff, checks the transition guard with full
data, and fires the event **in the same save** — there is no
saved-but-not-transitioned limbo. A blocked event → 422 with a
`transition_blocked` base error, and nothing is saved.

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
