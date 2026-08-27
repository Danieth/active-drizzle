/**
 * ActiveController — base class for all controllers.
 * Generic over TContext (the user's auth/request context shape).
 *
 * Subclasses define @before hooks, override default CRUD methods,
 * and add @mutation / @action methods.
 */
import { attachFlatIncludes } from '@active-drizzle/core'
import { BadRequest } from './errors.js'
import { collectBeforeHooks, collectAfterHooks, collectRescueHandlers, getCrudMeta } from './metadata.js'
import { buildRecordEnvelope, buildColumnarRecordEnvelope, type RecordEnvelope } from './crud-handlers.js'
import { usesColumnar, type ColumnarEnvelope } from './columnar-envelope.js'

/** Sentinel returned by _handleError when no rescue handler matched. */
const UNHANDLED = Symbol('ad:unhandled')

export class ActiveController<
  TContext = Record<string, any>,
  TState extends Record<string, any> = Record<string, any>
> {
  /** The request context (auth, team, user, etc.) — set before each action */
  protected context!: TContext

  /**
   * Full validated input from the request (same as params).
   * Alias provided for ergonomics — use whichever name you prefer.
   */
  protected input!: Record<string, any>

  /** Validated input parameters from the request */
  protected params!: Record<string, any>

  /**
   * Pre-scoped Relation for the CRUD model.
   * @scope decorators and scopeBy are applied before the action runs.
   * Handlers should NOT call Model.all() directly; always use this.relation.
   */
  protected relation!: any  // Relation<TModel> — typed via generated subclass

  /**
   * The auto-loaded record for @mutation and @action({ load: true }) methods.
   * Available in @before hooks that run `only: [actionName]` so you can check
   * ownership / permissions before the action body executes.
   *
   * @example
   * @before({ only: ['launch'] })
   * async ensureOwner() {
   *   if (this.record.creatorId !== this.context.user.id) throw new Forbidden('Not your campaign')
   * }
   */
  protected record: any = null

  /**
   * The record as a forms envelope ({ record, abilities, can, version })
   * under THIS controller's @crud config. Return it from @mutation methods
   * so the generated action button folds fresh verdicts/fields straight
   * into the live form session — no refetch round-trip.
   *
   * Async since transport WS2: on a columnar door the record's GET includes
   * are flat-loaded first (custom @mutation bodies typically load with no
   * includes, and serializing an unloaded hasMany would either drop the
   * pk-array column or — worse, the pre-fix behavior — certify an EMPTY
   * membership at the current token and wipe the client store). `return
   * this.envelope(record)` from an async method is unchanged.
   */
  protected async envelope(record: any): Promise<RecordEnvelope | ColumnarEnvelope> {
    const meta = getCrudMeta(this.constructor)
    if (!meta) throw new Error('[active-drizzle] envelope() requires a @crud controller')
    // Flagged doors speak columnar EVERYWHERE — @mutation / state-event
    // echoes included (proof A3: one serializer per door, no byte path
    // around it).
    if (usesColumnar(meta.config)) {
      const includes = (meta.config as any)?.get?.include ?? []
      if (record && includes.length) {
        await attachFlatIncludes([record], meta.model, includes)
      }
      return buildColumnarRecordEnvelope(record, meta.model, meta.config, this.context, this)
    }
    return buildRecordEnvelope(record, meta.model, meta.config, this.context, this)
  }

  /**
   * Mutable per-request state, populated by @before hooks.
   * Use this to carry resolved entities (org, team, user) across the controller
   * inheritance chain so child controllers can consume them without re-loading.
   *
   * @example
   * // OrgController resolves the org once
   * @before()
   * async resolveOrg() {
   *   this.state.org = await Organization.findOrCreateBy({ clerkOrgId: this.context.orgId })
   * }
   *
   * // AssetController (extends OrgController) uses it
   * // this.state.org is fully typed via TState generic
   */
  protected state: TState = {} as TState

  // ── Lifecycle ──────────────────────────────────────────────────────────────

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

  /**
   * Called when an action throws. Walks @rescue handlers (parent class first,
   * most specific last) to find a matching handler for `error` and `actionName`.
   *
   * Returns the handler's return value if it resolves without throwing.
   * Re-throws the original error (as a symbol-tagged object) if no handler matched.
   *
   * @internal — called by the router's dispatch function.
   */
  async _handleError(
    error: unknown,
    actionName: string,
  ): Promise<{ handled: true; value: any } | { handled: false }> {
    const handlers = collectRescueHandlers(this.constructor, actionName, error)
    for (const handler of handlers) {
      try {
        const value = await (this as any)[handler.method](error)
        return { handled: true, value }
      } catch (newError) {
        // Handler converted the error to a different one — propagate the new error
        throw newError
      }
    }
    return { handled: false }
  }
}
