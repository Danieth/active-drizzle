# State Machines (`Attr.state`)

`Attr.state` is an enum with a transition graph. Declare the states, the legal
moves between them, and guards — the record gains predicates, event methods,
`can()`, and `advance()`, all synthesized. Illegal jumps can never persist.

```ts
@model('loans')
export class Loan extends ApplicationRecord {
  static status = Attr.state({
    states: { draft: 0, submitted: 1, approved: 2, rejected: 3 } as const,
    initial: 'draft',
    transitions: {
      submit:  { from: ['draft'],     to: 'submitted' },
      approve: { from: ['submitted'], to: 'approved',
                 if: (r) => r.amount != null, message: 'needs an amount' },
      reject:  { from: ['submitted'], to: 'rejected' },
      reopen:  { from: '*',           to: 'draft' },
    },
  })
}
```

For text columns, pass the states as an array — labels are stored as-is:

```ts
static stage = Attr.state({
  states: ['open', 'closed'],
  initial: 'open',
  transitions: { close: { from: ['open'], to: 'closed' } },
})
```

## What the record gains

Everything below is synthesized — there is nothing to write.

```ts
loan.status                 // 'draft' — label in, label out (like Attr.enum)
loan.isDraft()              // true
loan.can('submit')          // true  — state ∈ from AND guard passes
loan.canSubmit()            // same, per-event sugar
loan.submit()               // assigns 'submitted' if legal → true; else false. Does NOT save.
await loan.advance('submit')  // submit() + save() in one call → boolean
```

### `advance(event)` — move the machine forward

The one-liner for "fire and persist":

```ts
if (await loan.advance('approve')) {
  // transitioned + saved, hooks fired
} else {
  loan.errors.all()   // { status: ['needs an amount'] }
}
```

An illegal event returns `false` immediately — with the reason on `errors` and
**no database round-trip**.

## Direct assignment stays legal — validation is the gate

The Attr contract is *assign anything, validate on save*. You can write
`loan.status = 'approved'` directly; `validate()` then checks that some legal
transition path allows the move (guards included):

```ts
loan.status = 'approved'      // draft → approved: no transition allows this
await loan.save()             // → false
loan.errors.all()             // { status: ["cannot approve from 'draft'"] }
```

Rules at save time:

- **New records skip the check** — creation may start in any state (imports,
  seeds, tests).
- A `null` previous state may enter the machine anywhere (records that predate
  the machine).
- Reassigning the current state is a no-op, not an error.

## Guards

`if:` is a **pure predicate over the record** — never roles or identity (those
live on the controller; codegen enforces this). Guards run:

- in `can()` / `canSubmit()` (UI enablement)
- in event methods and `advance()`
- at save time, when validating direct assignment

Codegen infers which fields a guard reads (`if: (r) => r.amount != null` →
deps: `['amount']`). An unanalyzable guard is a **build error** — declare the
fields explicitly to override:

```ts
approve: { from: ['submitted'], to: 'approved',
           if: (r) => complexCheck(r), deps: ['amount', 'adminCap'] },
```

## Hooks compose — no special callbacks

Transitions are just saves, so lifecycle hooks work unchanged. React to a
transition with a conditional hook:

```ts
@beforeUpdate({ if: 'statusChanged' })
async onTransition() {
  if (this.isSubmitted()) await Mailer.notifyReviewers(this)
}
```

For post-commit side effects use `@afterCommit` and read `previousChanges`.

## What codegen ships to the client

- **Types**: `loan.status` is `'draft' | 'submitted' | …`, `can()`/`advance()`
  are typed by the event union, `canSubmit()`/`submit()` are declared.
- **Client `can(event)`**: generated Clients get a `can()` that checks the
  current state and inlines guards **only when their deps fit that
  controller's projection** — a guard the client can't evaluate makes `can()`
  return `false` (fail-closed). The server's [abilities envelope](/controllers/abilities)
  `can` map is always the source of truth; the client only narrows it.
- **`schema.md`**: the full graph is documented per model in the generated
  schema reference.

## Firing transitions over the wire

On [envelope controllers](/controllers/abilities), a PATCH may carry
`_event` — the server applies the field diff, checks the guard with full data,
and fires the transition **in the same save**. See
[Abilities & Forms envelope](/controllers/abilities#_event-submit-as-transition).

## Definition-time validation

Bad graphs fail at class load (and again at build time with a file path):

- transition targeting or allowing an unknown state
- `initial` not a declared state
- an event name colliding with a built-in record member (`save`, `update`,
  `destroy`, `can`, `advance`, …)
