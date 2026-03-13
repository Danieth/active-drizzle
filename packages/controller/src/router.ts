/**
 * buildRouter — reads controller class metadata and produces an oRPC router
 * with all procedures for index, get, create, update, destroy, mutations,
 * and plain actions.
 *
 * The router is a plain object (oRPC convention). Procedures receive
 * `{ input, context }` and invoke the controller with that context.
 */
import { os, ORPCError } from '@orpc/server'
import { z } from 'zod'
import {
  getCrudMeta, getSingletonMeta, getScopes, getMutations, getActions,
  getControllerMeta,
} from './metadata.js'
import { inferControllerPath } from './decorators.js'
import {
  defaultIndex, defaultGet, defaultCreate, defaultUpdate, defaultDestroy,
  singletonFindOrCreate,
} from './crud-handlers.js'
import { BadRequest, HttpError, NotFound, ValidationError, toValidationError, serializeError } from './errors.js'

// ── Route record (for REST adapter + CLI) ─────────────────────────────────────

export interface RouteRecord {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  procedure: string   // dotted path in the oRPC router tree
  action: string      // human name
}

// ── Main builder ─────────────────────────────────────────────────────────────

export interface BuildResult {
  router: Record<string, any>
  routes: RouteRecord[]
  /** The resolved URL path prefix for this controller (e.g. /teams/:teamId/campaigns) */
  basePath: string
}

export function buildRouter<TContext = Record<string, any>>(
  ControllerClass: { new(): any; [key: string]: any },
  /** Optional oRPC builder pre-configured with context type */
  builder: typeof os = os,
): BuildResult {
  const crud = getCrudMeta(ControllerClass)
  const singleton = getSingletonMeta(ControllerClass)
  const scopes = getScopes(ControllerClass)
  const mutations = getMutations(ControllerClass)
  const plainActions = getActions(ControllerClass)
  const controllerMeta = getControllerMeta(ControllerClass)

  const resourcePath = controllerMeta?.path ?? inferControllerPath(ControllerClass)
  // Build full path including @scope prefixes
  // e.g. @scope('teamId') + /campaigns → /teams/:teamId/campaigns
  const scopePrefix = scopes.map(s => `/${s.resource}/:${s.paramName}`).join('')
  const basePath = scopePrefix + resourcePath

  const routes: RouteRecord[] = []
  const router: Record<string, any> = {}

  // ── Shared: create a controller instance with context + params ─────────────

  function makeController(
    context: TContext,
    params: Record<string, any>,
    startRelation: any,
    record?: any,
  ): any {
    const inst = new ControllerClass()
    inst['context']  = context
    inst['params']   = params
    inst['input']    = params   // alias
    inst['relation'] = startRelation
    inst['state']    = {}
    if (record !== undefined) inst['record'] = record
    return inst
  }

  function buildScopedRelation(model: any, params: Record<string, any>): any {
    let rel = model.all()
    for (const s of scopes) {
      const parentId = params[s.paramName]
      if (parentId === undefined) throw new BadRequest(`Missing scope param: ${s.paramName}`)
      const id = Number(parentId)
      if (isNaN(id)) throw new BadRequest(`${s.paramName} must be a number`)
      rel = rel.where({ [s.field]: id })
    }
    return rel
  }

  /** Convert HttpErrors that occur OUTSIDE dispatch (e.g., pre-dispatch record lookups). */
  function wrapErrors<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch(e => {
      if (e instanceof HttpError) throw httpToOrpc(e)
      throw e
    })
  }

  async function dispatch(
    ControllerClass: new () => any,
    context: TContext,
    params: Record<string, any>,
    relation: any,
    actionName: string,
    handler: (ctrl: any) => Promise<any>,
    record?: any,
    /**
     * Optional scopeBy function from @crud config.
     * Applied to ctrl.relation AFTER @before hooks run so that resolved
     * state (e.g., this.state.org) is available when computing the scope.
     */
    scopeByFn?: (ctrl: any) => Record<string, any>,
  ): Promise<any> {
    const ctrl = makeController(context, params, relation, record)
    try {
      await ctrl._runBeforeHooks(actionName)

      // Apply scopeBy after before hooks so this.state is fully populated.
      // This updates ctrl.relation in-place — all default handlers use ctrl.relation.
      if (scopeByFn) {
        const extra = scopeByFn(ctrl)
        ctrl['relation'] = ctrl['relation'].where(extra)
      }

      const result = await handler(ctrl)
      await ctrl._runAfterHooks(actionName)
      return result
    } catch (e) {
      // 1. User-defined @rescue handlers (can convert or swallow the error)
      const rescued = await ctrl._handleError(e, actionName)
      if (rescued.handled) return rescued.value

      // 2. Auto-rescue: RecordNotFound from the ORM → 404
      if (isRecordNotFound(e)) {
        throw new ORPCError('NOT_FOUND', { message: (e as Error).message })
      }

      // 3. HttpError subclasses (BadRequest, Unauthorized, etc.) → oRPC error
      if (e instanceof HttpError) throw httpToOrpc(e)

      // 4. Re-throw unknown errors as-is
      throw e
    }
  }

  /** Duck-type check for RecordNotFound (avoids a hard dep on @active-drizzle/core). */
  function isRecordNotFound(e: unknown): boolean {
    return e instanceof Error && (e as any).name === 'RecordNotFound'
  }

  // ── CRUD routes ───────────────────────────────────────────────────────────

  if (crud) {
    const { model, config } = crud

    // Shared scope param schema
    const scopeSchema: Record<string, z.ZodTypeAny> = {}
    for (const s of scopes) scopeSchema[s.paramName] = z.number().int().positive()

    // INDEX
    router.index = builder.input(
      z.object({
        ...scopeSchema,
        scopes:  z.array(z.string()).optional(),
        filters: z.record(z.string(), z.any()).optional(),
        ids:     z.array(z.number()).optional(),
        sort:    z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
        page:    z.number().int().min(0).optional(),
        perPage: z.number().int().positive().optional(),
        // paramScopes: spread into top-level as optional string fields
        ...(config.index?.paramScopes ?? []).reduce((acc, ps) => {
          acc[ps] = z.string().optional()
          return acc
        }, {} as Record<string, z.ZodTypeAny>),
      }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'index',
        async (ctrl) => {
          if (typeof ctrl.index === 'function') return ctrl.index()
          return defaultIndex(ctrl.relation, model, config, input as any)
        },
        undefined,
        config.scopeBy,
      )
    })
    routes.push({ method: 'GET', path: basePath, procedure: 'index', action: 'index' })

    // GET
    router.get = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive() }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'get',
        async (ctrl) => {
          if (typeof ctrl.get === 'function') return ctrl.get()
          return defaultGet(ctrl.relation, model, config, (input as any).id)
        },
        undefined,
        config.scopeBy,
      )
    })
    routes.push({ method: 'GET', path: `${basePath}/:id`, procedure: 'get', action: 'get' })

    // CREATE
    router.create = builder.input(
      z.object({ ...scopeSchema, data: z.record(z.string(), z.any()) }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'create',
        async (ctrl) => {
          if (typeof ctrl.create === 'function') return ctrl.create()
          // Scope fields (from URL params) are always injected, bypassing permit list.
          // scopeBy fields are handled via autoSet; they're derived from state, not URL params.
          const scopeOverrides: Record<string, any> = {}
          for (const s of scopes) scopeOverrides[s.field] = (input as any)[s.paramName]
          return defaultCreate(ctrl.relation, model, config, (input as any).data ?? {}, context, scopeOverrides, ctrl)
        },
        undefined,
        config.scopeBy,
      )
    })
    routes.push({ method: 'POST', path: basePath, procedure: 'create', action: 'create' })

    // UPDATE
    router.update = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive(), data: z.record(z.string(), z.any()) }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'update',
        async (ctrl) => {
          if (typeof ctrl.update === 'function') return ctrl.update()
          return defaultUpdate(ctrl.relation, model, config, (input as any).id, (input as any).data, ctrl)
        },
        undefined,
        config.scopeBy,
      )
    })
    routes.push({ method: 'PATCH', path: `${basePath}/:id`, procedure: 'update', action: 'update' })

    // DESTROY
    router.destroy = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive() }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'destroy',
        async (ctrl) => {
          if (typeof ctrl.destroy === 'function') return ctrl.destroy()
          await defaultDestroy(ctrl.relation, model, (input as any).id)
          return { success: true }
        },
        undefined,
        config.scopeBy,
      )
    })
    routes.push({ method: 'DELETE', path: `${basePath}/:id`, procedure: 'destroy', action: 'destroy' })

    // @mutation methods
    for (const mut of mutations) {
      const kebab = toKebab(mut.method)
      if (mut.bulk) {
        router[mut.method] = builder.input(
          z.object({ ...scopeSchema, ids: z.array(z.number().int().positive()) }).passthrough()
        ).handler(async ({ input, context }) => {
          const rel = buildScopedRelation(model, input as any)
          return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
            async (ctrl) => {
              const ids = (input as any).ids
              // Apply id filter to ctrl.relation so method can use this.relation.updateAll()
              ctrl.relation = ctrl.relation.where({ id: ids })
              // If records: false, pass ids directly for efficient updateAll() usage.
              // Otherwise, load all records (backward compat).
              if (mut.records === false) {
                return ctrl[mut.method](ids)
              } else {
                const records = await ctrl.relation.load()
                return ctrl[mut.method](records)
              }
            },
            undefined,
            config.scopeBy,
          )
        })
        routes.push({ method: 'POST', path: `${basePath}/${kebab}`, procedure: mut.method, action: mut.method })
      } else {
        router[mut.method] = builder.input(
          z.object({ ...scopeSchema, id: z.number().int().positive(), data: z.record(z.string(), z.any()).optional() }).passthrough()
        ).handler(async ({ input, context }) => wrapErrors(async () => {
          const rel = buildScopedRelation(model, input as any)
          // Pre-load record from URL-scoped relation so this.record is available in @before hooks.
          // scopeBy adds defence-in-depth: it's applied to ctrl.relation inside dispatch,
          // ensuring further queries within the action are fully scoped.
          const record = await rel.where({ id: (input as any).id }).first()
          if (!record) throw new NotFound(model.name)
          return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
            (ctrl) => ctrl[mut.method](record, (input as any).data),
            record,
            config.scopeBy,
          )
        }))
        routes.push({ method: 'POST', path: `${basePath}/:id/${kebab}`, procedure: mut.method, action: mut.method })
      }
    }
  }

  // ── Singleton routes ──────────────────────────────────────────────────────

  if (singleton) {
    const { model, config } = singleton
    const singletonModel: any = model
    const scopeSchema: Record<string, z.ZodTypeAny> = {}
    for (const s of scopes) scopeSchema[s.paramName] = z.number().int().positive()

    router.get = builder.input(z.object(scopeSchema).passthrough()).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(singletonModel, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'get',
        async (ctrl) => {
          if (typeof ctrl.get === 'function') return ctrl.get()
          // Pass ctrl so findBy can access this.state (e.g., org resolved by @before hook)
          const findBy = config.findBy(context, ctrl)
          const record = await singletonModel.findBy(findBy)
          if (!record) throw new NotFound(singletonModel.name)
          const inc = config.get?.include ?? []
          if (inc.length) return rel.where(findBy).includes(...inc).first()
          return record
        })
    })
    routes.push({ method: 'GET', path: basePath, procedure: 'get', action: 'get' })

    if (config.findOrCreate) {
      router.findOrCreate = builder.input(z.object(scopeSchema).passthrough()).handler(async ({ input, context }) => {
        const rel = buildScopedRelation(singletonModel, input as any)
        return dispatch(ControllerClass, context as TContext, input as any, rel, 'findOrCreate',
          async (ctrl) => singletonFindOrCreate(
            singletonModel,
            config.findBy(context, ctrl),
            config.defaultValues ?? {},
          ))
      })
      routes.push({ method: 'POST', path: basePath, procedure: 'findOrCreate', action: 'findOrCreate' })
    }

    router.update = builder.input(
      z.object({ ...scopeSchema, data: z.record(z.string(), z.any()) }).passthrough()
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(singletonModel, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'update',
        async (ctrl) => {
          if (typeof ctrl.update === 'function') return ctrl.update()
          const findBy = config.findBy(context, ctrl)
          const record = await singletonModel.findBy(findBy)
          if (!record) throw new NotFound(singletonModel.name)
          const permitted = buildUpdatePermit((input as any).data, config.update, context, ctrl)
          for (const [k, v] of Object.entries(permitted)) (record as any)[k] = v
          if (!(await record.save())) throw toValidationError(record.errors)
          return record
        })
    })
    routes.push({ method: 'PATCH', path: basePath, procedure: 'update', action: 'update' })

    // @mutation methods on singleton (no :id)
    for (const mut of mutations) {
      const kebab = toKebab(mut.method)
      router[mut.method] = builder.input(
        z.object({ ...scopeSchema, data: z.record(z.string(), z.any()).optional() }).passthrough()
      ).handler(async ({ input, context }) => {
        const rel = buildScopedRelation(singletonModel, input as any)
        return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
          async (ctrl) => {
            const findBy = config.findBy(context, ctrl)
            const record = await singletonModel.findBy(findBy)
            if (!record) throw new NotFound(model.name)
            return ctrl[mut.method](record, (input as any).data)
          })
      })
      routes.push({ method: 'POST', path: `${basePath}/${kebab}`, procedure: mut.method, action: mut.method })
    }
  }

  // ── Plain @action routes ──────────────────────────────────────────────────

  for (const act of plainActions) {
    const crudModel = crud?.model ?? singleton?.model
    const usesId    = act.load && !!crudModel
    const defaultPath = usesId
      ? `${basePath}/:id/${toKebab(act.method)}`
      : `${basePath}/${toKebab(act.method)}`
    const path = act.path ?? defaultPath

    const scopeSchema: Record<string, z.ZodTypeAny> = {}
    for (const s of scopes) scopeSchema[s.paramName] = z.number().int().positive()

    if (usesId) {
      // Load the record by :id and pass as first arg, like @mutation
      router[act.method] = builder.input(
        z.object({ ...scopeSchema, id: z.number().int().positive(), data: z.record(z.string(), z.any()).optional() }).passthrough()
      ).handler(async ({ input, context }) => wrapErrors(async () => {
        const rel = buildScopedRelation(crudModel!, input as any)
        const record = await rel.where({ id: (input as any).id }).first()
        if (!record) throw new NotFound(crudModel!.name)
        return dispatch(
          ControllerClass, context as TContext, input as any, rel, act.method,
          (ctrl) => ctrl[act.method](record, (input as any).data ?? input),
          record,
        )
      }))
    } else {
      router[act.method] = builder.input(
        z.object({ ...scopeSchema, data: z.record(z.string(), z.any()).optional() }).passthrough()
      ).handler(async ({ input, context }) => {
        const rel = crudModel ? buildScopedRelation(crudModel, input as any) : null
        return dispatch(ControllerClass, context as TContext, input as any, rel as any, act.method,
          (ctrl) => ctrl[act.method]((input as any).data ?? input))
      })
    }
    routes.push({ method: act.httpMethod, path, procedure: act.method, action: act.method })
  }

  return { router, routes, basePath }
}

// ── Merge multiple routers ────────────────────────────────────────────────────

export function mergeRouters(
  ...results: BuildResult[]
): { router: Record<string, any>; routes: RouteRecord[] } {
  const router: Record<string, any> = {}
  const routes: RouteRecord[] = []
  for (const r of results) {
    // Use basePath as namespace key (strip leading /, replace / with _)
    const ns = r.basePath.replace(/^\//, '').replace(/[/:]/g, '_')
    router[ns] = r.router
    routes.push(...r.routes)
  }
  return { router, routes }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toKebab(name: string): string {
  return name.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase()).replace(/^-/, '')
}

function httpToOrpc(e: HttpError): ORPCError<string, unknown> {
  const STATUS_TO_CODE: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    422: 'UNPROCESSABLE_ENTITY',
  }
  const code = STATUS_TO_CODE[e.status] ?? 'INTERNAL_SERVER_ERROR'
  const data = e instanceof ValidationError ? { errors: e.errors } : undefined
  return new ORPCError(code, { message: e.message, data })
}

function buildUpdatePermit(
  data: Record<string, any>,
  updateConfig?: { permit?: string[] | ((ctx: any, ctrl: any) => string[]); restrict?: string[] },
  ctx?: any,
  ctrl?: any,
): Record<string, any> {
  const { permit, restrict } = updateConfig ?? {}
  const resolvedPermit = typeof permit === 'function' ? permit(ctx, ctrl) : permit
  if (resolvedPermit) {
    return Object.fromEntries(Object.entries(data).filter(([k]) => resolvedPermit.includes(k)))
  }
  const out = { ...data }
  for (const k of ['id', 'createdAt', 'updatedAt', 'created_at', 'updated_at']) delete out[k]
  if (restrict) for (const k of restrict) delete out[k]
  return out
}
