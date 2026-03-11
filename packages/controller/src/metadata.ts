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
  permit?: string[]
  restrict?: string[]
  autoSet?: Record<string, (ctx: any) => any>
}

export interface CrudConfig {
  index?: IndexConfig
  create?: WriteConfig
  update?: Omit<WriteConfig, 'autoSet'>
  get?: { include?: string[] }
}

export interface SingletonConfig {
  findBy: (ctx: any) => Record<string, any>
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
}

export interface HookEntry {
  method: string
  only?: string[]
  except?: string[]
  condition?: string | (() => boolean)
}

// ── Getters / setters ─────────────────────────────────────────────────────────

export function getControllerMeta(cls: any): ControllerMeta | undefined {
  return cls[CONTROLLER_META]
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

function appliesToAction(hook: HookEntry, action: string): boolean {
  if (hook.only && !hook.only.includes(action)) return false
  if (hook.except && hook.except.includes(action)) return false
  return true
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
