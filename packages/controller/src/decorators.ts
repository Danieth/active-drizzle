/**
 * Controller decorators: @controller, @crud, @singleton, @scope,
 * @mutation, @action, @before, @after.
 */
import pluralize from 'pluralize'
import {
  CONTROLLER_META, CRUD_META, SINGLETON_META, SCOPE_META,
  MUTATION_META, ACTION_META, BEFORE_META, AFTER_META,
  type CrudConfig, type SingletonConfig, type ScopeEntry,
  type MutationEntry, type ActionEntry, type HookEntry,
  inferScopeResource,
} from './metadata.js'

// ── @controller ───────────────────────────────────────────────────────────────

/**
 * Marks a class as a controller. Optionally sets the base route path.
 * If omitted, the path is inferred from the class name:
 *   CampaignController → /campaigns
 */
export function controller(path?: string) {
  return function (target: any) {
    target[CONTROLLER_META] = { path }
  }
}

// ── @scope ────────────────────────────────────────────────────────────────────

/**
 * Nests the controller under a parent resource.
 * @scope('teamId') → /teams/:teamId/<resource>
 *
 * Stacks from bottom to top in declaration order:
 *   @scope('teamId') @scope('campaignId')
 *   → /teams/:teamId/campaigns/:campaignId/<resource>
 */
export function scope(field: string) {
  return function (target: any) {
    const { resource, paramName } = inferScopeResource(field)
    const entry: ScopeEntry = { field, resource, paramName }
    // prepend so outermost (top-most in source) scope is first
    target[SCOPE_META] = [entry, ...(target[SCOPE_META] ?? [])]
  }
}

// ── @crud ─────────────────────────────────────────────────────────────────────

/**
 * Attaches a model + config to the controller class, enabling default
 * CRUD handlers (index/get/create/update/destroy).
 */
export function crud<TModel extends new (...args: any[]) => any>(
  model: TModel,
  config: CrudConfig = {},
) {
  return function (target: any) {
    target[CRUD_META] = { model, config }
  }
}

// ── @singleton ────────────────────────────────────────────────────────────────

/**
 * Marks a controller as a singleton resource (no :id, no index).
 */
export function singleton<TModel extends new (...args: any[]) => any>(
  model: TModel,
  config: SingletonConfig,
) {
  return function (target: any) {
    target[SINGLETON_META] = { model, config }
  }
}

// ── @mutation ─────────────────────────────────────────────────────────────────

/**
 * Marks an instance method as a custom mutation action.
 * Non-bulk: auto-loads record by :id, passes as first arg.
 * Bulk: accepts ids[], loads all, passes array.
 * Route: POST /<resource>/:id/<method-name> (non-bulk)
 *        POST /<resource>/<method-name>      (bulk)
 */
export function mutation(config?: Omit<MutationEntry, 'method'> | null) {
  // supports both @mutation and @mutation({bulk: true})
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: MutationEntry = {
      method: key,
      bulk: config?.bulk ?? false,
      ...(config?.optimistic !== undefined ? { optimistic: config.optimistic } : {}),
      ...(config?.returns !== undefined ? { returns: config.returns } : {}),
    }
    ctor[MUTATION_META] = [...(ctor[MUTATION_META] ?? []), entry]
  }
}

// ── @action ───────────────────────────────────────────────────────────────────

/**
 * Marks an instance method as an explicit REST action.
 * For plain controllers (no @crud).
 */
export function action(
  httpMethod: ActionEntry['httpMethod'],
  path?: string,
) {
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: ActionEntry = {
      method: key,
      httpMethod,
      ...(path !== undefined ? { path } : {}),
    }
    ctor[ACTION_META] = [...(ctor[ACTION_META] ?? []), entry]
  }
}

// ── @before / @after ──────────────────────────────────────────────────────────

export interface HookConfig {
  only?: string[]
  except?: string[]
  if?: string | (() => boolean)
}

/**
 * Marks a method as a before-hook.
 * Inherited from parent classes — parent hooks fire first.
 */
export function before(config?: HookConfig) {
  return hookDecorator(BEFORE_META, config)
}

/**
 * Marks a method as an after-hook.
 */
export function after(config?: HookConfig) {
  return hookDecorator(AFTER_META, config)
}

function hookDecorator(sym: symbol, config?: HookConfig) {
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: HookEntry = {
      method: key,
      ...(config?.only ? { only: config.only } : {}),
      ...(config?.except ? { except: config.except } : {}),
      ...(config?.if !== undefined ? { condition: config.if } : {}),
    }
    if (!Object.prototype.hasOwnProperty.call(ctor, sym)) {
      ctor[sym] = []
    }
    ;(ctor[sym] as HookEntry[]).push(entry)
  }
}

// ── Infer route path from class name ─────────────────────────────────────────

/**
 * CampaignController → /campaigns
 * TeamSettingsController → /team-settings
 */
export function inferControllerPath(cls: any): string {
  const name: string = cls.name ?? 'Unknown'
  const base = name.replace(/Controller$/, '')
  const kebab = base.replace(/([A-Z])/g, (m, c, i) => (i > 0 ? '-' : '') + c.toLowerCase())
  return '/' + pluralize(kebab)
}
