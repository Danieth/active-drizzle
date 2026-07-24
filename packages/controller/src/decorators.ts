/**
 * Controller decorators: @controller, @crud, @singleton, @scope,
 * @mutation, @action, @before, @after.
 */
import pluralize from 'pluralize'
import { normalizeProjection, nodeToIncludeSpecs, PROJECTION_NODE } from './projection.js'
import {
  CONTROLLER_META, CRUD_META, SINGLETON_META, SCOPE_META,
  MUTATION_META, ACTION_META, BEFORE_META, AFTER_META, RESCUE_META, ATTACHABLE_META,
  FRONTEND_CONTEXT_META, type FrontendContextMap,
  type CrudConfig, type SingletonConfig, type ScopeEntry, type ModelFieldNames,
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
 *
 * Field-naming config keys (sortable, searchable, expose, permit, …) are
 * typed against the MODEL'S generated instance type: `sortable: ['naem']`
 * is a red squiggle the moment codegen has run. Untyped models degrade to
 * plain strings — nothing to opt into, nothing breaks before first regen.
 */
export function crud<TModel extends new (...args: any[]) => any>(
  model: TModel,
  config: CrudConfig<ModelFieldNames<TModel>> = {},
) {
  return function (target: any) {
    // Access-ceiling desugar (DESIGN-projections): `access:` is the ONE
    // declaration of what this door may show/change; expose/permit/include
    // are derived from it so every existing reader keeps working. The
    // normalized ceiling rides the config for the read-slicer — and for
    // SHAPES later, which resolve subsets against it.
    const node = normalizeProjection(config)
    let cfg: any = config
    if ((config as any).access) {
      const fields = node.fields === '*' ? [] : [...node.fields]
      cfg = {
        ...config,
        get: {
          abilities: true,
          ...(config.get ?? {}),
          expose: (config.get as any)?.expose ?? fields,
          include: (config.get as any)?.include ?? nodeToIncludeSpecs(node),
        },
        update: { ...(config.update ?? {}), permit: (config.update as any)?.permit ?? [...node.edit] },
        create: { ...(config.create ?? {}), permit: (config.create as any)?.permit ?? [...node.edit] },
      }
    }
    ;(cfg as any)[PROJECTION_NODE] = node
    target[CRUD_META] = { model, config: cfg }
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

// ── @frontendContext ──────────────────────────────────────────────────────────

/**
 * Server-computed context for PRESENTERS — the fourth passenger on the
 * envelope, beside abilities/can/version. Each function runs ONCE per
 * request (after @before hooks, so ctrl.state is loaded) and its value
 * rides every envelope and index response this door serves. On the
 * client it appears as `props.ctx.<key>` in every presenter — typed,
 * never fetched, never prop-drilled.
 *
 * Values must be JSON-serializable (they ride the wire). Keys never
 * shadow: a concern and a controller declaring the same key is a
 * teaching error at route build, not a silent override.
 *
 * @example
 * @frontendContext({
 *   userType: (ctx, ctrl) => ctrl.state.user.isAdmin() ? 'admin' : 'member',
 *   plan:     (_ctx, ctrl) => ctrl.state.org.plan,
 * })
 */
export function frontendContext(map: FrontendContextMap) {
  return function (target: any) {
    if (Object.prototype.hasOwnProperty.call(target, FRONTEND_CONTEXT_META)) {
      const existing = Object.keys(target[FRONTEND_CONTEXT_META]).join(', ')
      throw new Error(
        `@frontendContext appears twice on ${target.name} (existing keys: ${existing}). ` +
        `Declare all keys in ONE decorator — a single object, a single source of truth.`,
      )
    }
    target[FRONTEND_CONTEXT_META] = map
  }
}


/** A method decorator on a STATIC member receives the constructor itself —
 *  the metadata would register on Function (globally!) and never attach to
 *  the controller. Teach at decoration time. */
function assertInstanceMember(decorator: string, target: any, key: string): void {
  if (typeof target === 'function') {
    throw new Error(
      `@${decorator} on ${target.name}.${key}: ${decorator} decorates INSTANCE methods — ` +
      `\`${key}\` is static. Drop the \`static\` keyword (controller actions run per-request ` +
      `on an instance).`,
    )
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
 *
 * @example
 * // Guarded button with a declared payload — the client gets a verdict-aware
 * // <deal.SendBack/> mini-form; the server enforces guard + params regardless
 * @mutation({ params: ['reason'], required: ['reason'],
 *             if: (deal) => deal.isSubmitted(), label: 'Send back' })
 * async sendBack(deal: Deal, data: { reason: string }) { ... }
 */
export function mutation(config?: Partial<Omit<MutationEntry, 'method'>> | null) {
  // supports both @mutation and @mutation({bulk: true})
  return function (_target: any, key: string, _descriptor: PropertyDescriptor) {
    assertInstanceMember('mutation', _target, key)
    const ctor = _target.constructor
    const entry: MutationEntry = {
      method: key,
      bulk: config?.bulk ?? false,
      ...(config?.records !== undefined ? { records: config.records } : {}),
      ...(config?.optimistic !== undefined ? { optimistic: config.optimistic } : {}),
      ...(config?.returns !== undefined ? { returns: config.returns } : {}),
      ...(config?.params !== undefined ? { params: config.params } : {}),
      ...(config?.required !== undefined ? { required: config.required } : {}),
      ...(config?.if !== undefined ? { if: config.if } : {}),
      ...(config?.label !== undefined ? { label: config.label } : {}),
      ...(config?.hint !== undefined ? { hint: config.hint } : {}),
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
    assertInstanceMember('action', _target, key)
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
    assertInstanceMember('before/@after', _target, key)
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
    assertInstanceMember('rescue', _target, key)
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
