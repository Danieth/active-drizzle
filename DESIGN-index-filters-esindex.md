# The Index Surface — declared filters, magic components, and esindex
### Design doc · session 10 · 2026-07-19 · status: PROPOSED (nothing built)

The one-sentence pitch: **the index becomes a declared, governed surface the
same way the form already is** — the controller says what you can filter,
sort, and search on; codegen turns that into typed meta; magic components
render the whole thing; and because the declaration is engine-neutral data,
ElasticSearch slots in underneath without the client changing at all.

This subsumes the parked esindex thread. Its locked constraint is honored
throughout: **ES returns ranked ids only; hydration re-enters the same
scoped relation + expose ceiling; the door principle survives.**

---

## 1. The core question: what IS "the thing you can filter records by"?

It is NOT a column. Locking filters to columns fails the product test
immediately — Daniel's example: "big loans" means "amount between X and Z",
and next month it means "amount between X and Z, OR flagged by an analyst."
A filter is a *product concept with server-side meaning*.

So the primitive is:

> **A filter is a NAMED, DECLARED narrowing of the door's relation, with a
> typed param shape and a presentational kind.**

Two tiers, one mechanism:

**Tier 1 — column filters (derived).** `filterable: ['stage', 'amount',
'ownerId']` and the framework derives everything from Attr meta it already
has:

| Attr kind        | derived filter param        | derived widget            |
|------------------|-----------------------------|---------------------------|
| enum / state     | `label[]`                   | multi-select chips        |
| money / int      | `{ gte?, lte? }`            | range inputs / slider     |
| boolean          | `boolean`                   | toggle / tri-state        |
| date             | `{ from?, to? }`            | date-range picker         |
| string           | `string` (ilike)            | text box                  |
| fk (belongsTo)   | `id[]`                      | picker chips — a DOOR (`from:` at the call site, like refSelect) |

**Tier 2 — named filters (declared).** A parameterized scope wearing
presentational meta. This is where "big loans" lives, and where product
flexibility is unbounded:

```ts
@crud(Loan, {
  index: {
    scopes: ['open'],                       // exists today
    sortable: ['updatedAt', 'amount'],      // exists today
    searchable: ['name', 'contactEmail'],   // exists today (?q= ilike)
    filterable: ['stage', 'amount', 'ownerId'],   // NEW — tier 1
    filters: {                                    // NEW — tier 2
      bigLoans: {
        label: 'Big loans',
        kind: 'toggle',                     // how it renders
        apply: (rel, _on, ctx) => rel.where({ amount: { gte: ctx.org.bigThreshold } }),
      },
      closingBetween: {
        label: 'Closing window',
        kind: 'dateRange',                  // param shape follows the kind
        apply: (rel, { from, to }) => rel.where({ closesOn: { gte: from, lte: to } }),
      },
    },
  },
})
```

`apply` is `(rel: Relation<Loan>, params, ctx, ctrl) => Relation<Loan>` —
the same shape as a scope body. The server meaning is arbitrary; the
CLIENT only ever knows `{ name, label, kind, paramShape }`. That's the
whole trick: **the declaration is data, the semantics stay on the server.**
Change what "big" means and no client redeploys.

### The type-system answer

Per controller (per DOOR — not per model), codegen emits:

```ts
export type LoansIndexFilters = {
  stage?: ('draft' | 'submitted' | 'won')[]
  amount?: { gte?: string; lte?: string }     // money = decimal-string, Attr codec rules
  ownerId?: number[]
  bigLoans?: boolean
  closingBetween?: { from?: string; to?: string }
  q?: string
}
```

Same philosophy as `LoanWrite`: *"your meta type is still the model called
Loan, but your view of it is heavily constrained to X, Y, Z."* The model
stays the truth; the door's ceiling generates the narrowed surface. A
portable component accepts the wide shape; each door's generated type is
assignable to it.

---

## 2. The wire contract

Index request grows one canonical key (everything else exists today):

```
POST /rpc/loans/index
{ scope: 'open', sort: {field:'updatedAt', dir:'desc'}, page: 2,
  q: 'acme',
  filters: { stage: ['draft'], amount: { gte: '1000' }, bigLoans: true } }
```

Server composition order — **security is the ordering**:

```
door scope (scopeBy / URL scope)      ← the ceiling, ALWAYS first
  ∘ named scope (allowlisted)
  ∘ filters (allowlisted, tier 1 + 2)
  ∘ search (?q → searchable ilike | ES)
  ∘ sort (allowlisted)
  ∘ paginate
```

Rules, all fail-closed and all borrowed from the permit playbook:
- **Undeclared filter keys are dropped and REPORTED** (`issues: [{field,
  code:'forbidden'}]`, like stripped writes) — a filter the UI shows but
  the server ignores must never be invisible.
- **Params run through the Attr codecs.** `amount: { gte: '1,000' }`
  normalizes exactly like form input (money → cents, NaN → null, blank →
  null — the existing cast policy). A filter is just input; input goes
  through set().
- **Filters can only NARROW.** They apply on top of the door scope; there
  is structurally no way for a filter to widen past `scopeBy`. (Enforced
  by construction: `apply` receives the already-scoped relation.)

Index response grows:

```
{ rows, pagination,
  facets?: { stage: { draft: 12, submitted: 3 } } }   // phase 3, ES-powered
```

---

## 3. The index meta (codegen)

Alongside `fieldMeta`, each envelope controller emits `indexMeta`:

```ts
static indexMeta = {
  sortable: ['updatedAt', 'amount'],
  defaultSort: { field: 'updatedAt', dir: 'desc' },
  searchable: true,                          // a q box is renderable
  filters: {
    stage:   { kind: 'facet',  label: 'Stage', options: ['draft','submitted','won'], tier: 'column' },
    amount:  { kind: 'range',  label: 'Deal Amount', codec: 'money', tier: 'column' },
    ownerId: { kind: 'refFilter', label: 'Owner', tier: 'column' },   // door via props.from
    bigLoans:       { kind: 'toggle',    label: 'Big loans', tier: 'named' },
    closingBetween: { kind: 'dateRange', label: 'Closing window', tier: 'named' },
  },
} as const
```

Filter widgets are **presenters** — registered in the same registry, kinds
`facet | range | toggle | dateRange | refFilter | search`, overridable per
call site exactly like field presenters. One new bind shape:
`FilterBind = { value, onChange, meta, counts? }`.

---

## 4. The magic components (kill the visible hook)

New headless class first — **IndexSession** — the FormSession sibling:
holds `{scope, sort, page, q, filters}`, exposes subscribe/getters/setters,
debounces `q`, resets page on filter change, serializes to/from URL params.
Framework-agnostic, fully unit-testable, and the escape hatch for anyone
who wants to drive it by hand.

Then the generated compound components per envelope controller:

```tsx
<Loans.Index scope="open" urlSync>          {/* provider: query + IndexSession in context */}
  <Loans.Search />                          {/* the ?q box (only if searchable) */}
  <Loans.Filters />                         {/* ALL declared filters, meta-ordered */}
  <Loans.Items>{loan => (                   {/* each row is a HANDLE — <loan.name view/> works */}
    <loan.name view />
  )}</Loans.Items>
  <Loans.Pagination />
</Loans.Index>

<Loans.One id={5}>                          {/* the beheaded edit form — context sets the id */}
  <loan.Form>…</loan.Form>
</Loans.One>
```

Drop-down control at every altitude (the "only works if" condition):
- `<Loans.Filters.stage />` — place/omit/reorder filters individually.
- `<Loans.Filters.amount edit="slider" className="…" />` — presenter
  override + styling passthrough, same contract as form fields.
- `filters={state} onFiltersChange={…}` on Index — fully controlled mode.
- `Loans.Index.use()` — the context accessor for custom widgets
  (`ix.set('stage', ['draft'])`, `ix.facets`, `ix.rows`).
- The raw hooks stay exported. Components for the 90%; hooks demoted to
  plumbing, never deleted.

`Items` rows are read-mode handles built from `fieldMeta` — the same
presenter resolution as forms, view-mode, abilities-aware if the index
ever ships an abilities mask. One presenter per model presents under ANY
door, because the door's projection constrains it at runtime. (This
already works — it's the existing architecture, finally load-bearing.)

---

## 5. esindex — the payoff

Because the filter surface is *declared data*, the query engine is an
implementation detail. `<Deals.ESIndex/>` is NOT a separate component —
it's the same `<Deals.Index/>` with the engine chosen server-side:

```ts
index: { engine: 'prefer-es', filterable: [...], filters: {...} }
```

**The SearchEngine contract** (phase-1 interface, from the locked design):

```ts
interface SearchEngine {
  search(req: { doorScopeIds?: ..., q?, filters, sort, page })
    : Promise<{ ids: number[]; total: number; facets?: Record<string, Record<string, number>> }>
}
```

- **ES returns RANKED IDS ONLY.** Hydration is `scopedRelation.where({ id:
  ids })` + reorder by rank — the door's scope and expose ceiling apply to
  the hydration query, so ES can never leak a row the door wouldn't serve.
  Worst case (index drift) you get fewer rows than ids, never wrong rows.
- **Tier-1 filters compile mechanically** to ES DSL (facet → terms, range →
  range, refFilter → terms, q → multi_match over `searchable`). The Attr
  meta that derives the widget also derives the ES mapping — one source.
- **Tier-2 named filters declare an ES half** when the engine is on:
  `esApply: (params, ctx) => ({ range: { amount: { gte: ctx.org.bigThreshold } } })`.
  A named filter WITHOUT `esApply` forces SQL post-filtering or (better,
  fail-loud) a build-time codegen error under `engine: 'es'` — no silent
  wrong results.
- **`'prefer-es'` degrades** to the SQL path (`Relation` + ilike) when ES
  is down — same request, same response shape, no facets. The client
  renders chips without counts. Nothing breaks.
- **Facet counts are the killer feature**: ES aggregations ride back as
  `facets`, the facet presenter renders "draft (12)". This is the moment
  the demo goes from CRUD to product.

**Sync** (locked design, unchanged): `afterCommit` → upsert/delete doc;
`reindex` task for backfill; mappings generated from Attr meta (codegen
phase). Lives in a separate `@active-drizzle/search-es` package; core only
knows the `SearchEngine` interface.

---

## 6. Relation to @mutation buttons (the other half of "more power")

Same philosophy, sibling feature, separate build: decorator `if:` guard →
per-record verdict in the envelope's `can` → generated `<deal.Archive/>`
button that greys itself honestly → params declaration → implicit form.
The index components and mutation buttons share nothing mechanically but
everything philosophically: *the server declares, the wire carries
verdicts and meta, components wear them, the client can only narrow.*

---

## 7. Phasing (each phase lands green + demo'd before the next)

- **Phase 0 — IndexSession + wire contract.** The headless state class;
  `filters` param parsing server-side; tier-1 allowlist + codec-normalized
  application; stripped-filter issues. Tests: unit (session), controller
  (allowlist/codec/narrowing-only). No UI yet.
- **Phase 1 — meta + components (SQL engine).** `indexMeta` emission;
  filter presenter kinds + defaults; `Index/Search/Filters/Items/
  Pagination` compound components; `One id={}` context head. Demo: deals
  list gets stage chips + amount range + owner picker filter with zero
  app-side wiring. Browser-verified.
- **Phase 2 — named filters + URL sync + controlled mode.** Tier-2
  `filters:` with `apply`; `urlSync`; `filters/onFiltersChange`;
  `Index.use()`. Demo: "big deals" toggle whose meaning lives only on the
  server.
- **Phase 3 — SearchEngine + ES adapter.** Interface + `'prefer-es'`
  fallback in core-controller; `@active-drizzle/search-es` (client, sync,
  reindex, mappings-from-Attr-meta); facet counts through the response
  and into the facet presenter. Testcontainers ES in CI. Demo: same page,
  `engine: 'prefer-es'`, counts appear; kill ES, page still works.
- **Phase 4 — @mutation buttons** (parallel-safe with 1–3): verdicts,
  `<handle.Action/>`, implicit params form.

## 8. Open decisions (Daniel)

1. Filter param for money ranges: decimal-strings (codec-consistent,
   recommended) vs numbers on the wire.
2. Facet counts WITHOUT ES (SQL `GROUP BY` per facet): ship in phase 1 as
   an opt-in (`facets: true`, N+1 queries per facet field), or ES-only?
3. `urlSync` default on or off? (Recommended: off, one prop to enable.)
4. Does `Items` ever need an abilities mask per row (per-row edit links),
   or is view-mode meta enough for v1? (Recommended: view-only v1.)
