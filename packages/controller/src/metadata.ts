/**
 * Symbol-keyed metadata storage for controller decorators.
 * We avoid reflect-metadata to keep the package dependency-free.
 * All metadata is stored directly on the class constructor via Symbols.
 */

// ── Symbol keys ──────────────────────────────────────────────────────────────

export const CONTROLLER_META  = Symbol('ad:controller')
export const CRUD_META        = Symbol('ad:crud')
export const SINGLETON_META   = Symbol('ad:singleton')
export const SCOPE_META       = Symbol('ad:scopes')
export const MUTATION_META    = Symbol('ad:mutations')
export const ACTION_META      = Symbol('ad:actions')
export const BEFORE_META      = Symbol('ad:before')
export const AFTER_META       = Symbol('ad:after')
export const RESCUE_META      = Symbol('ad:rescue')
export const ATTACHABLE_META  = Symbol('ad:attachable')

// ── Shape definitions ─────────────────────────────────────────────────────────

/**
 * An eager-load spec: a bare association name, or a nested object for
 * grandchildren — `'notes'` or `{ notes: ['reactions'] }` (deal → notes →
 * reactions). Lowered to drizzle's relational `with` shape by the runtime.
 */
export type IncludeSpec = string | Record<string, any>

export interface ControllerMeta {
  path?: string
}

export interface ScopeEntry {
  field: string                // e.g. 'teamId'
  resource: string             // e.g. 'teams'   (inferred)
  paramName: string            // e.g. 'teamId'  (used in oRPC input schema)
}

/** External search engine contract — see IndexConfig.search.adapter. */
export interface SearchAdapter {
  /** Matching ids in rank order (cap at opts.limit). Ids ONLY. */
  search(term: string, ctx: any, opts: { limit: number }): Promise<Array<number | string>>
}

export interface IndexConfig {
  scopes?: string[]
  defaultScopes?: string[]
  paramScopes?: string[]
  sortable?: string[]
  defaultSort?: { field: string; dir: 'asc' | 'desc' }
  filterable?: string[]
  /**
   * Facet counts — the payoff of faceting. `true` counts every filterable
   * field; an array names a subset (must be ⊆ filterable). Each index
   * response then carries `facets: { field: { label: n } }` computed
   * DISJUNCTIVELY (all OTHER filters + search applied, the field's own
   * filter excluded — so options never zero themselves out). Enum/state
   * group keys come back as labels via the aggregate engine.
   */
  facets?: boolean | string[]
  /**
   * Chart dimension allowlist — fields the client may GROUP BY via the
   * `chart: { x, y }` index param (categorical v1: enum/state/boolean/fk).
   */
  chartable?: string[]
  /**
   * Measure allowlist — numeric fields the client may aggregate via
   * `chart.y: 'sum:amount' | 'avg:amount'` or `metric: 'sum:amount'`.
   * `count` is always allowed once `chartable`/`measures` is declared.
   */
  measures?: string[]
  /**
   * NAMED filters — product concepts with server-side meaning (Rails-scope-
   * shaped, presentationally declared). The client only ever sees
   * { name, label, kind, param shape }; the SEMANTICS live here and can
   * change without a client redeploy:
   *
   *   filters: {
   *     bigDeals: {
   *       label: 'Big deals', kind: 'toggle',
   *       apply: (rel, _on, ctx) => rel.where({ amount: { gte: 50000 } }),
   *     },
   *   }
   *
   * `apply` receives the ALREADY door-scoped relation — a named filter can
   * only ever narrow. Allowlisted like everything else: an undeclared
   * filter key is a BadRequest.
   */
  filters?: Record<string, {
    label?: string
    /** Presentational kind for the generated widget ('toggle' | 'dateRange' | 'range' | 'text' | …). */
    kind?: string
    apply: (rel: any, value: any, ctx?: any, ctrl?: any) => any
  }>
  /**
   * Columns the `q` param substring-searches (case-insensitive, ORed):
   *
   *   index: { searchable: ['name', 'email'] }
   *   → ?q=ada  ⇒  WHERE name ILIKE '%ada%' OR email ILIKE '%ada%'
   *
   * Like `filterable`, this is an allowlist: a `q` sent to an index without
   * `searchable` is a BadRequest, never a silent no-op.
   */
  searchable?: string[]
  /**
   * WEIGHTED full-text search (PG tsvector, computed on the fly — no
   * migration; add a generated column later purely for speed):
   *
   *   search: { fields: { name: 'A', contactEmail: 'B' } }
   *
   * `?q=` upgrades from ilike to websearch parsing (quoted phrases,
   * -negation, OR) with ts_rank relevance ordering; `sort: { field:
   * 'relevance' }` is accepted while searching. `searchable` remains the
   * simple-ilike fallback when `search` is absent.
   */
  search?: {
    fields?: Record<string, 'A' | 'B' | 'C' | 'D'>
    /**
     * External search engine plug (the "ES lane"), IDS-ONLY by doctrine:
     * the adapter returns matching ids in rank order and NOTHING else —
     * hydration always goes back through the door-scoped relation, so a
     * compromised or stale engine can only ever surface records this door
     * already allows, with this door's projection. Feeding the engine
     * (searchDoc transform + outbox/afterCommit shipping) is APP code —
     * the framework keeps the hook points stable and ships none of it.
     * Falls back to `fields` (PG FTS) / `searchable` (ilike) when absent.
     */
    adapter?: SearchAdapter
    /**
     * One-way searchDoc transform — what YOUR shipper should index for a
     * record. Declared here so the app's outbox/afterCommit code and any
     * reindex script derive the SAME document (buildSearchDoc helper).
     */
    doc?: (record: any) => Record<string, unknown>
  }
  include?: IncludeSpec[]
  perPage?: number
  maxPerPage?: number
}

export interface WriteConfig {
  /**
   * Allowed fields for mass assignment.
   * Can also be a function `(ctx, ctrl, record) => string[]` for role- AND
   * record-state-aware field permissions. `record` is the loaded record on
   * update, and a defaults-draft instance on create — so DRAFT-only editing
   * is one line:
   *
   * @example
   * permit: (_ctx, ctrl, loan) =>
   *   loan.isDraft() ? ['amount', 'termMonths'] : []
   */
  permit?: string[] | ((ctx: any, ctrl: any, record?: any) => string[])
  restrict?: string[]
  /**
   * Fields that are always set from context/state, bypassing user input.
   * The callback receives `(ctx, ctrl)` — use `ctrl.state` to access resolved entities.
   *
   * @example
   * autoSet: {
   *   organizationId: (_ctx, ctrl) => ctrl.state.org.id,
   *   createdById:    (ctx) => ctx.userId,
   * }
   */
  autoSet?: Record<string, (ctx: any, ctrl?: any) => any>
  /**
   * autoSet for NESTED rows — keys are association-name paths (dots for
   * depth). Fields are FORCED from context on nested create rows and
   * STRIPPED (immutable) on nested update rows:
   *
   * @example
   * nestedAutoSet: {
   *   'notes.reactions': { userId: (ctx) => ctx.userId },
   * }
   */
  nestedAutoSet?: Record<string, Record<string, (ctx: any, ctrl?: any) => any>>
}

/** Read-side config for @crud get (and singleton get). */
export interface GetConfig {
  include?: IncludeSpec[]
  /**
   * Serialization ceiling: ONLY these fields leave the server for this
   * controller. Omitting `expose` keeps today's behavior (all fields) but
   * also disables the abilities envelope — Forms require an explicit ceiling.
   */
  expose?: string[]
  /**
   * When true, get/update/create respond with the Forms envelope instead of
   * the bare record:
   *
   *   { record, abilities, can, issues? }
   *
   * abilities[f] = 'edit' iff f ∈ permit(ctx, ctrl, record) (update config),
   * else 'view' iff f ∈ expose, else absent. acceptsNested associations get
   * an `<assoc>Attributes` verdict from the same permit. `can` maps every
   * Attr.state event to a server-computed boolean. Requires `expose`.
   */
  abilities?: boolean
}

export interface CrudConfig {
  /**
   * THE ACCESS CEILING (DESIGN-projections.md) — what this door may ever
   * show or change, and the whole graph it may reach, declared ONCE with
   * recursive per-level access. `editable` is implicitly viewable; a
   * field in neither list does not exist on this door.
   *
   *   access: {
   *     editable: ['name', 'amount'],
   *     viewable: ['stage'],
   *     include: { notes: { editable: ['body'], viewable: ['position'],
   *                include: { sentiments: { editable: ['score'], viewable: ['label'] } } } },
   *   } satisfies LoanProjection
   *
   * Desugars into expose/permit/include (explicit ones beside it win
   * per-key). SHAPES — what a given route actually loads and sends — are
   * a separate concern that only ever picks SUBSETS of this ceiling and
   * never restates access.
   */
  access?: import('./projection.js').ProjectionNode
  index?: IndexConfig
  /**
   * Dynamically scope all CRUD queries using resolved controller state.
   * Called once after @before hooks run, applied to `this.relation`.
   *
   * Use this instead of (or in addition to) @scope when the scope value
   * comes from loaded state (e.g., `this.state.org.id`) rather than a URL param.
   *
   * @example
   * @crud(Asset, {
   *   scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),
   * })
   */
  scopeBy?: (ctrl: any) => Record<string, any>
  create?: WriteConfig
  update?: Omit<WriteConfig, 'autoSet'> & {
    /**
     * Optimistic concurrency for updates. The envelope gains a `version`
     * token read from this field; the client echoes it as `_version` on
     * PATCH; a mismatch throws 409 Conflict carrying the CURRENT envelope
     * (so the client can offer reload/overwrite without a round-trip).
     *
     *   true       → version from `updatedAt` (the model must touch it on
     *                save — a @beforeSave hook or DB trigger)
     *   '<field>'  → version from that field; NUMERIC fields (lock_version
     *                style) auto-increment on every governed update
     *
     * A PATCH without `_version` skips the check (old clients still work).
     */
    optimisticLock?: boolean | string
  }
  get?: GetConfig
}

export interface SingletonConfig {
  /**
   * Returns the where clause used to find the singleton record.
   * Receives `(ctx, ctrl)` — use `ctrl.state` to access resolved entities.
   *
   * @example
   * findBy: (_ctx, ctrl) => ({ organizationId: ctrl.state.org.id })
   */
  findBy: (ctx: any, ctrl?: any) => Record<string, any>
  findOrCreate?: boolean
  defaultValues?: Record<string, any>
  update?: Omit<WriteConfig, 'autoSet'>
  get?: { include?: IncludeSpec[] }
}

export interface CrudMeta {
  model: new (...args: any[]) => any
  config: CrudConfig
}

export interface SingletonMeta {
  model: new (...args: any[]) => any
  config: SingletonConfig
}

export interface MutationEntry {
  method: string
  bulk: boolean
  /**
   * For bulk mutations: if false, the handler receives `ids: number[]` instead of
   * fully loaded records. Use this for efficient mass updates via `updateAll()`.
   *
   * Defaults to `true` (loads all records).
   *
   * @example
   * @mutation({ bulk: true, records: false })
   * async archive(ids: number[]) {
   *   await this.relation.where({ id: ids }).updateAll({ status: 'archived' })
   * }
   */
  records?: boolean
  optimistic?: Record<string, any>
  returns?: 'self' | 'new'
  /**
   * Declared payload fields — a permit-style ALLOWLIST for `data`. When
   * present, anything not listed is stripped before the method runs, and
   * the generated button becomes an implicit mini-form for these fields.
   * Without it, `data` passes through untouched (pre-existing behavior).
   */
  params?: string[]
  /** Params that must be present and non-blank — 422 with field issues otherwise. */
  required?: string[]
  /**
   * Per-record guard: whether this mutation is available for the record
   * RIGHT NOW. Rides the envelope `can` map (the generated button greys
   * itself) AND gates dispatch server-side (422 when false) — the verdict
   * is a projection of the rule, never the rule itself. Must be synchronous.
   */
  if?: (record: any, ctx: any, ctrl: any) => boolean
  /** Human label for the generated button / mini-form. */
  label?: string
  /** WHY the guard declined — rides the envelope `why` map so the greyed
   *  button explains itself ("already at highest priority"). String or
   *  per-record function. */
  hint?: string | ((record: any, ctx: any) => string)
}

export interface ActionEntry {
  method: string
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path?: string
  /** If true, auto-loads the record by :id on CRUD controllers before calling the method. */
  load?: boolean
}

export interface HookEntry {
  method: string
  only?: string[]
  except?: string[]
  condition?: string | (() => boolean)
}

export interface RescueEntry {
  /** The error class to match (instanceof check). */
  errorClass: new (...args: any[]) => Error
  /** The controller method to call with the error. */
  method: string
  only?: string[]
  except?: string[]
}

export interface AttachableConfig {
  /**
   * Injects server-controlled values onto the Asset at presign time.
   * Same pattern as @crud WriteConfig.autoSet.
   *
   * @example
   * @attachable({ autoSet: { uploadedById: ctx => ctx.user.id } })
   */
  autoSet?: Record<string, (ctx: any, ctrl?: any) => any>
}

// ── Getters / setters ─────────────────────────────────────────────────────────

export function getControllerMeta(cls: any): ControllerMeta | undefined {
  return cls[CONTROLLER_META]
}

export function getAttachableMeta(cls: any): AttachableConfig | undefined {
  const meta = cls[ATTACHABLE_META]
  return meta !== undefined ? meta : undefined
}

export function getRescueHandlers(cls: any): RescueEntry[] {
  return cls[RESCUE_META] ?? []
}

export function getCrudMeta(cls: any): CrudMeta | undefined {
  return cls[CRUD_META]
}

export function getSingletonMeta(cls: any): SingletonMeta | undefined {
  return cls[SINGLETON_META]
}

/** Returns scopes in declaration order (outermost @scope first = closest to root URL). */
export function getScopes(cls: any): ScopeEntry[] {
  return cls[SCOPE_META] ?? []
}

export function getMutations(cls: any): MutationEntry[] {
  return cls[MUTATION_META] ?? []
}

export function getActions(cls: any): ActionEntry[] {
  return cls[ACTION_META] ?? []
}

/**
 * Collect @before hooks applicable to `actionName`, walking the prototype
 * chain so parent hooks fire first (like Rails before_action inheritance).
 */
export function collectBeforeHooks(cls: any, actionName: string): HookEntry[] {
  return collectHooks(cls, BEFORE_META, actionName)
}

export function collectAfterHooks(cls: any, actionName: string): HookEntry[] {
  return collectHooks(cls, AFTER_META, actionName)
}

function collectHooks(cls: any, sym: symbol, actionName: string): HookEntry[] {
  const chain: HookEntry[][] = []
  let proto = cls
  while (proto && proto !== Function.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, sym)) {
      chain.unshift(proto[sym] as HookEntry[])
    }
    proto = Object.getPrototypeOf(proto)
  }
  return chain.flat().filter(h => appliesToAction(h, actionName))
}

function appliesToAction(hook: HookEntry | RescueEntry, action: string): boolean {
  if (hook.only && !hook.only.includes(action)) return false
  if (hook.except && hook.except.includes(action)) return false
  return true
}

/**
 * Collect @rescue handlers that match both the action and the error type.
 * Walks the prototype chain — parent handlers fire first (least specific → most specific).
 */
export function collectRescueHandlers(cls: any, actionName: string, error: unknown): RescueEntry[] {
  const chain: RescueEntry[][] = []
  let proto = cls
  while (proto && proto !== Function.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, RESCUE_META)) {
      chain.unshift(proto[RESCUE_META] as RescueEntry[])
    }
    proto = Object.getPrototypeOf(proto)
  }
  return chain.flat().filter(h =>
    appliesToAction(h, actionName) &&
    error instanceof h.errorClass,
  )
}

// ── Infer scope resource name ─────────────────────────────────────────────────

import pluralize from 'pluralize'

/**
 * teamId → { resource: 'teams', paramName: 'teamId' }
 * campaignId → { resource: 'campaigns', paramName: 'campaignId' }
 */
export function inferScopeResource(field: string): { resource: string; paramName: string } {
  const base = field.endsWith('Id') ? field.slice(0, -2) : field
  return { resource: pluralize(base), paramName: field }
}
