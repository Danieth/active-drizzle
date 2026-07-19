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
import React, { createContext, useContext, useMemo, useRef, useSyncExternalStore, type FC, type ReactNode } from 'react'

// ── IndexSession — headless list state ───────────────────────────────────────

export interface IndexState {
  scopes?: string[] | undefined
  q?: string | undefined
  filters: Record<string, any>
  sort?: { field: string; dir: 'asc' | 'desc' } | undefined
  page: number
  perPage?: number | undefined
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

// ── Surface factory (consumed by codegen) ────────────────────────────────────

export interface IndexSurfaceConfig {
  meta: IndexMeta
  /** Injected by codegen: the controller's index query hook, fed the wire params. */
  useIndexQuery: (params: Record<string, any>) => { data: any; isLoading: boolean; isError: boolean }
  /** Row → typed handle (view-mode form handle per row). */
  makeRowHandle: (row: Record<string, any>) => any
  /** Injected by codegen for Surface.One: the generated edit-form hook. */
  useEditForm?: (id: number, opts?: any) => { status: string; form: any }
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
  Items: FC<{ children: (handle: any, row: Record<string, any>) => ReactNode; empty?: ReactNode }>
  Pagination: FC<{ className?: string }>
  One: FC<{ id: number; poll?: { every: number; until?: (r: any) => boolean }; children: (form: any) => ReactNode; loading?: ReactNode }>
  /** Context accessor for custom widgets: session + live query + meta. */
  use: () => { session: IndexSession; state: IndexState; meta: IndexMeta; rows: any[]; pagination: any; isLoading: boolean }
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

  // One filter widget — headless-ish defaults per kind, overridable by
  // NOT rendering <Filters/> and driving the session via use()
  const FilterWidget: FC<{ name: string; className?: string }> = ({ name, className }) => {
    const { session, meta } = useCtx()
    const fm = meta.filters?.[name]
    if (!fm) return null
    const state = useSessionState(session)
    const value = state.filters[name]

    if (fm.kind === 'facet' && fm.options) {
      const selected: string[] = Array.isArray(value) ? value : value != null ? [value] : []
      return (
        <span {...(className !== undefined ? { className } : {})} data-ad-filter={name} role="group" aria-label={fm.label}>
          {fm.options.map(opt => (
            <button
              key={opt}
              type="button"
              data-active={selected.includes(opt) || undefined}
              aria-pressed={selected.includes(opt)}
              onClick={() => {
                const next = selected.includes(opt) ? selected.filter(o => o !== opt) : [...selected, opt]
                session.setFilter(name, next)
              }}
            >
              {opt}
            </button>
          ))}
        </span>
      )
    }
    if (fm.kind === 'toggle') {
      return (
        <label {...(className !== undefined ? { className } : {})} data-ad-filter={name}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => session.setFilter(name, e.target.checked)} />
          {fm.label}
        </label>
      )
    }
    // text fallback (also covers custom kinds until a presenter is registered)
    return (
      <input
        {...(className !== undefined ? { className } : {})}
        data-ad-filter={name}
        placeholder={fm.label}
        defaultValue={value ?? ''}
        onChange={(e) => session.setFilter(name, e.target.value)}
      />
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
  // Per-filter placement: <Surface.Filters.stage className=.../>
  const Filters = new Proxy(FiltersBase as IndexSurface['Filters'], {
    get(target, prop: string | symbol) {
      if (typeof prop === 'string' && cfg.meta.filters?.[prop]) {
        const Single: FC<{ className?: string }> = (p) => <FilterWidget name={prop} {...p} />
        Single.displayName = `AdIndexFilter(${prop})`
        return Single
      }
      return (target as any)[prop]
    },
  })

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

  return { Index, Search, Filters, Items, Pagination, One, use }
}
