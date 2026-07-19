# ActiveDrizzle — LLM guide

Terse, canonical reference for writing apps on ActiveDrizzle. Every name
here is exact. When generating code, copy these shapes verbatim and change
only identifiers. No prose padding; rules are absolute unless marked.

## 0. Mental model

You write THREE files per resource; everything else is generated:

1. **Schema** (drizzle): `export const deals = pgTable('deals', {...})` —
   the export identifier (`deals`) is the canonical table name everywhere
   (boot map, associations, registries). snake_case SQL names are fine as
   the pgTable arg; the EXPORT name is what the framework uses.
2. **Model** (`X.model.ts`): class + static declarations (Attr, state,
   associations, validations, hooks, scopes).
3. **Controller** (`X.ctrl.ts`): `@controller('/path') @crud(Model, config)`
   — declares the API surface AND the permission model AND the generated
   client/form/index surfaces.

Codegen (vite plugin `active-drizzle/vite`) turns these into:
`X.model.gen.ts` (browser Client class), `X.model.types.gen.d.ts` (type
augmentations), `x.gen.ts` per controller (typed client + hooks + form
handles + index surface), `_coherence.gen.ts` (cache invalidation edges),
`_routes.gen.ts`. NEVER edit `*.gen.*` files.

Server boot:
```ts
boot(db, { deals: schema.deals, notes: schema.notes /* export-name keys */ })
const { router } = buildRouter(DealController)   // oRPC router
```

## 1. Model DSL

```ts
import { ApplicationRecord, model, Attr, Validates, belongsTo, hasMany,
         hasOne, habtm, validate, scope, computed, beforeSave, afterCommit,
         include, SoftDeletable, defineModelConcern } from 'active-drizzle'

@model('deals')                       // arg = schema EXPORT name
export class Deal extends ApplicationRecord {
  // ── associations ──
  static owner    = belongsTo('users', { foreignKey: 'ownerId' })
  static company  = belongsTo('companies', { foreignKey: 'companyId' })  // nullable fk = optional assoc
  static poly     = belongsTo({ polymorphic: true })   // reads polyType + polyId columns
  static notes    = hasMany('notes', {
    acceptsNested: { allowDestroy: true, instant: true },  // nested form; instant needs a child controller
    order: { position: 'asc' },
    dependent: 'destroy',
    counterCache: true,               // maintains notesCount on this table
  })
  static brief    = hasOne('briefs', { acceptsNested: { allowDestroy: true } })
  static comments = hasMany('comments', { as: 'commentable' })  // polymorphic INVERSE (scopes id+type)
  static coOwners = habtm('deal_owners', { className: 'User' }) // join table export; className = target class
  static stakeholders = hasMany('users', { through: 'deals', source: 'owner' }) // through model's belongsTo name

  // ── attributes (codecs + validation + presentation meta) ──
  static name   = Attr.string({ label: 'Deal Name',
    validates: [Validates.presence(), Validates.length({ min: 3, max: 80 })] })
  static amount = Attr.money('amount', { label: 'Amount', help: '...',    // int cents in DB, decimal string in app
    validates: Validates.numericality({ greaterThan: 0, allowNull: true }) })
  static email  = Attr.string({ validates: [Validates.presence(), Validates.email()] }) // email() sets semantic kind → email presenter
  static slug   = Attr.string({ serverValidates: Validates.uniqueness() }) // async, server-only
  static isHot  = Attr.boolean({ label: 'Hot' })
  static priority = Attr.enum({ low: 0, medium: 1, high: 2 } as const)    // labels on the wire, ints in DB
  static stage  = Attr.state({                                            // state machine
    states: { draft: 0, submitted: 1, won: 2 } as const,
    initial: 'draft',
    transitions: {
      submit: { from: ['draft'], to: 'submitted',
                if: (d: any) => d.amount != null, message: 'needs an amount' },
      win:    { from: ['submitted'], to: 'won' },
      reopen: { from: '*', to: 'draft' },
    },
  })

  // ── multi-field validation (deps auto-inferred from this.X reads) ──
  @validate()
  hotNeedsAmount() { if (this.isHot && this.amount == null) return 'hot deals need an amount' }

  // ── hooks ──
  @beforeSave() touch() { (this as any).updatedAt = new Date() }
  @afterCommit() index() { /* post-commit side effects */ }

  // ── scopes (chainable) ──
  @scope static open() { return this.where({ stage: [0, 1] }) }
}

// concerns
@model('posts') @include(SoftDeletable) class Post extends ApplicationRecord {}
```

RULES:
- NEVER read `Klass.name` — `static name = Attr...` shadows it. Use
  `modelClassName(Klass)` if needed.
- STI: subclass sets ONLY `static stiType = 'Label'`; parent statics are
  inherited (state machines, associations, everything). Base class owns
  the by-table registry slot automatically.
- Import models through a barrel (`models/index.ts` re-exporting all) —
  ESM elides unused imports and unregistered models break associations.
- habtm join tables: use a snake_case schema EXPORT (`deal_owners`) so
  export key, SQL name, and marker arg agree.

## 2. Runtime query API

```ts
await Deal.find(1)                          // throws RecordNotFound
await Deal.where({ stage: 'draft' }).load() // labels auto-transform via codecs
await Deal.where({ amount: { gte: '100', lte: '500' } }).load()  // operators: gte lte gt lt ne (codec-transformed bounds)
await Deal.where({ ownerId: [1, 2] }).first()      // array → IN
await Deal.where({ companyId: null }).count()      // null → IS NULL
await Deal.open().order('updatedAt', 'desc').limit(10).load()
await Deal.includes('notes', { notes: ['reactions'] }).find(1)  // eager load
await Deal.all().search('acme', ['name'])          // ilike substring
await Deal.all().ftsSearch('acme expansion', { name: 'A', contactEmail: 'B' })
  .orderByRelevance().load()                       // weighted websearch FTS + ts_rank

const deal = await Deal.create({ name: 'X', notesAttributes: [{ body: 'hi' }] })
await deal.update({ name: 'Y' })
await deal.comments.create({ body: 'hi' })   // association-scoped: fk + polymorphic type auto-set
deal.comments.build({ body: 'draft' })       // unsaved, same defaults
await deal.destroy()
deal.isDraft(); deal.can('submit'); deal.submit(); await deal.advance('submit')
```

Nested attributes protocol (server): `notesAttributes: [{...fields}]` create ·
`[{id, ...f}]` update (ownership-gated) · `[{id, _destroy: true}]` destroy
(allowDestroy only). hasOne uses ONE OBJECT not an array; an id-less hasOne
write UPDATES an existing child (singular invariant). habtm writes:
`coOwnerIds: [1,2,3]` replaces the join set.

## 3. Controller DSL

```ts
import { controller, crud, mutation, action, before } from '@active-drizzle/controller'

// @mutation: POST /deals/:id/<kebab>. Options (ALL optional):
//   if:       (record, ctx, ctrl) => boolean — per-record guard. Verdict ships
//             in the envelope can map (button greys) AND is re-enforced at
//             dispatch (422). Sync only.
//   params:   ['reason']  — payload ALLOWLIST; undeclared data keys stripped
//   required: ['reason']  — missing/blank → 422 {reason: ['is required']}
//   label:    'Send back' — button/mini-form label
// Return this.envelope(record) → the client button folds fresh fields+verdicts
// into the live form session (no refetch).
@mutation({ if: (d: any) => d.isSubmitted(), label: 'Mark won' })
async markWon(deal: any) { await deal.advance('win'); return this.envelope(deal) }
@mutation({ params: ['reason'], required: ['reason'], if: (d: any) => d.isSubmitted() })
async sendBack(deal: any, data: { reason: string }) { ...; return this.envelope(deal) }

// @action('GET') with no load → aggregation route, becomes <Deals.Stats/> on
// the index surface + indexStats() hook. Cache key under the family root →
// coherence refetches it after every mutation.
@action('GET') async stats() { const rows = await this.relation.load(); return { total: rows.length } }

const EDITABLE = ['name', 'amount', 'notesAttributes', 'briefAttributes'] as const

@controller('/deals')
@crud(Deal, {
  index: {
    scopes: ['open'],                       // allowlisted named scopes (?scopes=)
    sortable: ['updatedAt', 'name'],
    defaultSort: { field: 'updatedAt', dir: 'desc' },
    include: ['notes'],
    searchable: ['name', 'contactEmail'],   // ?q= ilike fallback
    search: { fields: { name: 'A', contactEmail: 'B' } },  // weighted FTS (websearch + ts_rank, hybrid substring)
    filterable: ['stage', 'priority', 'isHot'],            // tier-1 column filters (codec-normalized, allowlisted)
    filters: {                                             // tier-2 NAMED filters — semantics server-side
      bigDeals: { label: 'Big deals', kind: 'toggle',
        apply: (rel, _on, ctx) => rel.where({ amount: { gte: 20_000 } }) },
    },
  },
  get: {
    expose: ['id', 'name', 'amount', 'stage', 'coOwnerIds', 'updatedAt'],  // the READ CEILING
    abilities: true,                        // → Forms envelope {record, abilities, can, version}
    include: [{ notes: ['reactions'] }, 'brief'],
  },
  create: {
    permit: [...EDITABLE],
    autoSet: { ownerId: (ctx) => Number(ctx.userId) },              // forced from context
    nestedAutoSet: { 'notes.reactions': { userId: (ctx) => Number(ctx.userId) } },
  },
  update: {
    optimisticLock: true,                   // 409 conflicts; true = updatedAt (model must touch it), or 'lockVersion' (numeric auto-increments)
    permit: (_ctx, ctrl, deal) =>           // record- and role-aware
      ctrl.state.user.isAdmin() ? [...EDITABLE, 'ownerId'] : deal.isDraft() ? [...EDITABLE] : [],
  },
})
export class DealController extends ApplicationController {}
```

RULES:
- `expose` is the ceiling: unlisted fields NEVER leave this door.
- `permit` governs every write incl. `<assoc>Attributes` keys; unpermitted
  input is stripped AND reported (`issues: [{field, code:'forbidden'}]`).
- Projections REDUCE, never transform: a controller may hide fields but a
  field's representation is model-owned (one codec everywhere).
- Filters/named-filters/sorts/scopes are allowlists; undeclared = 400.
- `apply` in named filters gets the ALREADY-SCOPED relation: narrowing only.
- Custom endpoints: `@mutation() async archive() {...}`, `@query()`.

## 4. Frontend — forms (generated)

```tsx
import { useDealEditForm, useDealNewForm, Deals, DealController }
  from '../../server/controllers/deal.gen'

const { status, form: deal } = useDealEditForm(id)            // envelope-wired
const { status, form: deal } = useDealEditForm(id, {          // poll until a backend job finishes
  poll: { every: 3000, until: d => d.reportStatus === 'ready' } })

<deal.Form onSuccess={() => toast('Saved')} className="form"> {/* or <deal.Form autosave> */}
  <deal.name edit />                       {/* edit presenter by Attr kind */}
  <deal.amount edit />                     {/* money presenter */}
  <deal.stage />                           {/* view (absent/bare view = view mode) */}
  <deal.owner edit props={{ from: UserController }} />        {/* belongsTo picker: from = the DOOR */}
  <deal.coOwners edit props={{ from: UserController }} />     {/* habtm multi-picker */}
  <deal.reportUrl view pendingIf={d => d.reportStatus !== 'ready'} pendingLabel="Generating…" />

  <deal.notes>{note => (<>                 {/* hasMany nested — render-prop per child handle */}
    <note.body edit label="" />
    <note.Remove>remove</note.Remove>
  </>)}</deal.notes>
  <deal.notes.Add defaults={{ position: 99 }}>+ add</deal.notes.Add>

  <deal.brief>{b => (<><b.summary edit /><b.Remove /></>)}</deal.brief>   {/* hasOne — ONE child */}
  <deal.brief.Build>+ add brief</deal.brief.Build>

  <deal.SaveStatus />                      {/* saving/saved/unsaved/offline/conflict pill */}
  <deal.Changes />                         {/* "updated elsewhere: name, notes ✕" — or render-prop {({fields, dismiss}) => ...} */}
  <deal.BaseErrors />
  <deal.Conflict>{resolve => (<>           {/* renders only during a 409 */}
    <button onClick={() => resolve('reload')}>Take theirs</button>
    <button onClick={() => resolve('overwrite')}>Keep mine</button>
  </>)}</deal.Conflict>
  <deal.Submit>Save</deal.Submit>
  <deal.Submit event="submit">Submit deal</deal.Submit>       {/* state transition; auto-disabled via server can-map */}

  {/* @mutation members — PascalCase of the method name: */}
  <deal.MarkWon />                          {/* paramless → button; disabled unless envelope can.markWon */}
  <deal.SendBack />                         {/* params → implicit mini-form (scaffolding inputs, data-ad-scaffold) */}
  <deal.SendBack fields={{ reason: 'dup' }}>Reject as dup</deal.SendBack>  {/* pre-supplied → plain button */}
  <deal.SendBack>{({ run, allowed, pending, errors, label, params }) => ...}</deal.SendBack>  {/* render-prop */}
  {/* success: envelope return folds into the session (verdicts re-grey live) + coherence fan-out;
      422 field errors land on the mini-form inputs; bus emits {type:'action', action, ok} */}
</deal.Form>
```

Programmatic: `deal.$draft` `deal.$dirty` `deal.$status` `deal.$errors`
`deal.$submit()` `deal.$can(event)` `deal.$conflict` `deal.$resolveConflict(mode)`
`deal.$session` (the FormSession). Nested: `deal.notes.forms/.rows/.add/.patch/.remove/.move`,
`deal.brief.form/.exists/.build()/.remove()`.

Behavior guarantees (do NOT re-implement):
- Same JSX renders inputs OR read-only text per the server abilities mask.
- Refetches THREE-WAY MERGE into dirty forms (clean adopts, dirty survives,
  same-field conflicts → 409 dialog). Adopted changes surface in
  `<deal.Changes/>`.
- Unsaved edits PARK on navigation and RESTORE on return (DraftStore).
- Mutations anywhere invalidate every dependent surface via the generated
  coherence edge table — cross-surface staleness is handled; don't write
  manual invalidations for generated mutations.

Toast/telemetry seam (once, at app startup):
```ts
import { onFormEvents } from '@active-drizzle/react'
onFormEvents(e => {   // types: 'rehydrated' | 'conflict' | 'saved' | 'draft-restored'
  if (e.type === 'rehydrated') myToast.info(`Updated elsewhere: ${e.fields?.join(', ')}`)
})
```

## 5. Frontend — index surface (generated, zero hooks)

GET @actions without :id are surface members (PascalCase): `<Deals.Stats>{(data, q) => ...}</Deals.Stats>`
— standalone (no <Deals.Index> needed), scaffolding JSON without a render-prop, auto-refetched by
every mutation's coherence fan-out (family-root cache key). Row handles inside <Deals.Items> carry
the same @mutation members (`<deal.MarkWon/>`); index rows are UNGOVERNED (no envelope) so buttons
default enabled and the server's guard 422s illegitimate presses.

```tsx
<Deals.Index>                              {/* the head is a component */}
  <Deals.Search placeholder="Search…" />   {/* from searchable/search config */}
  <Deals.Filters />                        {/* ALL tier-1 widgets; or <Deals.Filters.stage/> individually */}
  <Deals.Items empty={<p>None.</p>}>
    {(deal, row) => (<div onClick={() => nav(`/deals/${row.id}`)}>
      <deal.name view /><deal.amount view /></div>)}
  </Deals.Items>
  <Deals.Pagination />
</Deals.Index>

<Deals.One id={5}>{form => <form.Form>…</form.Form>}</Deals.One>

// filter presenters — register once, resolve by kind (mirrors form presenters):
registerFilterPresenter('segmented', { kind: 'facet', component: MySegmented })
setDefaultFilterPresenters({ facet: 'segmented' })
<Deals.Filters.stage presenter="segmented" />   // per-site override, kind-gated
<Deals.Filter name="stage">{({ meta, value, set, clear }) => <MyWidget/>}</Deals.Filter>  // raw state
// FilterPresenterProps = { name, meta, value, set, clear, session, counts? }
// unregistered kinds render SCAFFOLDING (data-ad-scaffold, console notice) — replace in real apps

// combinators (all allowlisted + codec-transformed; depth-1 by design):
ix.session.setFilter('priority', { nin: ['low'] })          // NOT IN
ix.session.setFilter('tags', { all: ['hot', 'q3'] })        // array contains ALL
ix.session.setFilter('$or', [{ stage: 'submitted' }, { priority: 'high' }])  // (a OR b) AND rest
// max 10 branches, no nesting, tier-1 fields only; richer logic = a NAMED filter's apply()

// custom widgets / tier-2 named filters via the session:
const ix = Deals.use()   // { session, state, meta, rows, pagination, isLoading }
ix.session.setFilter('bigDeals', true)     // wire name from the controller's filters config
ix.session.setQ('acme'); ix.session.setSort('name', 'asc'); ix.session.setPage(2)
```

## 6. Misc client APIs

```ts
import { recordOf } from '@active-drizzle/react'
const row = recordOf(await SomeController.get({ id }))  // unwraps envelope OR bare — pickers use this
import { onClientError } from '@active-drizzle/react'   // error telemetry seam
```

## 7. Operational rules

- Run tests from INSIDE each package dir (`cd packages/core && npx vitest run`).
- After editing framework packages: `npm run build --workspace=@active-drizzle/<pkg>`,
  then RESTART the consumer's vite (codegen regenerates on start) and
  hard-reload the browser.
- `controller` package tests need Docker (testcontainers).
- Verify persistence, not 200s: after a browser save, curl/reload to
  confirm; double-save to prove idempotence.
- Delete stale `*.model.gen.d.ts` files if present (renamed to
  `*.model.types.gen.d.ts`; the old basename is tsc-shadowed and dead).
