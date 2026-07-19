/**
 * The index surface — DESIGN-index-filters-esindex made real (PG engine).
 *
 *   <Deals.Index scope="open">
 *     <Deals.Search />
 *     <Deals.Filters />
 *     <Deals.Items>{deal => <deal.name view />}</Deals.Items>
 *     <Deals.Pagination />
 *   </Deals.Index>
 *
 * The head is a component, not a hook: Index runs the query and provides
 * an IndexSession (the FormSession sibling for list state) via context.
 * Every child — the generated widgets AND app custom widgets through
 * `Surface.use()` — reads/writes the same session. Filters/search/sort are
 * DECLARED server-side (allowlisted, codec-normalized, narrowing-only);
 * this file only renders what the generated indexMeta says exists.
 *
 * Drop-down control at every altitude: place `<Surface.Filters.stage/>`
 * individually, pass className everywhere, or drive the session by hand
 * with `Surface.use()`. The raw hooks remain exported — components for
 * the 90%, hooks demoted to plumbing.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type FC, type ReactNode } from 'react'
import { parseControllerError } from './errors.js'

// ── IndexSession — headless list state ───────────────────────────────────────

export interface IndexState {
  scopes?: string[] | undefined
  q?: string | undefined
  filters: Record<string, any>
  sort?: { field: string; dir: 'asc' | 'desc' } | undefined
  page: number
  perPage?: number | undefined
  /** Facet-count ask — counts are OPT-IN (each is a GROUP BY server-side);
   *  count-consuming views (Sidebar, Board) request what they render. */
  facets?: boolean | string[] | undefined
}

export class IndexSession {
  private state: IndexState
  private listeners = new Set<() => void>()
  private version = 0
  private qTimer: ReturnType<typeof setTimeout> | null = null

  constructor(initial: Partial<IndexState> = {}) {
    this.state = { filters: {}, page: 0, ...initial }
  }

  get(): IndexState { return this.state }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getVersion(): number { return this.version }
  private notify(): void {
    this.version++
    for (const fn of this.listeners) fn()
  }
  private patch(p: Partial<IndexState>): void {
    this.state = { ...this.state, ...p }
    this.notify()
  }

  /** Debounced search input — resets to page 0. */
  setQ(q: string, debounceMs = 300): void {
    if (this.qTimer) clearTimeout(this.qTimer)
    this.qTimer = setTimeout(() => { this.patch({ q: q || undefined, page: 0 }) }, debounceMs)
  }
  /** Set (or clear with undefined/null/empty-array) one filter — resets paging. */
  setFilter(name: string, value: any): void {
    const filters = { ...this.state.filters }
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === false || value === '') {
      delete filters[name]
    } else {
      filters[name] = value
    }
    this.patch({ filters, page: 0 })
  }
  clearFilters(): void { this.patch({ filters: {}, q: undefined, page: 0 }) }
  /** Ask the server for facet counts (merged across callers; `true` wins).
   *  Views that RENDER counts call this — nobody else pays for them. */
  requestFacets(spec: true | string[]): void {
    const cur = this.state.facets
    if (cur === true) return
    if (spec === true) { this.patch({ facets: true }); return }
    const merged = [...new Set([...(Array.isArray(cur) ? cur : []), ...spec])]
    const same = Array.isArray(cur) && merged.length === cur.length
    if (!same) this.patch({ facets: merged })
  }
  setSort(field: string, dir: 'asc' | 'desc' = 'asc'): void { this.patch({ sort: { field, dir }, page: 0 }) }
  setPage(page: number): void { this.patch({ page: Math.max(0, page) }) }

  /** The wire shape for the index request. */
  params(): Record<string, any> {
    const s = this.state
    return {
      ...(s.scopes?.length ? { scopes: s.scopes } : {}),
      ...(s.q ? { q: s.q } : {}),
      ...(Object.keys(s.filters).length ? { filters: s.filters } : {}),
      ...(s.sort ? { sort: s.sort } : {}),
      page: s.page,
      ...(s.perPage ? { perPage: s.perPage } : {}),
      ...(s.facets !== undefined ? { facets: s.facets } : {}),
    }
  }
}

// ── Generated meta shape ─────────────────────────────────────────────────────

export interface IndexFilterMeta {
  kind: 'facet' | 'toggle' | 'range' | 'dateRange' | 'text' | string
  label: string
  /** facet: the value labels (enum/state labels ride the wire as-is). */
  options?: readonly string[]
}

export interface IndexMeta {
  sortable?: readonly string[]
  defaultSort?: { field: string; dir: 'asc' | 'desc' }
  searchable?: boolean
  filters?: Record<string, IndexFilterMeta>
}

// ── Filter presenters — the SOCKET, mirroring form presenters ────────────────
//
// The framework yields STATE; the app owns the bulbs. Same contract as
// <deal.name edit="myPresenter">: register once, resolve by kind, override
// per call site, or drop to the render-prop for full control:
//
//   registerFilterPresenter('segmented', { kind: 'facet', component: MySegmented })
//   setDefaultFilterPresenters({ facet: 'segmented' })
//   <Deals.Filters.stage presenter="segmented" />          // per-site override
//   <Deals.Filter name="stage">{p => <MyWidget {...p}/>}</Deals.Filter>
//
// Built-in SCAFFOLDING presenters keep <Deals.Filters/> working out of the
// box but announce themselves (console, data-ad-scaffold) — they are demo
// furniture, not the product. Ship your own.

export interface FilterPresenterProps {
  name: string
  meta: IndexFilterMeta
  value: any
  /** Write the filter (session.setFilter — resets paging, clears on empty). */
  set: (value: any) => void
  clear: () => void
  session: IndexSession
  /** Disjunctive facet counts (index.facets) — { label: n }, all OTHER
   *  filters applied, this field's own filter excluded. */
  counts?: Record<string, number>
}

export interface FilterPresenterDef {
  /** The filter kind this presenter serves, or '*' for any. */
  kind: string
  component: FC<FilterPresenterProps>
}

/** What <Surface.Board> hands your presenter — data + legal moves only. */
export interface BoardApi {
  groupBy: string
  columns: Array<{ key: string; label: string; rows: any[]; count: number | null }>
  /** Move a row to a column. State-machine fields resolve the TRANSITION
   *  (drag draft→submitted IS advance('submit')); plain fields PATCH the
   *  column value. Server re-guards either way. */
  move: (row: any, toKey: string) => Promise<any>
  /** Client-side legality (transition graph) — for drag affordances;
   *  the server's guard is the law. */
  canMove: (row: any, toKey: string) => boolean
  isLoading: boolean
}

/** One option row in a Sidebar facet group. */
export interface SidebarOption {
  value: string
  /** Disjunctive count under every OTHER active filter — null when the
   *  controller doesn't declare index.facets. */
  count: number | null
  active: boolean
  /** Multi-select toggle: adds/removes this value from the group's filter. */
  toggle: () => void
}

/** One group (= one declared filter) in the Sidebar. */
export interface SidebarGroup {
  name: string
  label: string
  kind: string
  /** Facet groups: every DECLARED option, zero-filled — an option that
   *  matches nothing still renders (count 0), it never vanishes. */
  options: SidebarOption[]
  active: boolean
  value: any
  set: (v: any) => void
  clear: () => void
}

/** What <Surface.Sidebar> hands your presenter — the whole faceted-search
 *  panel as DATA: groups, live counts, search, clear-all. */
export interface SidebarApi {
  groups: SidebarGroup[]
  /** Number of groups with an active filter. */
  activeCount: number
  clearAll: () => void
  /** Search wiring (present when the index declares search). */
  search: { q: string; setQ: (q: string) => void } | null
  /** Total results under the CURRENT narrowing. */
  total: number | null
  isLoading: boolean
}

/** What <Surface.Table> hands your presenter. */
export interface TableApi {
  columns: Array<{ name: string; label: string; kind: string; sortable: boolean }>
  rows: any[]
  sort: { field: string; dir: 'asc' | 'desc' } | undefined
  setSort: (field: string, dir?: 'asc' | 'desc') => void
  /** Row-level PATCH (coherence-wired) for inline edits — may be absent. */
  mutateRow?: (id: number | string, data: Record<string, any>) => Promise<any>
  isLoading: boolean
}

const _filterRegistry = new Map<string, FilterPresenterDef>()
let _filterDefaults: Record<string, string> = {}

export function registerFilterPresenter(name: string, def: FilterPresenterDef): void {
  _filterRegistry.set(name, def)
}
export function setDefaultFilterPresenters(map: Record<string, string>): void {
  _filterDefaults = { ..._filterDefaults, ...map }
}
export function clearFilterPresenters(): void {
  _filterRegistry.clear()
  _filterDefaults = {}
}

let _scaffoldWarned = false
function warnScaffold(name: string): void {
  if (_scaffoldWarned) return
  _scaffoldWarned = true
  console.info(
    `[active-drizzle] filter "${name}" is rendering a SCAFFOLDING presenter (unstyled demo furniture). `
    + `Register real ones: registerFilterPresenter('myFacet', { kind: 'facet', component }) + `
    + `setDefaultFilterPresenters({ facet: 'myFacet' }) — or use <Surface.Filter name>{p => …}</Surface.Filter>.`,
  )
}

// ── Surface factory (consumed by codegen) ────────────────────────────────────

export interface IndexSurfaceConfig {
  meta: IndexMeta
  /** Injected by codegen: the controller's index query hook, fed the wire params. */
  useIndexQuery: (params: Record<string, any>) => { data: any; isLoading: boolean; isError: boolean }
  /** Row → typed handle (view-mode form handle per row). */
  makeRowHandle: (row: Record<string, any>) => any
  /** Injected by codegen for Surface.One: the generated edit-form hook. */
  useEditForm?: (id: number, opts?: any) => { status: string; form: any }
  /** State machine meta (emitted when the model declares Attr.state) —
   *  powers <Surface.Board>: states are columns, transitions are moves. */
  stateMeta?: {
    field: string
    states: string[]
    transitions: Array<{ event: string; from: string[] | '*'; to: string }>
  }
  /** Projected field meta — powers Table columns and Skeletons. */
  fields?: Array<{ name: string; kind: string; label: string }>
  /** Row-level PATCH transport (coherence-wired by codegen) — powers
   *  Board.move and inline table edits. */
  mutateRow?: (id: number | string, data: Record<string, any>) => Promise<any>
  /**
   * Aggregation/computed GET @actions as first-class surface members —
   * `<Deals.Stats>{(data) => …}</Deals.Stats>`. Keyed PascalCase; each value
   * is the generated useQuery hook. Their cache keys live under the family
   * root, so every mutation's coherence fan-out refetches them for free.
   */
  queries?: Record<string, () => { data: any; isLoading: boolean; isError: boolean }>
}

interface IndexCtx {
  session: IndexSession
  meta: IndexMeta
  query: { data: any; isLoading: boolean; isError: boolean }
}

export interface IndexSurface {
  Index: FC<{
    children?: ReactNode
    scope?: string | string[]
    sort?: { field: string; dir: 'asc' | 'desc' }
    perPage?: number
    className?: string
  }>
  Search: FC<{ placeholder?: string; className?: string; debounceMs?: number }>
  Filters: FC<{ className?: string }> & Record<string, any>
  /** Render-prop filter — full control, no registry: <Surface.Filter name="x">{p => …}</Surface.Filter> */
  Filter: FC<{ name: string; children: (p: FilterPresenterProps) => ReactNode }>
  Items: FC<{ children: (handle: any, row: Record<string, any>) => ReactNode; empty?: ReactNode }>
  Pagination: FC<{ className?: string }>
  One: FC<{ id: number; poll?: { every: number; until?: (r: any) => boolean }; children: (form: any) => ReactNode; loading?: ReactNode }>
  /**
   * The faceted-search side panel — the "if you filter by this, counts
   * become A/B/C" surface, one component. Groups from the declared
   * filters, counts from the disjunctive facet engine, search included.
   * Scaffold renders caret-collapsible groups with count badges; per-group
   * presenters resolve through the filter-presenter registry; the
   * render-prop hands you the whole SidebarApi.
   */
  Sidebar: FC<{
    groups?: string[]
    presenters?: Record<string, string | FC<FilterPresenterProps>>
    children?: (api: SidebarApi) => ReactNode
    className?: string
  }>
  /** Error surface — parsed controller error, or nothing while healthy. */
  Error: FC<{ children?: (e: { kind: string; message: string; parsed: any }) => ReactNode; className?: string }>
  /** Empty surface — renders only on an empty page, and knows WHY. */
  Empty: FC<{ children?: (api: { reason: 'no-records' | 'no-matches'; clearFilters: () => void }) => ReactNode; className?: string }>
  /** The state machine as columns — data only; you paint the board. */
  Board: FC<{ groupBy?: string; children?: (b: BoardApi) => ReactNode; className?: string }>
  /** Allowlisted aggregation — points, no chart lib. `bucket` time-buckets a date x. */
  Chart: FC<{ x: string; y?: string; bucket?: 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'; filtered?: boolean; children?: (points: Array<{ x: string; y: number }>, q: any) => ReactNode; className?: string }>
  /** Allowlisted scalar aggregation — one number. */
  Metric: FC<{ agg: string; filtered?: boolean; children?: (value: any, q: any) => ReactNode; className?: string }>
  /** Data grid contract — columns/rows/sort; scaffold table by default. */
  Table: FC<{ columns?: string[]; children?: (t: TableApi) => ReactNode; className?: string }>
  /** Loading placeholders shaped like the real thing (field meta). */
  FormSkeleton: FC<{ className?: string }>
  ListSkeleton: FC<{ rows?: number; className?: string }>
  /** Context accessor for custom widgets: session + live query + meta. */
  use: () => { session: IndexSession; state: IndexState; meta: IndexMeta; rows: any[]; pagination: any; isLoading: boolean }
  /** Query components from cfg.queries (aggregation @actions), keyed PascalCase. */
  [query: string]: any
}

export function createIndexSurface(cfg: IndexSurfaceConfig): IndexSurface {
  const Ctx = createContext<IndexCtx | null>(null)

  const useCtx = (): IndexCtx => {
    const c = useContext(Ctx)
    if (!c) throw new Error('[active-drizzle] index component used outside its <Surface.Index> provider')
    return c
  }

  const useSessionState = (session: IndexSession): IndexState => {
    useSyncExternalStore(
      (cb) => session.subscribe(cb),
      () => session.getVersion(),
      () => session.getVersion(),
    )
    return session.get()
  }

  const Index: IndexSurface['Index'] = ({ children, scope, sort, perPage, className }) => {
    const ref = useRef<IndexSession | null>(null)
    if (!ref.current) {
      ref.current = new IndexSession({
        scopes: scope ? (Array.isArray(scope) ? scope : [scope]) : undefined,
        sort: sort ?? cfg.meta.defaultSort,
        perPage,
      })
    }
    const session = ref.current
    useSessionState(session)
    const query = cfg.useIndexQuery(session.params())
    const value = useMemo(() => ({ session, meta: cfg.meta, query }), [session, query.data, query.isLoading, query.isError])
    return (
      <Ctx.Provider value={value}>
        <div {...(className !== undefined ? { className } : {})}>{children}</div>
      </Ctx.Provider>
    )
  }
  ;(Index as any).displayName = 'AdIndex'

  const Search: IndexSurface['Search'] = ({ placeholder, className, debounceMs }) => {
    const { session, meta } = useCtx()
    if (!meta.searchable) return null
    return (
      <input
        type="search"
        {...(className !== undefined ? { className } : {})}
        placeholder={placeholder ?? 'Search…'}
        defaultValue={session.get().q ?? ''}
        onChange={(e) => session.setQ(e.target.value, debounceMs)}
      />
    )
  }
  ;(Search as any).displayName = 'AdIndexSearch'

  // ── SCAFFOLDING presenters — demo furniture with a name tag ─────────────
  const ScaffoldFacet: FC<FilterPresenterProps> = ({ name, meta: fm, value, set }) => {
    const selected: string[] = Array.isArray(value) ? value : value != null ? [value] : []
    return (
      <span data-ad-filter={name} data-ad-scaffold role="group" aria-label={fm.label}>
        {(fm.options ?? []).map(opt => (
          <button key={opt} type="button"
            data-active={selected.includes(opt) || undefined}
            aria-pressed={selected.includes(opt)}
            onClick={() => set(selected.includes(opt) ? selected.filter(o => o !== opt) : [...selected, opt])}>
            {opt}
          </button>
        ))}
      </span>
    )
  }
  const ScaffoldToggle: FC<FilterPresenterProps> = ({ name, meta: fm, value, set }) => (
    <label data-ad-filter={name} data-ad-scaffold>
      <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
      {fm.label}
    </label>
  )
  const ScaffoldText: FC<FilterPresenterProps> = ({ name, meta: fm, value, set }) => (
    <input data-ad-filter={name} data-ad-scaffold placeholder={fm.label}
      defaultValue={value ?? ''} onChange={(e) => set(e.target.value)} />
  )

  /**
   * The SOCKET. Resolution order (mirrors form fields):
   *   props.presenter (component | registered name)
   *   → setDefaultFilterPresenters[kind]
   *   → scaffolding (announced once, marked data-ad-scaffold)
   */
  const FilterWidget: FC<{ name: string; presenter?: string | FC<FilterPresenterProps>; className?: string; props?: Record<string, any> }> = ({ name, presenter, className, props: extra }) => {
    const { session, meta, query } = useCtx()
    const fm = meta.filters?.[name]
    if (!fm) return null
    const state = useSessionState(session)

    let Component: FC<FilterPresenterProps> | null = null
    let scaffold = false
    if (typeof presenter === 'function') {
      Component = presenter
    } else {
      const presenterName = presenter ?? _filterDefaults[fm.kind] ?? _filterDefaults['*']
      if (presenterName) {
        const def = _filterRegistry.get(presenterName)
        if (!def) throw new Error(`[active-drizzle] filter presenter "${presenterName}" (filter "${name}") is not registered`)
        if (def.kind !== '*' && def.kind !== fm.kind) {
          throw new Error(`[active-drizzle] filter presenter "${presenterName}" serves kind "${def.kind}", not "${fm.kind}" (filter "${name}")`)
        }
        Component = def.component
      }
    }
    if (!Component) {
      scaffold = true
      Component = fm.kind === 'facet' ? ScaffoldFacet : fm.kind === 'toggle' ? ScaffoldToggle : ScaffoldText
    }
    if (scaffold) warnScaffold(name)

    const counts = (query.data as any)?.facets?.[name]
    const p: FilterPresenterProps = {
      name,
      meta: fm,
      value: state.filters[name],
      set: (v: any) => session.setFilter(name, v),
      clear: () => session.setFilter(name, undefined),
      session,
      ...(counts !== undefined ? { counts } : {}),
      ...(extra ?? {}),
    }
    return (
      <span {...(className !== undefined ? { className } : {})} data-ad-filter-slot={name}>
        <Component {...p} />
      </span>
    )
  }

  const FiltersBase: FC<{ className?: string }> = ({ className }) => {
    const { meta } = useCtx()
    const names = Object.keys(meta.filters ?? {})
    if (!names.length) return null
    return (
      <div {...(className !== undefined ? { className } : {})} data-ad-filters>
        {names.map(n => <FilterWidget key={n} name={n} />)}
      </div>
    )
  }
  ;(FiltersBase as any).displayName = 'AdIndexFilters'
  // Per-filter placement + presenter override: <Surface.Filters.stage presenter="segmented"/>
  const Filters = new Proxy(FiltersBase as IndexSurface['Filters'], {
    get(target, prop: string | symbol) {
      if (typeof prop === 'string' && cfg.meta.filters?.[prop]) {
        const Single: FC<{ presenter?: string | FC<FilterPresenterProps>; className?: string; props?: Record<string, any> }> =
          (p) => <FilterWidget name={prop} {...p} />
        Single.displayName = `AdIndexFilter(${prop})`
        return Single
      }
      return (target as any)[prop]
    },
  })

  // Full-control escape hatch — no registry, no defaults, just state:
  // <Surface.Filter name="stage">{({ value, set, meta }) => …}</Surface.Filter>
  const Filter: FC<{ name: string; children: (p: FilterPresenterProps) => ReactNode }> = ({ name, children }) => {
    const { session, meta, query } = useCtx()
    const fm = meta.filters?.[name]
    const state = useSessionState(session)
    if (!fm) return null
    const counts = (query.data as any)?.facets?.[name]
    return (
      <>{children({
        name,
        meta: fm,
        ...(counts !== undefined ? { counts } : {}),
        value: state.filters[name],
        set: (v: any) => session.setFilter(name, v),
        clear: () => session.setFilter(name, undefined),
        session,
      })}</>
    )
  }
  ;(Filter as any).displayName = 'AdIndexFilterRP'

  const Items: IndexSurface['Items'] = ({ children, empty }) => {
    const { query } = useCtx()
    const rows: any[] = query.data?.data ?? query.data?.rows ?? (Array.isArray(query.data) ? query.data : [])
    // handle identity per row id — presenters keep component identity across
    // refetches; a FRESH row object rebuilds the handle (cache beside the
    // proxy, never on it: the handle proxy swallows underscore props)
    const handles = useRef(new Map<any, { row: any; handle: any }>())
    if (!rows.length) return <>{empty ?? null}</>
    return (
      <>
        {rows.map((row: any, i: number) => {
          const key = row?.id ?? i
          let entry = handles.current.get(key)
          if (!entry || entry.row !== row) {
            entry = { row, handle: cfg.makeRowHandle(row) }
            handles.current.set(key, entry)
          }
          return <React.Fragment key={key}>{children(entry.handle, row)}</React.Fragment>
        })}
      </>
    )
  }
  ;(Items as any).displayName = 'AdIndexItems'

  const Pagination: IndexSurface['Pagination'] = ({ className }) => {
    const { session, query } = useCtx()
    const p = query.data?.pagination
    if (!p || p.totalPages <= 1) return null
    return (
      <nav {...(className !== undefined ? { className } : {})} data-ad-pagination aria-label="pagination">
        <button type="button" disabled={p.page <= 0} onClick={() => session.setPage(p.page - 1)}>‹</button>
        <span> {p.page + 1} / {p.totalPages} </span>
        <button type="button" disabled={!p.hasMore} onClick={() => session.setPage(p.page + 1)}>›</button>
      </nav>
    )
  }
  ;(Pagination as any).displayName = 'AdIndexPagination'

  const One: IndexSurface['One'] = ({ id, poll, children, loading }) => {
    if (!cfg.useEditForm) throw new Error('[active-drizzle] Surface.One requires an envelope controller (no edit form was generated)')
    const { status, form } = cfg.useEditForm(id, poll ? { poll } : undefined)
    if (status !== 'ready' || !form) return <>{loading ?? null}</>
    return <>{children(form)}</>
  }
  ;(One as any).displayName = 'AdOne'

  const use: IndexSurface['use'] = () => {
    const { session, meta, query } = useCtx()
    const state = useSessionState(session)
    return {
      session,
      state,
      meta,
      rows: query.data?.data ?? [],
      pagination: query.data?.pagination ?? null,
      isLoading: query.isLoading,
    }
  }

  // ── Sidebar: the faceted-search panel — ES's killer feature as ONE tag ───
  // Everything is derived: groups from the declared filters, options from
  // the enum/state labels, counts from the DISJUNCTIVE facet engine (each
  // group's counts respond to every OTHER active filter + the live search,
  // its own filter excluded — so "if you filter by this, counts become
  // A/B/C" holds no matter which engine answered q: adapter, FTS, ilike).
  const useSidebarApi = (groupNames?: string[]): SidebarApi => {
    const { session, meta, query } = useCtx()
    const state = useSessionState(session)
    // The sidebar RENDERS counts, so the sidebar ASKS for them — a page
    // without a count-consumer never pays for the GROUP BYs
    const facetGroupNames = (groupNames ?? Object.keys(meta.filters ?? {}))
      .filter((n) => meta.filters?.[n]?.kind === 'facet')
    useEffect(() => {
      if (facetGroupNames.length) session.requestFacets(facetGroupNames)
    }, [session, facetGroupNames.join(',')])
    const facets = (query.data as any)?.facets as Record<string, Record<string, number>> | undefined
    const names = groupNames ?? Object.keys(meta.filters ?? {})
    const groups: SidebarGroup[] = names.flatMap((name) => {
      const fm = meta.filters?.[name]
      if (!fm) return []
      const raw = state.filters[name]
      const selected: string[] = Array.isArray(raw) ? raw.map(String) : raw != null && raw !== false ? [String(raw)] : []
      const counts = facets?.[name]
      // Only FACET groups synthesize option rows; toggles/ranges/text keep
      // their widget semantics (options [] → the group body renders the
      // filter presenter instead of checkbox rows)
      const declared = fm.kind === 'facet'
        ? ((fm.options as string[] | undefined) ?? (counts ? Object.keys(counts) : []))
        : []
      const options: SidebarOption[] = declared.map((value) => ({
        value,
        count: counts ? (counts[value] ?? 0) : null,
        active: selected.includes(value),
        toggle: () => {
          const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
          session.setFilter(name, next.length ? next : undefined)
        },
      }))
      return [{
        name,
        label: fm.label ?? name,
        kind: fm.kind,
        options,
        active: selected.length > 0 || (fm.kind !== 'facet' && raw != null && raw !== false && raw !== ''),
        value: raw,
        set: (v: any) => session.setFilter(name, v),
        clear: () => session.setFilter(name, undefined),
      }]
    })
    return {
      groups,
      activeCount: groups.filter((g) => g.active).length,
      clearAll: () => session.clearFilters(),
      search: meta.searchable ? { q: state.q ?? '', setQ: (q: string) => session.setQ(q) } : null,
      total: query.data?.pagination?.totalCount ?? null,
      isLoading: query.isLoading,
    }
  }

  const Sidebar: IndexSurface['Sidebar'] = ({ groups: groupNames, presenters, children, className }) => {
    const api = useSidebarApi(groupNames)
    if (children) return <aside data-ad-sidebar="" {...(className !== undefined ? { className } : {})}>{children(api)}</aside>
    // Scaffold: native <details> carets, checkbox rows with count badges,
    // zero-count options dimmed (never hidden). A per-group presenter —
    // passed here or registered for the kind — takes the group body over.
    return (
      <aside data-ad-sidebar="" data-ad-scaffold="" {...(className !== undefined ? { className } : {})}>
        {api.search && (
          <input type="search" data-ad-sidebar-search="" placeholder="Search…"
            defaultValue={api.search.q} onChange={(e) => api.search!.setQ(e.target.value)} />
        )}
        {api.activeCount > 0 && (
          <button type="button" data-ad-sidebar-clear="" onClick={api.clearAll}>
            Clear {api.activeCount} filter{api.activeCount === 1 ? '' : 's'} ✕
          </button>
        )}
        {api.groups.map((g) => {
          const override = presenters?.[g.name] ?? _filterDefaults[g.kind] ?? _filterDefaults['*']
          return (
            <details key={g.name} open data-ad-sidebar-group={g.name}>
              <summary>{g.label}{g.active ? ' •' : ''}</summary>
              {override != null ? (
                <FilterWidget name={g.name} presenter={override} />
              ) : g.options.length > 0 ? (
                g.options.map((o) => (
                  <label key={o.value} data-ad-sidebar-option={o.value}
                    style={o.count === 0 && !o.active ? { opacity: 0.45 } : undefined}>
                    <input type="checkbox" checked={o.active} onChange={o.toggle} />
                    {' '}{o.value}
                    {o.count != null && <span data-ad-sidebar-count=""> {o.count}</span>}
                  </label>
                ))
              ) : (
                <FilterWidget name={g.name} />
              )}
            </details>
          )
        })}
        {api.total != null && <p data-ad-sidebar-total="">{api.total} result{api.total === 1 ? '' : 's'}</p>}
      </aside>
    )
  }
  ;(Sidebar as any).displayName = 'AdSidebar'

  // ── Error: parsed controller error or nothing (data-to-presenter) ────────
  const ErrorC: IndexSurface['Error'] = ({ children, className }) => {
    const { query } = useCtx()
    if (!query.isError) return null
    const parsed = parseControllerError((query as any).error)
    const kind = parsed?.isForbidden ? 'forbidden'
      : parsed?.isNotFound ? 'not-found'
      : parsed?.isUnauthorized ? 'unauthenticated'
      : parsed?.isValidation ? 'invalid-request'
      : 'unknown'
    const message = parsed?.message ?? 'Something went wrong'
    if (children) return <div role="alert" data-ad-error={kind} {...(className !== undefined ? { className } : {})}>{children({ kind, message, parsed })}</div>
    return <div role="alert" data-ad-error={kind} data-ad-scaffold="" {...(className !== undefined ? { className } : {})}>{message}</div>
  }
  ;(ErrorC as any).displayName = 'AdIndexError'

  // ── Empty: an empty page that knows WHY (server-computed emptyReason) ────
  const Empty: IndexSurface['Empty'] = ({ children, className }) => {
    const { session, query } = useCtx()
    const rows = query.data?.data ?? []
    if (query.isLoading || query.isError || rows.length > 0 || query.data == null) return null
    const reason: 'no-records' | 'no-matches' = (query.data as any)?.emptyReason ?? 'no-records'
    const clearFilters = () => session.clearFilters()
    if (children) return <div data-ad-empty={reason} {...(className !== undefined ? { className } : {})}>{children({ reason, clearFilters })}</div>
    return (
      <div data-ad-empty={reason} data-ad-scaffold="" {...(className !== undefined ? { className } : {})}>
        {reason === 'no-matches'
          ? <>No matches. <button type="button" onClick={clearFilters}>Clear filters</button></>
          : <>Nothing here yet.</>}
      </div>
    )
  }
  ;(Empty as any).displayName = 'AdIndexEmpty'

  // ── Board: the state machine AS columns — data only, you paint it ────────
  // states = columns, a drag IS a transition (advance via _event), guards
  // stay server-enforced; plain enum/facet fields group + PATCH instead.
  const Board: IndexSurface['Board'] = ({ groupBy, children, className }) => {
    const { session, meta, query } = useCtx()
    const sm = cfg.stateMeta
    const field = groupBy ?? sm?.field
    if (!field) throw new Error('[active-drizzle] <Board> needs groupBy (this model declares no state machine)')
    const rows: any[] = query.data?.data ?? []
    // Column totals come from facet counts — the board asks for ITS field
    useEffect(() => {
      if (meta.filters?.[field]) session.requestFacets([field])
    }, [session, field])
    const isState = sm != null && field === sm.field
    const keys: string[] = isState ? sm!.states
      : (meta.filters?.[field]?.options as string[] | undefined) ?? [...new Set(rows.map((r) => String(r[field])))]
    const facetCounts = (query.data as any)?.facets?.[field]
    const columns = keys.map((key) => ({
      key,
      label: key,
      rows: rows.filter((r) => String(r[field]) === key),
      count: facetCounts?.[key] ?? null,
    }))
    const findTransition = (fromKey: string, toKey: string) =>
      sm!.transitions.find((t) => t.to === toKey && (t.from === '*' || t.from.includes(fromKey)))
    const canMove = (row: any, toKey: string): boolean => {
      if (String(row[field]) === toKey) return false
      if (!cfg.mutateRow) return false
      if (isState) return findTransition(String(row[field]), toKey) != null
      return true
    }
    const move = async (row: any, toKey: string): Promise<any> => {
      if (!cfg.mutateRow) throw new Error('[active-drizzle] Board.move needs a row transport (envelope controller)')
      if (isState) {
        const tr = findTransition(String(row[field]), toKey)
        if (!tr) throw new Error(`[active-drizzle] no transition from '${String(row[field])}' to '${toKey}'`)
        return cfg.mutateRow(row.id, { _event: tr.event })
      }
      return cfg.mutateRow(row.id, { [field]: toKey })
    }
    const api: BoardApi = { groupBy: field, columns, move, canMove, isLoading: query.isLoading }
    if (children) return <div data-ad-board={field} {...(className !== undefined ? { className } : {})}>{children(api)}</div>
    // Scaffold: honest columns with legal-move buttons — replace with your DnD
    return (
      <div data-ad-board={field} data-ad-scaffold="" style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }} {...(className !== undefined ? { className } : {})}>
        {columns.map((c) => (
          <div key={c.key} data-ad-board-column={c.key} style={{ flex: 1 }}>
            <strong>{c.label}{c.count != null ? ` (${c.count})` : ''}</strong>
            {c.rows.map((r) => (
              <div key={r.id} data-ad-board-card="">
                {String(r.name ?? r.title ?? `#${r.id}`)}
                {columns.filter((t) => canMove(r, t.key)).map((t) => (
                  <button key={t.key} type="button" onClick={() => void move(r, t.key)}>→ {t.key}</button>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }
  ;(Board as any).displayName = 'AdBoard'

  // ── Chart / Metric: allowlisted aggregation → data, NEVER a chart lib ────
  // Inside <Index> they inherit the live filters (filtered={false} opts out);
  // standalone they aggregate the whole door scope.
  const useAggParams = (filtered: boolean, extra: Record<string, any>) => {
    const ctx = useContext(Ctx)
    useSyncExternalStore(
      (cb) => (ctx ? ctx.session.subscribe(cb) : () => {}),
      () => (ctx ? ctx.session.getVersion() : 0),
      () => (ctx ? ctx.session.getVersion() : 0),
    )
    const base = filtered && ctx ? ctx.session.params() : {}
    return { ...base, page: 0, perPage: 0, ...extra }
  }
  const Chart: IndexSurface['Chart'] = ({ x, y = 'count', bucket, filtered = true, children, className }) => {
    const params = useAggParams(filtered, { chart: { x, y, ...(bucket ? { bucket } : {}) } })
    const q = cfg.useIndexQuery(params)
    const points: Array<{ x: string; y: number }> = (q.data as any)?.chart ?? []
    if (children) return <>{children(points, q)}</>
    return <pre data-ad-scaffold="" data-ad-chart={x} {...(className !== undefined ? { className } : {})}>{JSON.stringify(points)}</pre>
  }
  ;(Chart as any).displayName = 'AdChart'
  const Metric: IndexSurface['Metric'] = ({ agg, filtered = true, children, className }) => {
    const params = useAggParams(filtered, { metric: agg })
    const q = cfg.useIndexQuery(params)
    const value = (q.data as any)?.metric ?? null
    if (children) return <>{children(value, q)}</>
    return <span data-ad-scaffold="" data-ad-metric={agg} {...(className !== undefined ? { className } : {})}>{value == null ? '—' : String(value)}</span>
  }
  ;(Metric as any).displayName = 'AdMetric'

  // ── Table: the grid CONTRACT (columns/rows/sort/row transport) ───────────
  const Table: IndexSurface['Table'] = ({ columns: colNames, children, className }) => {
    const { session, meta, query } = useCtx()
    const state = useSessionState(session)
    const fieldDefs = cfg.fields ?? []
    const columns = (colNames ?? fieldDefs.map((f) => f.name)).map((n) => {
      const fd = fieldDefs.find((f) => f.name === n)
      return { name: n, label: fd?.label ?? n, kind: fd?.kind ?? 'string', sortable: (meta.sortable ?? []).includes(n) }
    })
    const api: TableApi = {
      columns,
      rows: query.data?.data ?? [],
      sort: state.sort,
      setSort: (f, dir) => session.setSort(f, dir ?? (state.sort?.field === f && state.sort.dir === 'asc' ? 'desc' : 'asc')),
      ...(cfg.mutateRow ? { mutateRow: cfg.mutateRow } : {}),
      isLoading: query.isLoading,
    }
    if (children) return <>{children(api)}</>
    return (
      <table data-ad-table="" data-ad-scaffold="" {...(className !== undefined ? { className } : {})}>
        <thead><tr>{columns.map((c) => (
          <th key={c.name}>{c.sortable
            ? <button type="button" onClick={() => api.setSort(c.name)}>{c.label}{state.sort?.field === c.name ? (state.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
            : c.label}</th>
        ))}</tr></thead>
        <tbody>{api.rows.map((r) => (
          <tr key={r.id}>{columns.map((c) => <td key={c.name}>{r[c.name] == null ? '' : String(r[c.name])}</td>)}</tr>
        ))}</tbody>
      </table>
    )
  }
  ;(Table as any).displayName = 'AdTable'

  // ── Skeletons shaped like the real thing (field meta → placeholder rows) ─
  const blockStyle = { display: 'block', background: 'color-mix(in srgb, currentColor 12%, transparent)', borderRadius: 4 }
  const FormSkeleton: IndexSurface['FormSkeleton'] = ({ className }) => (
    <div data-ad-skeleton="form" aria-hidden="true" {...(className !== undefined ? { className } : {})}>
      {(cfg.fields ?? [{ name: 'a', kind: 'string', label: '' }, { name: 'b', kind: 'string', label: '' }, { name: 'c', kind: 'string', label: '' }]).map((f) => (
        <div key={f.name} data-ad-skeleton-field={f.kind} style={{ margin: '0.75rem 0' }}>
          <span style={{ ...blockStyle, width: '30%', height: '0.7em', marginBottom: 6 }} />
          <span style={{ ...blockStyle, width: f.kind === 'boolean' ? '2.5em' : '100%', height: f.kind === 'text' ? '4.5em' : '2em' }} />
        </div>
      ))}
    </div>
  )
  ;(FormSkeleton as any).displayName = 'AdFormSkeleton'
  const ListSkeleton: IndexSurface['ListSkeleton'] = ({ rows = 5, className }) => (
    <div data-ad-skeleton="list" aria-hidden="true" {...(className !== undefined ? { className } : {})}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ ...blockStyle, height: '2.4em', margin: '0.5rem 0' }} />
      ))}
    </div>
  )
  ;(ListSkeleton as any).displayName = 'AdListSkeleton'

  // ── Aggregation query components — <Surface.Stats>{(data, q) => …} ──────
  // Standalone by design: they do NOT require <Surface.Index> context (an
  // aggregate header can render above the list, or on a page of its own).
  const queryComponents: Record<string, FC<any>> = {}
  for (const [qname, useQueryHook] of Object.entries(cfg.queries ?? {})) {
    const QueryComponent: FC<{
      children?: (data: any, q: { data: any; isLoading: boolean; isError: boolean }) => ReactNode
      loading?: ReactNode
      className?: string
    }> = ({ children, loading, className }) => {
      const q = useQueryHook()
      if (q.isLoading) return <>{loading ?? null}</>
      if (children) return <>{children(q.data, q)}</>
      // Scaffolding default — replace with the render-prop in real apps
      return <pre data-ad-scaffold="" data-ad-query={qname} {...(className !== undefined ? { className } : {})}>{JSON.stringify(q.data, null, 2)}</pre>
    }
    ;(QueryComponent as any).displayName = `AdQuery(${qname})`
    queryComponents[qname] = QueryComponent
  }

  return { Index, Search, Filters, Filter, Items, Pagination, One, use, Sidebar, Error: ErrorC, Empty, Board, Chart, Metric, Table, FormSkeleton, ListSkeleton, ...queryComponents }
}
