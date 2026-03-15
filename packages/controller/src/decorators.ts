/**
 * Controller decorators: @controller, @crud, @singleton, @scope,
 * @mutation, @action, @before, @after.
 */
import pluralize from 'pluralize'
import {
  CONTROLLER_META, CRUD_META, SINGLETON_META, SCOPE_META,
  MUTATION_META, ACTION_META, BEFORE_META, AFTER_META, RESCUE_META, ATTACHABLE_META,
  type CrudConfig, type SingletonConfig, type ScopeEntry,
  type MutationEntry, type ActionEntry, type HookEntry, type RescueEntry,
  type AttachableConfig,
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

// ── @attachable ──────────────────────────────────────────────────────────────

/**
 * Adds presign/confirm/attach endpoints to the controller for file uploads.
 * Endpoints inherit the controller's auth context and scope params.
 *
 * @example
 * @attachable()  // no custom scoping
 *
 * @example
 * @attachable({ autoSet: { uploadedById: ctx => ctx.user.id } })
 */
export function attachable(config?: AttachableConfig) {
  return function (target: any) {
    target[ATTACHABLE_META] = config ?? {}
  }
}

// ── @mutation ─────────────────────────────────────────────────────────────────

/**
 * Marks an instance method as a custom mutation action.
 * Non-bulk: auto-loads record by :id, passes as first arg.
 * Bulk: accepts ids[], loads all (unless records: false), passes array or ids.
 * Route: POST /<resource>/:id/<method-name> (non-bulk)
 *        POST /<resource>/<method-name>      (bulk)
 *
 * @example
 * // Efficient bulk update (no record loading)
 * @mutation({ bulk: true, records: false })
 * async archive(ids: number[]) {
 *   await this.relation.where({ id: ids }).updateAll({ status: 'archived' })
 * }
 */
export function mutation(config?: Omit<MutationEntry, 'method'> | null) {
  // supports both @mutation and @mutation({bulk: true})
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: MutationEntry = {
      method: key,
      bulk: config?.bulk ?? false,
      ...(config?.records !== undefined ? { records: config.records } : {}),
      ...(config?.optimistic !== undefined ? { optimistic: config.optimistic } : {}),
      ...(config?.returns !== undefined ? { returns: config.returns } : {}),
    }
    ctor[MUTATION_META] = [...(ctor[MUTATION_META] ?? []), entry]
  }
}

// ── @action ───────────────────────────────────────────────────────────────────

export interface ActionConfig {
  /**
   * If true and the controller has @crud, auto-loads the record by :id from
   * the scoped relation and passes it as the first argument to the method.
   * Requires path to include /:id (or the default /:id/<method-name> path).
   * The loaded record is also available as `this.record`.
   */
  load?: boolean
}

/**
 * Marks an instance method as an explicit REST action.
 * Works on plain controllers (no @crud) and CRUD controllers alike.
 *
 * @param httpMethod  GET | POST | PUT | PATCH | DELETE
 * @param path        Optional explicit path (default: /<resource>/:id/<method-name> if load:true, else /<resource>/<method-name>)
 * @param config      ActionConfig — set { load: true } to auto-load the record by :id
 */
export function action(
  httpMethod: ActionEntry['httpMethod'],
  path?: string,
  config?: ActionConfig,
) {
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: ActionEntry = {
      method: key,
      httpMethod,
      load: config?.load ?? false,
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

// ── @rescue ───────────────────────────────────────────────────────────────────

export interface RescueConfig {
  only?: string[]
  except?: string[]
}

/**
 * Rails-style error handler for controller methods.
 *
 * When any action throws an instance of `errorClass`, the decorated method
 * is called with the error as its only argument. The handler can:
 *   - throw an HttpError to convert the error into an HTTP response
 *   - return a value to use as the action's response (swallows the error)
 *
 * Inherits from parent classes — parent rescues fire first (like Rails).
 * Use `only`/`except` to limit which actions the rescue applies to.
 *
 * @example
 * // Convert ORM RecordNotFound → 404
 * @rescue(RecordNotFound)
 * async handleNotFound(error: RecordNotFound) {
 *   throw new NotFound(error.modelName)
 * }
 *
 * // Return a fallback only on the 'show' action
 * @rescue(SomeTransientError, { only: ['get'] })
 * async handleTransient(_error: SomeTransientError) {
 *   return { fallback: true }
 * }
 */
export function rescue(
  errorClass: new (...args: any[]) => Error,
  config?: RescueConfig,
) {
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    const ctor = _target.constructor
    const entry: RescueEntry = {
      errorClass,
      method: key,
      ...(config?.only ? { only: config.only } : {}),
      ...(config?.except ? { except: config.except } : {}),
    }
    if (!Object.prototype.hasOwnProperty.call(ctor, RESCUE_META)) {
      ctor[RESCUE_META] = []
    }
    ;(ctor[RESCUE_META] as RescueEntry[]).push(entry)
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
