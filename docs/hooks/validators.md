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

## Implicit validations from the schema

Some validations you never write — the drizzle schema already declares
them, and `validate()` derives them automatically:

| Schema declaration | Implicit validation | Instead of |
| --- | --- | --- |
| `.notNull()` (no default) | `can't be blank` | PG `23502 not_null_violation` |
| `varchar('x', { length: 80 })` | `is too long (maximum is 80 characters)` | PG `22001 string_data_right_truncation` |
| `smallint` / `integer` / `bigint` | `must be between -32768 and 32767` … | PG `22003 numeric_value_out_of_range` |

```ts
// schema: title: varchar('title', { length: 80 }).notNull()
const post = new Post({}, true)
await post.validate()          // → false
post.errors.on('title')        // → ["can't be blank"] — no PG round-trip
```

The rules mirror what the database would actually enforce:

- **New records** check every column; **persisted records** check only the
  columns being written (partial `SELECT`s stay safe).
- Columns with a DB default, an Attr `default`, identity/serial generation,
  or primary keys are exempt — anything the database or `save()` fills.
- The STI `type` discriminator is exempt (stamped during save).
- Opt a model out entirely with `static implicitValidations = false`.

One ordering caveat: lifecycle hooks (`@beforeSave`, `@beforeCreate`) run
*after* validation. A NOT NULL column filled inside one of those hooks will
false-positive — fill it in `beforeValidate` instead, or opt the model out.

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
