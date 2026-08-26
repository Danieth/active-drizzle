<p align="center">
  <img src="docs/public/logo.svg" width="80" height="80" alt="ActiveDrizzle logo" />
</p>

<h1 align="center">ActiveDrizzle</h1>

<p align="center">
  <strong>Rails-style ActiveRecord for Drizzle ORM.</strong><br/>
  Associations. Lifecycle hooks. Dirty tracking. State machines. Full TypeScript codegen.<br/>
  <em>Write three files. Get a full-stack feature.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@active-drizzle/core"><img src="https://img.shields.io/npm/v/@active-drizzle/core?style=flat-square&color=3B82F6&label=core" alt="npm core"></a>
  <a href="https://www.npmjs.com/package/@active-drizzle/controller"><img src="https://img.shields.io/npm/v/@active-drizzle/controller?style=flat-square&color=3B82F6&label=controller" alt="npm controller"></a>
  <a href="https://www.npmjs.com/package/@active-drizzle/react"><img src="https://img.shields.io/npm/v/@active-drizzle/react?style=flat-square&color=3B82F6&label=react" alt="npm react"></a>
  <a href="https://github.com/Danieth/active-drizzle/actions"><img src="https://img.shields.io/github/actions/workflow/status/Danieth/active-drizzle/ci.yml?style=flat-square&label=tests" alt="CI"></a>
  <a href="https://danieth.github.io/active-drizzle/"><img src="https://img.shields.io/badge/docs-live-blue?style=flat-square" alt="Docs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

---

Today, adding a feature to a typical TypeScript app means touching **8–12 files**. Schema. Drizzle table. Backend types. API route. Validation logic. Frontend types (duplicated). Fetch function. React Query hook. Cache key. Optimistic update logic. Form validation (duplicated again). Component.

**With ActiveDrizzle, you touch three.**

```
Schema → Model → Controller → done.
```

Everything else — oRPC procedures, Zod schemas, React Query hooks, TypeScript types, form configs, cache invalidation — is generated at build time by a Vite plugin.

> **[Read the full documentation →](https://danieth.github.io/active-drizzle/)**

---

## The Big Picture — a mental model

> Read this section before reading any code. The fastest way to get lost in
> ActiveDrizzle — as a human or as an LLM — is to assume it works like the
> libraries it resembles. It is not "Drizzle plus helpers," and it is not
> "an ORM with codegen bolted on." It is a **small compiler wrapped around a
> runtime**, and both of them read the same three files you write. Every
> metaphor below is immediately followed by the literal mechanic it stands
> for, so you can zoom out without losing precision.

### 1. One score, three orchestras

A model file looks like ordinary code:

```ts
@model('deals')
export class Deal extends ApplicationRecord {
  static status = Attr.state({ states: ['draft', 'open', 'won'], initial: 'draft', transitions: { … } })
  static amount = Attr.money('amountCents', { label: 'Deal Amount' })
  static notes  = hasMany('notes', { acceptsNested: true })
}
```

It is actually a **musical score performed by three different orchestras**:

1. **The runtime** (`@active-drizzle/core`) *executes* it. Each static field
   evaluates to an inert declaration object (`{ _isAttr: true, _type: 'state', … }`).
   Records consult these declarations to decide how to behave — the
   declarations are never "used" directly by you.
2. **The build-time extractor** (the Vite plugin, via ts-morph) *reads the
   source text* — the AST, not the running program — and learns the same
   facts without ever importing or executing your module.
3. **The TypeScript compiler** consumes the *generated declarations*
   (`.gen.d.ts`) that the extractor produces, so your editor knows things the
   type system could never infer on its own (proxy-synthesized methods,
   state-label unions, association shapes).

Same notes, three performances. This is the single most important fact about
the framework, and everything below follows from it:

- **Meta positions must be literals.** Labels, enum maps, state lists,
  `copy:` blocks — the extractor reads with its *eyes*, not its *hands*. If a
  value can't be read statically, extraction **fails closed** (an error, not a
  guess). Never compute meta at runtime and expect codegen to see it.
- **The generated types are a painted shadow.** TypeScript cannot see what a
  Proxy will synthesize at runtime, so the generator paints the shadow by
  hand into `.gen.d.ts`. Shadow and puppet must always match: when behavior
  changes, **regenerate** — never hand-edit a `.gen.*` file, and never trust
  one that's stale.

### 2. The river of truth

Truth flows in exactly one direction. Nothing downstream is authoritative;
every layer refines the one above it.

```
db/schema.ts        the RIVERHEAD — column truth: names, types, nullability, defaults, CHECKs
      │
      ▼
*.model.ts          DECLARATIONS — behavior, vocabulary, state machines, associations, meta
      │
      ▼
*.ctrl.ts           DOORS — who may read/write which fields; which actions/mutations exist
      │
      ▼  vite plugin:  extract (ts-morph) → validate → generate → write-if-changed
*.gen.*             THE DELTA — everything you did NOT write: types, clients, routers,
      │             hooks, form configs, .active-drizzle/schema.md
      ▼
React               presenters render fields; the SAME JSX is edit-or-view per the
                    server's abilities mask
```

If two layers ever disagree, the one upstream wins, and the fix is to
regenerate downstream — never to patch downstream by hand.

### 3. The land registry (how names work)

Think of every schema export as a **parcel in a land registry**. The export
identifier (`bidCovenants`) is the parcel's *registered name*; the SQL string
inside `pgTable('bid_covenants', …)` is merely the *surveyor's coordinates*
on the deed.

**Everything in the framework refers to parcels by registered name**: the
schema object you pass to `boot()`, Drizzle's `db.query.*`, the `@model('…')`
decorator, association targets (`hasMany('bidCovenants')`), and `through:`
join tables. The SQL name appears in exactly one place — the `pgTable()`
call — and nowhere else. If you ever see a SQL-style snake_case name being
used as a lookup key outside the schema file, it is a bug.

### 4. Records are marionettes (the proxy)

A record instance is a **marionette: nothing on it is carved**. `deal.amount`
(cents → dollars), `deal.isDraft()`, `deal.canSubmit()`, `deal.nameChanged()`,
`deal.notes` — every one of these is a string pulled at the moment you touch
it, synthesized by a Proxy that consults the static declarations and the
booted schema. Consequences:

- If a helper seems "missing," the puppet couldn't *see* the declaration —
  the model wasn't imported/registered, or (for STI) a scan didn't walk the
  prototype chain. The fix is never "write the missing method by hand."
- Assignment is always allowed; **legality is enforced at `save()`**
  (assign-anything, validate-on-save — Rails semantics). An illegal state
  jump can be *assigned* but can never *persist*.

### 5. Families and crests (STI)

Single Table Inheritance: one table, many families.

```ts
@model('rfps') export class Rfp extends ApplicationRecord { static status = Attr.state({ … }) }
@model('rfps') export class TermLoanRfp extends Rfp { static stiType = 'TermLoan' }
```

The **family crest** — state machines, associations, validators, attrs — is
declared once on the parent and passes down the **bloodline** (the prototype
chain). Two laws keep the family honest:

- **A census must walk the family tree.** Any code that scans a class's
  statics must traverse the constructor chain (`modelStaticEntries()` in
  core), because an own-properties-only scan sees an empty-handed child —
  a `TermLoanRfp` whose only own static is `stiType`.
- **The eldest owns the estate.** The base class holds the registry's
  by-*table* slot (association inference resolves through it); subclasses
  register by *class name* only, and auto-inject `WHERE type = <stiType>`
  into their own queries. A subclass must never clobber the base's table
  slot — that silently scopes every association to one arbitrary subtype.

### 6. The model allows; the door gates (controllers)

A model is an **engine** — the complete set of things that *can* happen. A
controller is a **door** into the building, and doors are where authorization
lives:

- `expose` — which rooms are visible through the window (the read ceiling;
  fields not exposed never leave the server).
- `permit` — which slots exist in the letterbox (the write surface; can be a
  function of the acting user *and the record*: `deal.isDraft() || user.isAdmin()`).
- `abilities` — the **wristband** handed to each visitor, listing per-field
  edit/view rights and state-machine verdicts (`can('submit')`).
- `autoSet` / `nestedAutoSet` — fields stamped *at the door* from the
  session (owner ids, actor ids). Never trusted from the visitor, even when
  smuggled inside nested child rows.
- `@mutation` / `@action` — extra doors on the same building: member actions
  (auto-load the record from the *scoped* relation) and collection actions,
  with derived routes and generated client hooks.

The same model may stand behind **several different doors** — an admin door
and a member door with different rules — and UI pickers point at a *door*,
not a model, so the door decides what is pickable. **Capability on the model
is never authorization. Authorization is the door's job, enforced
server-side.**

### 7. The envelope and the wristband (why forms lock themselves)

Records leave a door inside an **envelope**: the record, a version token
(optimistic locking — a stale write returns 409 plus the fresh envelope),
and the wristband (abilities). The generated form reads the wristband — not
its own opinions. That is why *the same JSX* renders an editable input for a
field you may edit and read-only text for one you may not, and why a save
that narrows your permissions makes the form **lock itself**: the next
envelope simply came back with a smaller wristband.

### 8. Sockets, not appliances (presenters)

The framework ships **wall sockets; your app brings the appliances**.
`@active-drizzle/react` exposes `registerPresenter`, `setDefaultPresenters`,
and the `PresenterProps` contract — and deliberately ships **zero
components**. Your app registers its own kit (see the demo's
`src/presenters.tsx`).

Resolution is by **`kind`**, and kind is *derived from the model*: `Attr.money`
→ `money`, `Attr.state` → `state`, `Attr.array` → `array` — and **refined by
validators**: `Validates.email()` on a plain string upgrades its kind to
`email`, so the email presenter picks it up with no wiring. Field labels,
help text, and per-discriminant `copy:` overrides ride along as `meta`.

Presenters receive `{ value, bind, meta, overrides, errors, dirty }` and stay
**dumb about persistence**: they render the value and wire
`bind.onChange/onBlur/onCommit`. Staging, autosave, optimistic writes, and
nested saves all live behind `bind`, inside the framework. Association
pickers plug into a **door** (`props={{ from: UserController }}`), so the
door's search/permit rules decide what appears in the dropdown.

### 9. One PATCH saves a tree

`hasMany('notes', { acceptsNested: true })` means a parent save carries its
children (and grandchildren) in a **single PATCH** — Rails'
`accepts_nested_attributes_for`, with types, including `allowDestroy` and
ordered collections. `hasOne` opts in the same way, singular:
`briefAttributes` is one object, not an array, and an id-less write when a
child already exists **updates that row** — a second row can never appear.
The letterbox rule still applies: `notesAttributes` must
be in the door's `permit`, or the server strips every nested write — and
codegen refuses to emit the nested form at all.

### 10. The invariants (a checklist for humans and LLMs)

If you internalize nothing else, internalize these. Violating any one of
them is the root cause of essentially every confusing bug:

1. **Names are schema export identifiers, everywhere.** `@model()`,
   association targets, `through:`, `boot()`'s schema object, `db.query.*`.
   The SQL name lives only inside `pgTable()`.
2. **Codegen reads source, never executes it.** Meta must be literal;
   non-literal meta fails closed. Don't expect codegen to see computed
   values, and don't narrate around it — fix the declaration.
3. **Static Attr/association fields are declarations consumed by three
   readers** (runtime, extractor, type system). They are not values; don't
   call them, don't mutate them.
4. **Records are Proxies.** Missing helper ⇒ invisible declaration
   (registration or prototype-chain issue), not missing code.
5. **STI statics inherit through the prototype chain**; every static scan
   must walk it. The base class owns the registry's by-table slot.
6. **Never hand-edit `.gen.*` files** — regenerate (`vite` dev loop or a
   headless `buildStart()` script). A stale shadow lies to the compiler.
7. **Generated declarations cannot share a basename with a generated `.ts`.**
   `X.model.gen.d.ts` beside `X.model.gen.ts` is silently dropped by tsc as
   presumed build output — which is why type declarations are emitted as
   `X.model.types.gen.d.ts`, and why `_globals.gen.d.ts` must remain
   import/export-free (ambient): module-augmentation blocks cannot import,
   so cross-model names resolve through globals.
8. **Model allows, controller gates.** Model-level capability is never
   authorization. Every write surface is `permit`ed at a door;
   context-derived fields are forced via `autoSet`/`nestedAutoSet`.
9. **Presenters are dumb about persistence.** Value + bind only. If a
   presenter is doing fetching/saving logic beyond its `bind` and its `from`
   door, it's wrong.
10. **Import models through `models/index.ts` and `boot(db, schema)` before
    any query.** Registration is a side effect of import; ESM elides unused
    imports, so a model referenced only via associations must still be
    exported from the index.

### 11. The map of the territory

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Your three files                             │
│   db/schema.ts        src/models/*.model.ts       src/controllers/*.ctrl.ts
├─────────────────────────────────────────────────────────────────────────┤
│                 Vite plugin — the compiler (build time)                 │
│   extractor.ts  → reads schema + model + controller source (ts-morph)   │
│   validator.ts  → cross-checks everything (assocs, columns, STI, meta)  │
│   generator.ts  → emits the delta, write-only-if-changed                │
├─────────────────────────────────────────────────────────────────────────┤
│  Generated, per model:            Generated, per project:               │
│   X.model.types.gen.d.ts           _registry.gen.ts   (registration)    │
│     (the painted shadow)           _globals.gen.d.ts  (ambient aliases) │
│   X.model.gen.ts                   .active-drizzle/schema.md            │
│     (isomorphic X.Client)            (LLM-optimized schema reference)   │
│  Generated, per controller:                                             │
│   routers, typed clients, React Query hooks, form hooks                 │
├────────────────────────────┬────────────────────────────────────────────┤
│   @active-drizzle/core     │   @active-drizzle/controller               │
│   runtime: Proxy records,  │   doors: @crud/@mutation/@action,          │
│   Relation, Attr, hooks,   │   expose/permit/abilities, envelopes,      │
│   state machines, STI      │   optimistic locking, oRPC/REST adapters   │
├────────────────────────────┴────────────────────────────────────────────┤
│   @active-drizzle/react — sockets: registerPresenter, form handles,     │
│   nested collections, staging/autosave, React Query integration         │
├─────────────────────────────────────────────────────────────────────────┤
│                        Drizzle ORM → PostgreSQL                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 12. If you are an LLM working in this codebase

- **In a consumer app**: read `.active-drizzle/schema.md` first — it is
  generated *for you* and lists every model, column, enum, association,
  scope, and hook. Trust it over your priors.
- **Diagnosis order** for "X doesn't work": (1) was the model exported from
  `models/index.ts`? (2) was `boot()` called? (3) is the name an export
  identifier, not a SQL name? (4) is the declaration on an STI parent and
  the consumer scanning own-properties only? (5) are the `.gen.*` files
  stale? Regenerate before theorizing.
- **Never** "fix" a symptom by hand-writing what codegen should emit, by
  editing a `.gen.*` file, or by adding a method the Proxy should
  synthesize. Fix the declaration or the generator.
- The demo app (`active-drizzle-demo`) is the living reference for the full
  loop — model → controller → generated hooks → presenters — including
  nested forms, ability-locked JSX, and door-scoped pickers.

---

## Install

```bash
npm install @active-drizzle/core @active-drizzle/controller @active-drizzle/react
```

Or scaffold a working app in one command — see [Quick Start](#quick-start):

```bash
npx @active-drizzle/trails new myapp
```

## The Three Files

### 1. Schema — your Drizzle table (you already have this)

```ts
// db/schema.ts
export const campaigns = pgTable('campaigns', {
  id:        serial('id').primaryKey(),
  teamId:    integer('team_id').notNull().references(() => teams.id),
  name:      varchar('name', { length: 255 }).notNull(),
  status:    integer('status').notNull().default(0),
  budget:    integer('budget'),
  startDate: timestamp('start_date'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

### 2. Model — your business logic

```ts
// models/Campaign.model.ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static team    = belongsTo()
  static creator = belongsTo('users', { foreignKey: 'creatorId' })
  static status  = Attr.enum({ draft: 0, active: 1, paused: 2, completed: 3 } as const)

  @scope static active() { return this.where({ status: 1 }) }
  @scope static search(q: string) { return this.where({ name: ilike(`%${q}%`) }) }

  @pure isEditable() { return ['draft', 'paused'].includes(this.status) }
}
```

### 3. Controller — your HTTP API

```ts
// controllers/Campaign.ctrl.ts
@controller('/campaigns')
@crud(Campaign, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),
  index:   { scopes: ['active'], sortable: ['createdAt', 'name'], include: ['creator'] },
  create:  { permit: ['name', 'budget', 'status'], autoSet: { creatorId: ctx => ctx.userId } },
  update:  { permit: ['name', 'budget', 'status'] },
})
@scope('teamId')
export class CampaignController extends OrgController {
  @mutation()
  async launch(campaign: Campaign) {
    if (!campaign.isEditable()) throw new BadRequest('Cannot launch')
    campaign.status = 'active'
    campaign.startDate = new Date()
    return campaign.save()
  }
}
```

### What you get (generated)

Save those three files. Your terminal shows:

```
✓ Campaign.model.ts  → Campaign.model.types.gen.d.ts (2 scopes, 4 enum values, 2 associations)
✓ Campaign.ctrl.ts   → campaign.router.gen.ts  (7 routes: index, get, create, update, destroy, launch)
✓ Campaign.ctrl.ts   → Campaign.client.gen.ts  (React Query hooks, form config, typed client model)
✓ _routes.gen.ts updated (7 new endpoints)
```

You now have:
- **Full REST API** with nested routes, scoping, and Zod validation
- **oRPC procedures** for type-safe client-server calls
- **React Query hooks** with cache invalidation
- **A typed client model** with enum predicates, dirty tracking, and inline validation
- **TypeScript types everywhere** — columns, associations, write shapes, read shapes

### Use it in React

```tsx
import { CampaignController } from '@gen/controllers'

function CampaignsPage({ teamId }: { teamId: number }) {
  const ctrl = CampaignController.use({ teamId })

  const { data } = ctrl.index({ scopes: ['active'], sort: { field: 'createdAt', dir: 'desc' } })
  const launch = ctrl.mutateLaunch()

  return data?.items.map(c => (
    <div key={c.id}>
      <h3>{c.name}</h3>
      <span>{c.status}</span>  {/* 'active' | 'draft' | 'paused' — not an integer */}
      {c.isEditable() && (
        <button onClick={() => launch.mutate(c.id)}>Launch</button>
      )}
    </div>
  ))
}
```

---

## Why ActiveDrizzle?

### vs. plain Drizzle

Drizzle is a great query builder. ActiveDrizzle sits on top of it and adds everything you keep rebuilding by hand:

| You keep writing... | ActiveDrizzle gives you |
|---|---|
| `db.select().from(assets).where(eq(assets.teamId, teamId))` | `Asset.where({ teamId })` |
| Manual enum maps + helper functions | `static status = Attr.enum({ draft: 0, active: 1 })` → `asset.isActive()` |
| Hand-rolled status columns + guard `if`s | `Attr.state({ states, transitions })` → `deal.canSubmit()`, `await deal.advance('submit')` |
| No dirty tracking | `asset.nameChanged()`, `asset.nameWas()`, `asset.changedFields()` |
| No associations | `belongsTo()`, `hasMany()`, `hasOne()`, `habtm()` — lazy-loaded |
| No lifecycle hooks | `@beforeSave()`, `@afterCommit()`, `@validate()` |
| N+1 queries by default | `User.includes('posts', 'avatar').load()` — one query |
| Copy-paste validation everywhere | Define once in the model, enforced on server + generated for forms |

### vs. Prisma

| | Prisma | ActiveDrizzle |
|---|---|---|
| Query builder | Prisma Client (generated) | Drizzle (you own the SQL) |
| Schema source | `schema.prisma` DSL | Standard Drizzle `pgTable()` |
| Associations | Implicit via schema | Explicit: `belongsTo()`, `hasMany()` |
| Lifecycle hooks | Middleware (limited) | Full Rails-style hooks with conditions |
| Dirty tracking | None | Built-in |
| Enum transforms | Mapped enums only | Integer ↔ label or plain text, with predicates |
| State machines | None | `Attr.state` with guards, typed events, client `can()` |
| Frontend codegen | None | React Query hooks, form configs, typed clients, presenters |
| STI | Not supported | Full Single Table Inheritance |

### vs. Rails ActiveRecord

| | Rails | ActiveDrizzle |
|---|---|---|
| Language | Ruby | TypeScript |
| Type safety | Runtime only | Compile-time via codegen |
| Error discovery | Production at 3am | Build step catches it |
| Frontend | Separate API + separate types | Generated typed hooks from the same model |
| Performance | Ruby | V8 + Drizzle SQL |

ActiveDrizzle catches at **build time** what Rails only finds at runtime:

```
ERROR  Campaign.model.ts — Association "assets": column "campaignId" not found on table "assets"
ERROR  TextMessage.model.ts — Enum "status": expects INTEGER column but found "text"
WARN   Campaign.model.ts — no bidirectional belongsTo found on Asset
```

---

## Features

### Models

- **Chainable queries** — `.where()`, `.order()`, `.limit()`, `.includes()`, `.pluck()`, `.count()`, plus `.whereAny([...])` (one flat OR), `.orderByIds()`, `.groupByTime('createdAt', 'week')`; `where` hashes take `{ gte, lte, gt, lt, ne, nin, all }`, with bounds run through the Attr codecs
- **Associations** — `belongsTo`, `hasMany`, `hasOne`, `habtm`, with `through:` (+ `source:` / `sourceForeignKey` to resolve the key off the through model), `dependent: 'destroy'`, `counterCache`, `autosave`, polymorphic `belongsTo` **and its inverse**: `hasMany('comments', { as: 'commentable' })` scopes by both columns (`commentableId` AND `commentableType`), so same-id parents of different types never leak into each other
- **Association-scoped writes** — `deal.comments.create({ body })` / `.build()` stamp the owner's foreign key (and polymorphic type). `through`/`habtm` relations carry no defaults — create the join row through its own model, or sync habtm via `<singular>Ids`
- **Concerns** — `@include(SoftDeletable, Sluggable({ from: 'title' }))`; built-ins (`SoftDeletable`, `Sluggable`, `Publishable`, `Trackable`) plus `defineModelConcern` for your own, all on the `@active-drizzle/core` main entry
- **Attr transforms** — `Attr.enum()`, `Attr.state()`, `Attr.money()`, `Attr.percent()`, `Attr.range.*()` / `Attr.multirange()` (PG ranges), `Attr.array()`, `Attr.json<T>()`, `Attr.string()`, `Attr.boolean()`, `Attr.date()`, `Attr.new({ get, set })`
- **State machines** — `Attr.state({ states, initial, transitions })` with guards and messages; integer or readable-text storage; synthesized `is<Label>()`, `can<Event>()`, `<event>()`, `advance()`
- **Declarative validators** — the Rails `Validates.*` set attached where the field is declared; shippable validators also run in the browser
- **Dirty tracking** — `isChanged()`, `changedFields()`, `fieldWas()`, `fieldChanged()`
- **Lifecycle hooks** — `@beforeSave`, `@afterCommit`, `@beforeDestroy`, `@validate`, with `{ if: }` conditions
- **Scopes** — `@scope static active() { ... }` → chainable, composable named queries
- **STI** — `static stiType = 'TermLoan'` → auto-scoped queries, correct subclass instantiation, inherited statics through the prototype chain. Every subclass needs its own `@model('<base table>')` — `stiType` without `@model` is a codegen error naming the fix, with a once-per-(table, value) dev warning as runtime backstop
- **Transactions** — `ApplicationRecord.transaction(async () => { ... })` via `AsyncLocalStorage`
- **Nested attributes** — `hasMany`/`hasOne` with `acceptsNested: true | { allowDestroy: true }` → create/update/destroy children in one save
- **Custom primary keys** — composite keys, non-`id` columns
- **Multi-database** — the framework owns binding, not connections: `bindDatabase('analytics', analyticsDb, { events })` routes per table (`getExecutor(table)`); `transaction()` takes `{ database }` and never captures queries against other databases. Cross-database associations/includes are unsupported by design

### Controllers

- **`@crud`** — index, get, create, update, destroy from one decorator
- **`@mutation`** — auto-loads record by `:id`, passes to method. `{ bulk: true, records: false }` for efficient mass updates; `optimistic` + typed `returns`; `{ if, label, params, required, hint }` declare the full interaction contract (see [Mutation Buttons](#mutation-buttons))
- **`@action`** — custom GET/POST endpoints; `{ load: true }` for member actions on the scoped relation
- **`@before` / `@after`** — lifecycle hooks with `{ only: }`, `{ except: }`, `{ if: }` conditions
- **`@rescue`** — Rails-style error handling. `RecordNotFound` → 404 automatically
- **`@scope`** — URL nesting: `@scope('teamId')` → `/teams/:teamId/campaigns`
- **`scopeBy`** — scope queries from resolved controller state (multi-tenant)
- **`expose` / `abilities`** — the read ceiling + the per-field wristband the client renders from
- **`autoSet` / `nestedAutoSet`** — stamp fields from context on create; nested child rows can't forge them
- **Dynamic `permit`** — `(ctx, ctrl, record) => string[]` for role- and record-aware field access
- **Optimistic locking** — `update: { optimisticLock: true }` versions on `updatedAt` (the model must touch it on save); a numeric field name (`'lockVersion'`) auto-increments server-side instead. Every envelope carries an opaque `version`, the generated form echoes `_version` on every submit, a mismatch is a **409** carrying the server's current envelope (recovery needs no extra round-trip), and a PATCH without `_version` skips the check — pre-lock clients keep working
- **Index allowlists** — `index: { searchable, filterable, sortable, filters, facets, chartable, measures }`: everything the wire may narrow or aggregate by is declared server-side; an undeclared param is a 400, never a silent no-op. Named `filters` keep product semantics on the server via `apply: (rel) => …`; `$or` is the one cross-field combinator (depth-1, allowlisted branches, codec-run values, max 10 branches, no nesting) and the whole group ANDs onto the door-scoped relation — narrowing only
- **Facet counts** — computed only when a request asks (`facets: true | ['stage']` param); the config is the ceiling (requested ∩ allowed; asking a non-offering index is a 400). Counts are disjunctive (own filter excluded) with label keys
- **Aggregates over the wire** — `chartable` + `measures` allowlist `chart: { x, y: 'count'|'sum:F'|'avg:F' }` (+ `bucket:` time units via `groupByTime`) and `metric: 'sum:F'`; `perPage: 0` for aggregation-only calls
- **Picker feed** — `options: { value: 'id', label: 'name' }` returns the narrowed, sorted result projected to `[{ value, label }]` (an array — numeric object keys lose order), capped at `perPage`; both fields must sit under the expose ceiling
- **Search lanes** — `search: { adapter, doc }`: an external engine answers `?q=` with **ids in rank order and nothing else**; hydration returns through the door-scoped relation (a compromised engine cannot leak a field or a record the door wouldn't serve), order kept via `orderByIds`. Falls back adapter → PG FTS → ilike. `doc` is the one searchDoc transform — your afterCommit shipper and reindex script both call `buildSearchDoc`, so they can never drift
- **`emptyReason`** — empty index responses say why (`no-records` vs `no-matches`, one extra COUNT only when empty) so the client renders the right CTA
- **Contract probes** — `buildContractProbes(DealController)` derives the forge-every-field security suite from the same metadata that enforces it (undeclared filters, `$or` forging/nesting/cap, forged sort/chart/metric, non-permitted mass-assignment, missing required mutation params); `runContractProbes(probes, call)` runs it through any transport
- **Multi-tenant** — `this.state` with typed inheritance. Resolve org once, use everywhere

### React Integration

- **Generated hooks** — `ctrl.index()`, `ctrl.get(id)`, `ctrl.mutateCreate()`, `ctrl.mutateLaunch()`
- **Generated form handles** — every field is a component (`<deal.name edit />`); the same JSX renders edit or view per the server's abilities
- **Headless presenters** — `registerPresenter` / `setDefaultPresenters`; resolution by field kind derived from Attrs and refined by validators; the framework ships the socket, your app ships the kit
- **Nested collections** — `<deal.notes>{note => …}</deal.notes>` + `<deal.notes.Add />`, singular `<deal.brief>` + `<deal.brief.Build />`; one PATCH saves the tree (see [Nested Forms](#nested-forms))
- **Door-scoped pickers** — `props={{ from: UserController }}`; the controller's rules decide what's pickable
- **Error parsing** — 422 responses map to per-field errors; base errors surface via `<form.BaseErrors />`
- **Client model** — typed instances with predicates, dirty tracking, validation on the frontend
- **`recordOf()`** — unwrap a `get()` response door-agnostically: a door with `abilities: true` answers the envelope `{ record, abilities, can }`, one without answers the bare row — `recordOf(await Door.get({ id }))` works for both
- **Declarative gates** — `<deal.Can edit="amount">`, `<deal.Can action="markWon" not fallback={…}>`, plus `useAbilities` — gates over the same mask the server enforces; never hardcode `if (admin)` again
- **Read parity** — field members expose `.dirty` / `.elsewhere` / `.ability` beside `.value` / `.errors` / `.meta`
- **The escape hatch** — `buildFieldBind(session, opts)` is the exact bind generated fields wire (IME guards, commit staging, disable rules), and `useFieldProps(form, field)` assembles full live `PresenterProps` as a hook — novel compositions build against the real contract, never an imitation
- **Testing kit** — `createTestSession`, `buildTestProps`, `fieldStateFixtures` from `@active-drizzle/react/testing`: every presenter state (ready/dirty/saving/saved/error/pending/conflict/elsewhere/view) as a real session arranged into that state

### Nested Forms

`acceptsNested` opens the write surface; the door still governs it —
`notesAttributes` / `briefAttributes` must be in `permit`, or the server
strips every nested write and codegen refuses to emit the form.

```tsx
<deal.notes>{(note) => <note.body edit />}</deal.notes>
<deal.notes.Add>+ add note</deal.notes.Add>

<deal.brief>
  {(brief) => (
    <>
      <brief.summary edit />
      <brief.Remove>remove brief</brief.Remove>
    </>
  )}
</deal.brief>
<deal.brief.Build>+ add brief</deal.brief.Build>
```

- **The wire.** `hasMany` sends an array of rows; `hasOne` sends a single
  object: `{ summary }` creates, `{ id, summary }` updates
  (ownership-gated), `{ id, _destroy: true }` destroys (`allowDestroy`
  only). **Shape is arity** — an array sent for a hasOne, or a bare object
  for a hasMany, is a protocol violation and drops whole, fail-closed.
- **The singular invariant.** An id-less write when a child already exists
  updates that row (Rails' `update_only`, always on) — a second row can
  never appear, which makes autosave/double-save idempotent by construction.
- **Security.** A forged or foreign child id 422s before touching anything;
  the parent fk, timestamps, and STI `type` strip server-side; `nestedAutoSet`
  paths walk through singular nodes.
- **Programmatic surface.** `deal.brief.form` (child handle or null),
  `.exists`, `.build(defaults?)`, `.remove()`, `.use()`. Child validation
  gates the parent submit; server errors route as `brief.summary`. Singular
  children always stage into the parent save (no instant mode).
- **Create-from-picker is a recipe, not a feature.** The picker's `from`
  door already has `create`: a modal calls
  `UserController.with({}).mutateCreate({ data })`, invalidates the picker's
  queries, and `bind.onChange(created.id)` selects the new row. If this user
  can't create users, the door 403s — the modal just surfaces it. Works the
  same for habtm multi-pickers (`bind.onChange([...ids, created.id])`).

### Mutation Buttons

A controller mutation declares its whole interaction contract, and the form
handle grows a PascalCase member for it:

```ts
@mutation({ if: (deal) => deal.isSubmitted(), label: 'Mark won' })
async markWon(deal: Deal) { await deal.advance('win'); return this.envelope(deal) }

@mutation({ params: ['reason'], required: ['reason'], label: 'Send back',
            if: (deal) => deal.isSubmitted(), hint: 'Only submitted deals can be sent back' })
async sendBack(deal: Deal, data: { reason: string }) { /* … */ }
```

```tsx
<deal.MarkWon />                            {/* paramless → verdict-aware button */}
<deal.SendBack />                           {/* params → implicit mini-form (scaffolding) */}
<deal.SendBack fields={{ reason: 'dup' }}>Reject as dup</deal.SendBack>
<deal.SendBack>{({ run, allowed, pending, errors }) => /* … */ null}</deal.SendBack>
```

- **`if` is a guard, not a hint.** Its verdict rides the envelope's `can`
  map (the button greys itself per record) AND dispatch re-evaluates it — a
  forged POST gets `422 "markWon is not available"`.
- **`params` is a permit ceiling for the payload.** Undeclared keys strip
  before the method runs; missing `required` params 422 with per-field
  issues that land on the mini-form inputs.
- **Return `this.envelope(record)`** and the button folds fresh fields +
  verdicts straight into the live session — buttons re-grey the instant the
  stage flips, no refetch.
- **False verdicts ship a `why`.** State machines derive it from their own
  declaration ("requires stage 'submitted' (currently 'draft')", the
  transition's `message`); `@mutation` guards supply it via `hint:` (string
  or per-record function). Client side: `session.whyNot(action)`,
  `<deal.Can action>` function children get `{ allowed, why }`, buttons get
  `title`. Reasons are declared or derived — never inferred from permit
  lambdas.
- **Coherence and events included.** Every action fires the edge fan-out
  (index, aggregation headers, open forms refetch) and emits
  `{ type: 'action', action, ok }` on the global bus. Row handles get the
  same members inside `<Deals.Items>`; ungoverned rows default to allow and
  let the server gate.

### The Index Surface

The head is a component — no hooks in sight:

```tsx
<Deals.Index>
  <Deals.Search />                  {/* from index.searchable */}
  <Deals.Filters />                 {/* tier-1: enum → facet chips, boolean → toggle */}
  <Deals.Items>{(deal) => <deal.name view />}</Deals.Items>
  <Deals.Pagination />
</Deals.Index>
<Deals.One id={5}>{(form) => <form.Form>…</form.Form>}</Deals.One>
```

Everything is declared server-side, allowlisted, codec-normalized, and
narrowing-only. Tier-2 named filters keep product semantics on the server:

```ts
index: {
  searchable: ['name'],
  filterable: ['stage', 'priority', 'isFeatured'],
  facets: true,
  filters: { bigDeals: { label: 'Big deals', kind: 'toggle',
    apply: (rel) => rel.where({ amount: { gte: 20_000 } }) } },
}
```

Drive named filters from any widget via
`Deals.use().session.setFilter('bigDeals', true)` — change what "big" means
in the controller, no client redeploy. Individual placement:
`<Deals.Filters.stage />`. The raw hooks stay exported underneath.

- **`<Deals.Sidebar />`** — faceted search in one tag: groups from the
  declared filters, options zero-filled from the enum/state labels (an
  option matching nothing shows 0, dimmed, never vanishes), disjunctive
  counts that respond to every *other* active filter plus the live search,
  multi-select toggles (arrays → IN), `clearAll`. Engine-agnostic:
  whichever lane answered `q` — adapter, PG FTS, or ilike — the counts
  follow, because facets re-run the same narrowing pipeline. Headless via
  `SidebarApi`; counts require `index: { facets: … }` on the controller.
  `groups={[…]}` picks and orders; `presenters={{ … }}` or registered
  kind defaults take over any group's body.
- **`<Deals.Board>`** — the `Attr.state` machine as a kanban, data-only:
  states are columns (facet counts attached), `move(row, to)` resolves the
  declared transition and PATCHes `_event` (guards stay server-enforced),
  `canMove` exposes the transition graph for drag affordances. `groupBy`
  any facet field for a plain grouped board (moves PATCH the value).
- **`<Deals.Table>`** — the grid contract: columns from field meta
  (name/kind/label + sortable flags), rows, `setSort`, and the
  coherence-wired `mutateRow` for inline edits. Virtualization is
  deliberately yours.
- **`<Deals.Chart x="stage" y="sum:amount">{points => …}`** — paints your
  bars from `[{ x, y }]`; no chart lib shipped. `x="createdAt" bucket="week"`
  for time series (`date_trunc`, unit allowlisted, buckets sorted
  ascending). Filter-aware inside `<Deals.Index>`, standalone outside.
- **`<Deals.Stats>{(s) => …}`** — a GET `@action` as a first-class surface
  member: headless, works outside `<Deals.Index>`, cached under the deals
  family root so the numbers recompute whenever any deal mutation lands.
- **`<Deals.Empty>` / `<Deals.Error>`** — empty pages know why
  (`emptyReason` → the right CTA); errors arrive parsed
  (forbidden/not-found/unauthenticated/…). `<Deals.FormSkeleton />` /
  `<Deals.ListSkeleton />` are shaped by the declared fields.
- **Filter presenters** — the socket, not the bulb:
  `registerFilterPresenter` + `setDefaultFilterPresenters` (kind defaults
  for the whole app), per-site
  `<Deals.Filters.stage presenter="segmented" />` (kind-gated), or the
  registry-free render-prop
  `<Deals.Filter name="stage">{({ meta, value, set, clear }) => …}</Deals.Filter>`.
  `FilterPresenterProps = { name, meta, value, set, clear, session, counts? }`
  is the list-state analogue of `PresenterProps`. Until you register
  presenters, built-in scaffolding renders — unstyled, marked
  `data-ad-scaffold`, announced once in the console. Demo furniture, not
  the product.

### Live Forms

Mutate a record from any surface; every other surface — including live,
half-edited forms — gets fresh without losing a keystroke:

- **Coherence fan-out** — every generated mutation fans out through one
  `applyEntityChange` call against the generated edge table
  (`_coherence.gen.ts`), so a proposal mutation that touches its loan
  invalidates the doors that embed *loans* too. `connectEventSource(qc,
  coherenceEdges, '/live')` plugs a server push wire into the same entry
  point. Signal-only doctrine: `{ resource, op }` frames, never payloads —
  refetches carry the truth through the normal doors. The wire itself is
  app code, so multi-tenant apps partition it (per-org channels) the same
  way they scope every door.
- **`rehydrate()`** — refetches three-way-merge into live forms: clean
  fields adopt, dirty fields survive, true conflicts withhold the version
  token so the next save 409s into the conflict flow. Nested children merge
  by id.
- **Conflicts** — on a 409 the session parks in `'conflict'`: the draft is
  untouched (no keystroke is ever dropped by a race), autosave pauses,
  `<deal.SaveStatus />` shows "Changed elsewhere". Two exits via
  `deal.$resolveConflict('reload' | 'overwrite')`: reload folds the 409's
  envelope into the draft (server wins); overwrite adopts the fresh token
  and resubmits your still-dirty diff — always an explicit user action, the
  framework never overwrites on its own. `<deal.Conflict>{resolve => …}`
  renders only during a 409; `deal.$conflict` exposes the fresh envelope
  for field-by-field "theirs vs mine" UIs.
- **`elsewhere`** — when the merge finds the server holding a *different*
  value for a field you've edited, that divergence is data, not just a
  future 409: presenters receive `elsewhere = { value, at }` (`at` from the
  envelope's `updatedAt ?? version` — zero wire bytes; expose
  `updatedByName`/`updatedBy` in your projection and affordances say who),
  and `<deal.Changes>` render-props `{ changes, adoptAll, dismiss, fields }`
  (default rendering: "Updated elsewhere: name, notes ✕"). Per-field
  `adopt()` moves draft *and* baseline; adopting the last standing change
  releases the withheld token — adopt-all fully settles. `dismiss()` is
  presentation-only. One conflict system, three altitudes: inline field →
  floater → save-time dialog. Headless: `getIncoming()` /
  `getIncomingFor(f)` / `adoptIncoming(f)` / `adoptAllIncoming()` /
  `dismissIncoming()`.
- **Draft parking** — navigate away mid-edit and back: unsaved diffs park
  (LRU/TTL, cleared on save) and restore through the same merge; a field
  the server moved meanwhile conflicts honestly instead of silently.
- **poll + pendingIf** — `useDealEditForm(id, { poll: { every: 3000, until:
  d => d.reportStatus === 'ready' } })` plus `<deal.reportUrl view
  pendingIf={d => d.reportStatus !== 'ready'} pendingLabel="Generating…" />`
  for backend-job fields.
- **Autosave narration** — a debounced flush pulses `saving → saved` on
  exactly the fields it carried; mid-flight re-edits drop back to dirty;
  failures clear the marks.
- **The event bus** — one registration at startup plugs any toast or
  telemetry system into every form in the app. Events are semantic (what
  happened), never presentational (how to show it):

```ts
import { onFormEvents } from '@active-drizzle/react'
onFormEvents((e) => {
  if (e.type === 'rehydrated')     toast.info(`Updated elsewhere: ${e.fields?.join(', ')}`)
  if (e.type === 'conflict')       toast.warn('This record changed elsewhere')
  if (e.type === 'saved')          toast.success('Saved')
  if (e.type === 'draft-restored') toast.info('Restored your unsaved edits')
})
```

### Build-Time Codegen

- **Vite plugin** — watches `.model.ts` and `.ctrl.ts` files, regenerates on save (headless via `buildStart()` for non-Vite servers)
- **Type declarations** — `X.model.types.gen.d.ts` per model with associations, enum/state predicates, dirty tracking, column props
- **Runtime code** — `X.model.gen.ts` with the isomorphic `Model.Client` class for frontend hydration
- **Ambient globals** — `_globals.gen.d.ts` so cross-model types resolve inside module augmentations
- **oRPC router** — type-safe procedures with Zod validation schemas
- **`.gen/` + the `@gen` alias** — all output lands in `.gen/models` + `.gen/controllers` (`genDir: false` restores co-location); the plugin injects a Vite alias so app imports are `import { Deals } from '@gen/controllers'` / `import { DealClient } from '@gen/models'` — no relative paths, and the tsconfig `paths` entry makes cmd-click jump into the generated file. Include `".gen/**/*"` explicitly in tsconfig (hidden directories don't ride wildcard includes); one `.gitignore` line covers it all. `_client.ts` — user-owned wiring — stays in the source tree
- **Coherence edges** — `_coherence.gen.ts` composes the include graph with the write-effect graph (counterCache/touch/dependent/nested, transitively); every generated mutation fans out through one `applyEntityChange` call — WebSocket-ready by construction
- **`tsc --noEmit`-clean** — a fresh project typechecks out of the box: declarations emit as `X.model.types.gen.d.ts` so the module augmentations actually apply (a `.d.ts` sharing its basename with a sibling `.ts` is silently excluded by tsc as presumed build output — invariant 7), controller-less nested children inline their wire shape, form handles type their nested members
- **Teaching errors** — `stiType` without `@model` is a codegen error naming the exact fix; a schema-export/table-name mismatch names the export to fix; runtime "table not found" teaches the boot-map / `bindDatabase` / barrel-import checklist
- **LLM docs** — `.active-drizzle/schema.md`: the whole data model in one AI-optimized file

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your Application                             │
├──────────────┬──────────────────┬──────────────────┬────────────────┤
│   Schema     │     Models       │   Controllers    │    React       │
│  (Drizzle)   │ (ApplicationRecord) │  (@crud, @mutation) │  (Generated)  │
├──────────────┴──────────────────┴──────────────────┴────────────────┤
│                    Vite Plugin (ts-morph codegen)                    │
│  Extracts → Validates → Generates types + runtime + hooks + router  │
├─────────────────────────────────────────────────────────────────────┤
│              @active-drizzle/core    │  @active-drizzle/controller  │
│  Relation, Attr, hooks, associations │  CRUD handlers, oRPC, REST  │
├──────────────────────────────────────┴──────────────────────────────┤
│                         Drizzle ORM                                 │
│                         PostgreSQL                                  │
└─────────────────────────────────────────────────────────────────────┘
```

Three runtime packages, each installable independently — plus the scaffolder:

| Package | What it is |
|---------|-----------|
| `@active-drizzle/core` | Models, associations, hooks, dirty tracking, Attr, state machines, codegen, Vite plugin |
| `@active-drizzle/controller` | `@crud`, `@mutation`, `@action`, `@before`/`@after`, `@rescue`, abilities, oRPC router, REST adapters |
| `@active-drizzle/react` | React Query hook generation, form handles, presenter registry, `ClientModel`, error parsing |
| `@active-drizzle/trails` | `trails new` — a working app in one command; `trails doctor` — checks for silent misconfigurations |

---

## Quick Start

### One command

```bash
npx @active-drizzle/trails new myapp
cd myapp && npm install && npm run dev
```

Sixteen files: PGlite (zero-setup Postgres), one schema table, one model
(validations, scope, touch hook), one controller
(expose/permit/search/facets/optimisticLock), `trails.config.ts`, the Vite
codegen plugin wired, a client using the generated surface (`<Posts.Index>`,
`<Posts.Sidebar>`, an autosave form with Conflict/Changes), and
`npm run regen` for codegen without Vite.

Every generated app also ships `tests/contract.test.ts` — the
forge-every-field security suite derived from the controller's own config,
running fully in-process (oRPC `call`, PGlite, no server). `npm test` exists
on day one and can never fall behind the config, because it *is* the config.

Generated apps are Postgres-first: set `DATABASE_URL` → node-postgres +
`npm run db:push` (drizzle-kit owns the schema lifecycle). No `DATABASE_URL`
→ a loud in-memory PGlite fallback keeps `npm run dev` zero-setup.

`npx trails doctor` checks the misconfigurations that degrade *silently*:
tsconfig missing the `@gen/*` paths or the `.gen/**/*` include (type
augmentations silently dead), stale or un-gitignored `.gen/`, missing
`_client.ts`, missing framework packages — ✓/✗ with the exact fix per line,
exit 1 on problems (CI-able).

See [GETTING-STARTED.md](GETTING-STARTED.md) for the full path from
`trails new` through the three files to the `@gen` imports and the dev loop.

### Manual setup

```bash
npm install @active-drizzle/core drizzle-orm
```

```ts
// boot.ts
import { boot } from '@active-drizzle/core'
import { db } from './db'
import * as schema from './schema'

boot(db, schema)
```

```ts
// vite.config.ts
import activeDrizzle from '@active-drizzle/core/vite'

export default defineConfig({
  plugins: [
    activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/**/*.model.ts',
      controllers: 'src/controllers/**/*.ctrl.ts',
    }),
  ],
})
```

> **[Full getting started guide →](https://danieth.github.io/active-drizzle/guide/getting-started)**

### Configuration — `trails.config.ts`

One JavaScript file: Rails' environment concept without Rails' file sprawl.
Base config plus inline `environments` overrides, deep-merged by `NODE_ENV`
at boot. Secrets are *referenced* from `process.env`, never stored — the
file commits, the values deploy.

```ts
import { defineConfig } from '@active-drizzle/core'

export default defineConfig({
  server:   { port: 8787 },
  channels: { bus: process.env.REDIS_URL ? 'redis' : 'memory',
              redisUrl: process.env.REDIS_URL },   // set REDIS_URL → multi-process just works
  environments: {
    production: { channels: { revalidate: 'always' } },
    test:       { server: { port: 0 } },
  },
})
```

Merge semantics: objects merge deep, arrays and scalars replace wholesale —
an env that sets a list *means* that list. Missing file = everything
defaults. `loadConfig()` at boot, `defineConfig` for types; app-defined
sections ride along and merge the same way.

---

## Documentation

The full documentation covers every feature with examples:

| Section | Topics |
|---------|--------|
| **[Getting Started](https://danieth.github.io/active-drizzle/guide/getting-started)** | Installation, boot, project structure |
| **[The Happy Path](https://danieth.github.io/active-drizzle/guide/happy-path)** | End-to-end: schema → model → controller → React |
| **[Models](https://danieth.github.io/active-drizzle/models/overview)** | Attributes, associations, STI, custom PKs |
| **[Querying](https://danieth.github.io/active-drizzle/querying/basics)** | where, order, includes, pluck, aggregates, scopes |
| **[Controllers](https://danieth.github.io/active-drizzle/controllers/overview)** | CRUD, mutations, actions, hooks, error handling, multi-tenant |
| **[React Query](https://danieth.github.io/active-drizzle/react/overview)** | Generated hooks, forms, error handling |
| **[Codegen](https://danieth.github.io/active-drizzle/codegen/vite-plugin)** | Vite plugin, what gets generated, how it works |

---

## Testing

```bash
npm test                                # 900+ tests across all packages
npm run test:coverage -w packages/core  # 96%+ line coverage
```

---

## Contributing

```bash
git clone https://github.com/Danieth/active-drizzle.git
cd active-drizzle
npm install --legacy-peer-deps
npm test
```

The repo is an npm workspaces monorepo. Each package builds with `tsup`. Tests use Vitest with `ts-morph` in-memory projects for codegen and mock DB instances for runtime tests.

---

## License

[MIT](LICENSE) — Daniel Ackerman
