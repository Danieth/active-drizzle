# Declarative Validators — `Validates`

The Rails validator set, as composable factories you attach to any Attr.
Rails names, Rails default messages, Rails options — declared where the
field is declared.

```ts
import { ApplicationRecord, model, Attr, Validates } from 'active-drizzle'

@model('invoices')
export class Invoice extends ApplicationRecord {
  static status = Attr.enum({ draft: 0, sent: 1 } as const)

  static title = Attr.string({
    validates: [
      Validates.presence({ if: (r) => r.isSent() }),   // conditional, reads record state
      Validates.length({ min: 3, max: 80 }),
    ],
  })

  static amount = Attr.money('amountCents', {
    validates: Validates.numericality({ greaterThan: 0 }),  // sees DOLLARS, not cents
  })

  static contact = Attr.string({ validates: Validates.email({ allowBlank: true }) })

  static slug = Attr.string({
    serverValidates: Validates.uniqueness({ scope: 'tenantId' }),  // async, DB-backed
  })
}
```

Validators run inside `record.validate()` alongside your `@validate`
methods; failures land in `record.errors` under the field name.

## The validators

| Validator | Checks | Default message |
| --- | --- | --- |
| `presence()` | not null / `''` / whitespace / `[]` | `can't be blank` |
| `absence()` | the inverse | `must be blank` |
| `length({ min, max, is })` | string or array length | `is too short (minimum is X characters)` … |
| `numericality({ … })` | `onlyInteger`, `greaterThan(OrEqualTo)`, `lessThan(OrEqualTo)`, `equalTo`, `otherThan`, `odd`, `even`, `in: [lo, hi]` | `is not a number`, `must be greater than X` … |
| `format({ with, without })` | regex match / non-match | `is invalid` |
| `inclusion({ in })` | value ∈ list (or `(record) => list`) | `is not included in the list` |
| `exclusion({ in })` | value ∉ list | `is reserved` |
| `confirmation()` | equals `<field>Confirmation` on the record | `doesn't match <field>` |
| `comparison({ … })` | orders against literals, Dates, or `(record) => value` | `must be greater than X` |
| `acceptance({ accept })` | checkbox truthiness (`true`, `'1'`, `'on'`, …) | `must be accepted` |
| `email()` / `url()` / `uuid()` / `timezone()` | shape checks | `is not a valid email` … |
| `uniqueness({ scope })` | **async** — queries the table; put it in `serverValidates` | `has already been taken` |

## Shared options

Every validator accepts:

```ts
{
  message?: string                    // override the default
  if?: (record) => boolean            // only validate when true
  unless?: (record) => boolean        // skip when true
  allowNull?: boolean                 // skip null/undefined (allow_nil)
  allowBlank?: boolean                // skip null/''/whitespace/[] (allow_blank)
  on?: 'create' | 'update'            // gate by INSERT vs UPDATE
}
```

The `if`/`unless` predicates receive the live record, so enum predicates,
state-machine checks, and any other field are available:

```ts
Validates.presence({ if: (r) => r.isDraft() && r.amount > 1000 })
Validates.comparison({ greaterThan: (r) => r.startsAt })   // endsAt > startsAt
```

## One divergence from Rails

Every validator except `presence`/`absence` **skips null**. Requiredness is
`presence()`'s job — compose it explicitly:

```ts
// Rails: length errors on nil. Here: null passes length, presence catches it.
validates: [Validates.presence(), Validates.length({ min: 3 })]
```

This keeps conditional schemas honest: an optional field validates its
format only when it has a value.

## Uniqueness caveat

`Validates.uniqueness()` is an application-level check, race-prone by
nature (same as Rails). Keep the real `UNIQUE` index in the schema — the
validator gives you the friendly message, the index gives you the
guarantee.

## Hand-written validators still compose

A validator is just `(value, record, key) => string | null`. Mix your own
into the same array:

```ts
validates: [
  Validates.presence(),
  (v, record) => (record.isSent() && v === 'DRAFT' ? 'cannot be DRAFT once sent' : null),
]
```

For imperative, multi-field validation, `@validate` methods remain the
right tool — see [Validations](/hooks/validations).
