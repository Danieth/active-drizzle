# ActiveDrizzle — LLM guide

Terse, canonical reference for writing apps on ActiveDrizzle. Every name
here is exact. When generating code, copy these shapes verbatim and change
only identifiers. No prose padding; rules are absolute unless marked.

## 0. Mental model

**SURFACE TIERS (read this first — it's the YAGNI contract):**
- **CORE** (the spine; stable, learn this): models + controllers +
  codegen, the forms machinery (sessions/presenters/autosave/409/merge/
  coherence), Index/Search/Filters/Items/Pagination, config, the CLI.
  This is the Rails-analog surface. Build on it freely.
- **SCAFFOLDING TIER** (conveniences you OUTGROW): Sidebar, Board, Table,
  Chart, Metric, Skeletons, Empty/Error defaults, all `data-ad-scaffold`
  rendering. Contract: their DATA shapes (render-prop APIs) are stable;
  their default pixels are demo furniture; pre-1.0 they may move to a
  separate package. Prefer the render-prop over the scaffold in real apps.
- **SEAMS** (small, stable plugs): presenter/filter registries,
  buildFieldBind/useFieldProps, SearchAdapter, BroadcastBus, contract
  probes, `@active-drizzle/react/testing` (subpath — NOT on the runtime
  surface). New capability enters as recipe → seam → surface, in that
  order; most things should STOP at recipe or seam.

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

Codegen (vite plugin `active-drizzle/vite`) writes EVERYTHING into
`.gen/` (gitignored; never edit): `.gen/models/` (Client classes + type
augmentations + _registry) and `.gen/controllers/` (typed client + hooks +
form handles + index surface per controller, `_coherence.gen.ts`,
`_routes.gen.ts`, barrels). Import through the injected alias — from
ANYWHERE: `import { Deals, useDealEditForm, coherenceEdges } from
'@gen/controllers'`, `import { DealClient } from '@gen/models'`.
tsconfig: `"baseUrl": ".", "paths": {"@gen/*": ["./.gen/*"]}`, include
`".gen/**/*"`. Legacy co-located layout: plugin option `genDir: false`.

Server boot:
```ts
boot(db, { deals: schema.deals, notes: schema.notes /* export-name keys */ })
const { router } = buildRouter(DealController)   // oRPC router
```

## 0.5 WORKING the framework (the operational loop)

```sh
npx trails new myapp && cd myapp && npm install   # scaffold a WORKING app
npm run dev            # API (tsx watch) + client (vite, codegen plugin) together
npm run regen          # clean-room codegen WITHOUT vite (stale suspicion, CI)
npm run typecheck      # tsc --noEmit — generated code is tsc-clean by contract
npm run db:push        # drizzle-kit syncs schema to REAL Postgres (needs DATABASE_URL)
```

DATABASE — defer-to-drizzle: `server/db/index.ts` builds the drizzle
instance (node-postgres when `DATABASE_URL`/config.database.url is set;
loud in-memory PGlite fallback otherwise — dev-only, resets on restart).
The framework never owns connections; it owns BINDING:
```ts
boot(db as any, { posts: schema.posts })                          // default database
bindDatabase('analytics', analyticsDb, { events: aSchema.events })// more databases, per TABLE
// getExecutor routes by table; transaction(fn, { database: 'analytics' }) scopes a tx;
// a tx NEVER captures queries against a different database (different connections).
// LIMIT: associations/includes cannot cross databases — load separately.
```

RECIPE — add a field end to end (the canonical loop):
1. schema.ts: add the column → 2. Model: `static score = Attr.integer({ label: 'Score' })`
3. Controller: add to `expose` (visible) and/or `permit` (writable), maybe
   `filterable`/`sortable` → 4. save — codegen reruns → 5. JSX: `<post.score edit />`
   just works; typecheck catches anything the door disagrees with.

RECIPE — new resource: schema export + `X.model.ts` + export from
models/index.ts barrel + `X.ctrl.ts` → save → `import { Xs, useXEditForm }
from '@gen/controllers'`. RECIPE — security check in any test:
`expect(await runContractProbes(buildContractProbes(XController), call)).toEqual([])`.

ERRORS THAT TEACH (rely on them): generated surfaces carry LITERAL-UNION
types — a wrong filter/chart/metric/board name is a COMPILE error listing
the valid options; `<Deals.Filters.typo/>` is a compile error. Arm the
presenter↔kind compile gate with one d.ts (see `src/presenter-kinds.d.ts`
in the demo): augment `AdPresenterKinds` with your presenter names → kinds
and `<deal.amount edit="tagsInput"/>` (money × array) becomes a compile
error listing the legal presenters. Runtime guards name the fix: a
top-level filter param → 400 "'stage' is a filter — nest it: { filters:
{ stage: … } }"; a stripped `reactions:` write → issue "did you mean
'reactionsAttributes'?"; association options behind `as any` now parse
THROUGH the cast (genuinely dynamic options throw at codegen, never a
silent no-op).

Files you edit: `server/db/schema.ts`, `server/models/*.model.ts`,
`server/controllers/*.ctrl.ts`, `trails.config.ts`, your React code.
Files you NEVER edit: everything in `.gen/` (rebuilt on save; gitignored).
`_client.ts` (controllers dir) is user-owned wiring — created once, yours.

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
- STI: a subclass needs BOTH `@model('<same table as base>')` AND
  `static stiType = 'Label'` — @model REGISTERS it (without it,
  parent-table queries silently instantiate the base class for its rows;
  codegen now errors on this), stiType auto-scopes its queries. Parent
  statics are inherited (state machines, associations, everything); the
  base keeps the by-table registry slot automatically.
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
    facets: true,                       // CEILING for facet counts — computed only when a request asks
    // (param facets: true|['stage']; Sidebar/Board auto-ask; requested ∩ allowed; ask w/o ceiling = 400)
    // options param: { options: { value: 'id', label: 'name' } } → narrowed+sorted [{value,label}]
    // picker feed under the expose ceiling (both fields must be exposed; id always ok; cap = perPage|50)
    chartable: ['stage'], measures: ['amount'],  // chart {x,y:'count'|'sum:F'|'avg:F'} + metric params (perPage:0 = agg-only)
    // search.adapter (the ES lane): external engine returns IDS ONLY in rank
    // order; hydration stays behind this door. search.doc = the ONE searchDoc
    // transform (buildSearchDoc) your shipper + reindex both call.
    // Fallback chain: adapter → search.fields (PG FTS) → searchable (ilike).
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
  <deal.Changes />                         {/* adopted-notice + TRUE-CONFLICT floater: "Deal Name → theirs [take theirs] [take all] ✕" */}
  {/* render-prop: {({ fields, changes, adoptAll, dismiss }) => ...} — changes: [{field,label,value,at,adopt()}]
      per-field adopt() = take-theirs (baseline moves, field clean); last adopt releases the withheld
      version token (fully settled); dismiss() is presentation-only (stale token still 409s) */}
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
// PresenterProps also carries elsewhere?: { value, at } — the server's value for THIS field
// while you hold a different one (true conflict). Adopt inline via bind.onChange(elsewhere.value).
// unregistered kinds render SCAFFOLDING (data-ad-scaffold, console notice) — replace in real apps

// combinators (all allowlisted + codec-transformed; depth-1 by design):
ix.session.setFilter('priority', { nin: ['low'] })          // NOT IN
ix.session.setFilter('tags', { all: ['hot', 'q3'] })        // array contains ALL
ix.session.setFilter('$or', [{ stage: 'submitted' }, { priority: 'high' }])  // (a OR b) AND rest
// max 10 branches, no nesting, tier-1 fields only; richer logic = a NAMED filter's apply()

// derived surfaces (all data-to-presenter; scaffold defaults marked data-ad-scaffold):
<Deals.Sidebar />                                 // FACETED SEARCH PANEL: groups from declared filters,
//   carets (<details>), zero-filled DISJUNCTIVE counts (need index.facets), multi-select
//   toggles, search box, clear-all. presenters={{group: name|Component}} per group;
//   render-prop → SidebarApi { groups:[{name,label,kind,options:[{value,count,active,toggle}],set,clear}],
//   activeCount, clearAll, search:{q,setQ}|null, total, isLoading }
<Deals.Board />                                   // Attr.state AS kanban: states=columns, move(row,to)
<Deals.Board groupBy="priority" />                //   resolves the TRANSITION (_event) or PATCHes the value
<Deals.Board>{({ columns, move, canMove }) => …}</Deals.Board>   // bring your own DnD
<Deals.Chart x="stage" y="sum:amount">{(points) => …}</Deals.Chart>  // [{x,y}], filter-aware in <Index>
<Deals.Metric agg="count">{(v) => …}</Deals.Metric>
<Deals.Table columns={['name','stage']}>{({ columns, rows, setSort, mutateRow }) => …}</Deals.Table>
<Deals.Empty />                                   // knows WHY: no-records vs no-matches (+clearFilters)
<Deals.Error>{({ kind, message }) => …}</Deals.Error>
<Deals.FormSkeleton /> <Deals.ListSkeleton rows={5} />
// permission gates from the envelope's own verdicts:
<deal.Can edit="amount">…</deal.Can>  <deal.Can action="markWon" not fallback={…}>…</deal.Can>
// const { canEdit, can } = useAbilities(deal)
// live: connectEventSource(qc, coherenceEdges, '/live') — server pushes {resource, op}
//   signals (NEVER payloads); the coherence fan-out refetches; forms three-way merge.
// contract probes: buildContractProbes(Ctrl) + runContractProbes(probes, call) — the
//   forge-every-field security suite derived from the same metadata that enforces it.

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
