/**
 * ActiveController — base class for all controllers.
 * Generic over TContext (the user's auth/request context shape).
 *
 * Subclasses define @before hooks, override default CRUD methods,
 * and add @mutation / @action methods.
 */
import { BadRequest } from './errors.js'
import { collectBeforeHooks, collectAfterHooks } from './metadata.js'

export class ActiveController<TContext = Record<string, any>> {
  /** The request context (auth, team, user, etc.) — set before each action */
  protected context!: TContext

  /** Validated input parameters from the request */
  protected params!: Record<string, any>

  /**
   * Pre-scoped Relation for the CRUD model.
   * @scope decorators and defaultScopes are applied before the action runs.
   * Handlers should NOT call Model.all() directly; always use this.relation.
   */
  protected relation!: any  // Relation<TModel> — typed via generated subclass

  /**
   * Run before/after hooks for a given action.
   * Called internally by the router before dispatching to the action method.
   */
  async _runBeforeHooks(actionName: string): Promise<void> {
    const hooks = collectBeforeHooks(this.constructor, actionName)
    for (const hook of hooks) {
      if (hook.condition !== undefined) {
        const ok = typeof hook.condition === 'function'
          ? hook.condition.call(this)
          : !!(this as any)[hook.condition]?.()
        if (!ok) continue
      }
      const result = await (this as any)[hook.method]()
      if (result === false) throw new BadRequest(`Before hook '${hook.method}' aborted the action`)
    }
  }

  async _runAfterHooks(actionName: string): Promise<void> {
    const hooks = collectAfterHooks(this.constructor, actionName)
    for (const hook of hooks) {
      if (hook.condition !== undefined) {
        const ok = typeof hook.condition === 'function'
          ? hook.condition.call(this)
          : !!(this as any)[hook.condition]?.()
        if (!ok) continue
      }
      await (this as any)[hook.method]()
    }
  }
}
