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
ordered collections. The letterbox rule still applies: `notesAttributes` must
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
import { CampaignController } from '../_generated'

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

- **Chainable queries** — `.where()`, `.order()`, `.limit()`, `.includes()`, `.pluck()`, `.count()`
- **Associations** — `belongsTo`, `hasMany`, `hasOne`, `habtm`, with `through:`, `dependent: 'destroy'`, `counterCache`, `autosave`, polymorphic `belongsTo`
- **Attr transforms** — `Attr.enum()`, `Attr.state()`, `Attr.money()`, `Attr.percent()`, `Attr.range.*()` / `Attr.multirange()` (PG ranges), `Attr.array()`, `Attr.json<T>()`, `Attr.string()`, `Attr.boolean()`, `Attr.date()`, `Attr.new({ get, set })`
- **State machines** — `Attr.state({ states, initial, transitions })` with guards and messages; integer or readable-text storage; synthesized `is<Label>()`, `can<Event>()`, `<event>()`, `advance()`
- **Declarative validators** — the Rails `Validates.*` set attached where the field is declared; shippable validators also run in the browser
- **Dirty tracking** — `isChanged()`, `changedFields()`, `fieldWas()`, `fieldChanged()`
- **Lifecycle hooks** — `@beforeSave`, `@afterCommit`, `@beforeDestroy`, `@validate`, with `{ if: }` conditions
- **Scopes** — `@scope static active() { ... }` → chainable, composable named queries
- **STI** — `static stiType = 'TermLoan'` → auto-scoped queries, correct subclass instantiation, inherited statics through the prototype chain
- **Transactions** — `ApplicationRecord.transaction(async () => { ... })` via `AsyncLocalStorage`
- **Nested attributes** — `hasMany({ acceptsNested: true })` → create/update/destroy children in one save
- **Custom primary keys** — composite keys, non-`id` columns

### Controllers

- **`@crud`** — index, get, create, update, destroy from one decorator
- **`@mutation`** — auto-loads record by `:id`, passes to method. `{ bulk: true, records: false }` for efficient mass updates; `optimistic` + typed `returns`
- **`@action`** — custom GET/POST endpoints; `{ load: true }` for member actions on the scoped relation
- **`@before` / `@after`** — lifecycle hooks with `{ only: }`, `{ except: }`, `{ if: }` conditions
- **`@rescue`** — Rails-style error handling. `RecordNotFound` → 404 automatically
- **`@scope`** — URL nesting: `@scope('teamId')` → `/teams/:teamId/campaigns`
- **`scopeBy`** — scope queries from resolved controller state (multi-tenant)
- **`expose` / `abilities`** — the read ceiling + the per-field wristband the client renders from
- **`autoSet` / `nestedAutoSet`** — stamp fields from context on create; nested child rows can't forge them
- **Dynamic `permit`** — `(ctx, ctrl, record) => string[]` for role- and record-aware field access
- **Optimistic locking** — version token in the envelope; stale writes 409 with the fresh envelope
- **Multi-tenant** — `this.state` with typed inheritance. Resolve org once, use everywhere

### React Integration

- **Generated hooks** — `ctrl.index()`, `ctrl.get(id)`, `ctrl.mutateCreate()`, `ctrl.mutateLaunch()`
- **Generated form handles** — every field is a component (`<deal.name edit />`); the same JSX renders edit or view per the server's abilities
- **Headless presenters** — `registerPresenter` / `setDefaultPresenters`; resolution by field kind derived from Attrs and refined by validators; the framework ships the socket, your app ships the kit
- **Nested collections** — `<deal.notes>{note => …}</deal.notes>` + `<deal.notes.Add />`; one PATCH saves the tree
- **Door-scoped pickers** — `props={{ from: UserController }}`; the controller's rules decide what's pickable
- **Error parsing** — 422 responses map to per-field errors; base errors surface via `<form.BaseErrors />`
- **Client model** — typed instances with predicates, dirty tracking, validation on the frontend

### Build-Time Codegen

- **Vite plugin** — watches `.model.ts` and `.ctrl.ts` files, regenerates on save (headless via `buildStart()` for non-Vite servers)
- **Type declarations** — `X.model.types.gen.d.ts` per model with associations, enum/state predicates, dirty tracking, column props
- **Runtime code** — `X.model.gen.ts` with the isomorphic `Model.Client` class for frontend hydration
- **Ambient globals** — `_globals.gen.d.ts` so cross-model types resolve inside module augmentations
- **oRPC router** — type-safe procedures with Zod validation schemas
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

Three npm packages, each installable independently:

| Package | What it is |
|---------|-----------|
| `@active-drizzle/core` | Models, associations, hooks, dirty tracking, Attr, state machines, codegen, Vite plugin |
| `@active-drizzle/controller` | `@crud`, `@mutation`, `@action`, `@before`/`@after`, `@rescue`, abilities, oRPC router, REST adapters |
| `@active-drizzle/react` | React Query hook generation, form handles, presenter registry, `ClientModel`, error parsing |

---

## Quick Start

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
