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

// ── Shape definitions ─────────────────────────────────────────────────────────

export interface ControllerMeta {
  path?: string
}

export interface ScopeEntry {
  field: string                // e.g. 'teamId'
  resource: string             // e.g. 'teams'   (inferred)
  paramName: string            // e.g. 'teamId'  (used in oRPC input schema)
}

export interface IndexConfig {
  scopes?: string[]
  defaultScopes?: string[]
  paramScopes?: string[]
  sortable?: string[]
  defaultSort?: { field: string; dir: 'asc' | 'desc' }
  filterable?: string[]
  include?: string[]
  perPage?: number
  maxPerPage?: number
}

export interface WriteConfig {
  /**
   * Allowed fields for mass assignment.
   * Can also be a function `(ctx, ctrl) => string[]` for role-based field permissions.
   *
   * @example
   * permit: (_ctx, ctrl) => ctrl.state.canAdmin
   *   ? ['name', 'budget', 'status']
   *   : ['name']
   */
  permit?: string[] | ((ctx: any, ctrl: any) => string[])
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
}

export interface CrudConfig {
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
  update?: Omit<WriteConfig, 'autoSet'>
  get?: { include?: string[] }
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
  get?: { include?: string[] }
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
  optimistic?: Record<string, any>
  returns?: 'self' | 'new'
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

// ── Getters / setters ─────────────────────────────────────────────────────────

export function getControllerMeta(cls: any): ControllerMeta | undefined {
  return cls[CONTROLLER_META]
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
