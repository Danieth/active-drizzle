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

  function makeController(context: TContext, params: Record<string, any>, startRelation: any): any {
    const inst = new ControllerClass()
    inst['context'] = context
    inst['params'] = params
    inst['relation'] = startRelation
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
  ): Promise<any> {
    const ctrl = makeController(context, params, relation)
    try {
      await ctrl._runBeforeHooks(actionName)
      const result = await handler(ctrl)
      await ctrl._runAfterHooks(actionName)
      return result
    } catch (e) {
      if (e instanceof HttpError) throw httpToOrpc(e)
      throw e
    }
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
      })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'index',
        async (ctrl) => {
          if (typeof ctrl.index === 'function') return ctrl.index()
          return defaultIndex(rel, model, config, input as any)
        })
    })
    routes.push({ method: 'GET', path: basePath, procedure: 'index', action: 'index' })

    // GET
    router.get = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive() })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'get',
        async (ctrl) => {
          if (typeof ctrl.get === 'function') return ctrl.get()
          return defaultGet(rel, model, config, (input as any).id)
        })
    })
    routes.push({ method: 'GET', path: `${basePath}/:id`, procedure: 'get', action: 'get' })

    // CREATE
    router.create = builder.input(
      z.object({ ...scopeSchema, data: z.record(z.string(), z.any()) })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'create',
        async (ctrl) => {
          if (typeof ctrl.create === 'function') return ctrl.create()
          // Scope fields (from URL params) are always injected, bypassing permit list
          const scopeOverrides: Record<string, any> = {}
          for (const s of scopes) scopeOverrides[s.field] = (input as any)[s.paramName]
          return defaultCreate(rel, model, config, (input as any).data ?? {}, context, scopeOverrides)
        })
    })
    routes.push({ method: 'POST', path: basePath, procedure: 'create', action: 'create' })

    // UPDATE
    router.update = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive(), data: z.record(z.string(), z.any()) })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'update',
        async (ctrl) => {
          if (typeof ctrl.update === 'function') return ctrl.update()
          return defaultUpdate(rel, model, config, (input as any).id, (input as any).data)
        })
    })
    routes.push({ method: 'PATCH', path: `${basePath}/:id`, procedure: 'update', action: 'update' })

    // DESTROY
    router.destroy = builder.input(
      z.object({ ...scopeSchema, id: z.number().int().positive() })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(model, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'destroy',
        async (ctrl) => {
          if (typeof ctrl.destroy === 'function') return ctrl.destroy()
          await defaultDestroy(rel, model, (input as any).id)
          return { success: true }
        })
    })
    routes.push({ method: 'DELETE', path: `${basePath}/:id`, procedure: 'destroy', action: 'destroy' })

    // @mutation methods
    for (const mut of mutations) {
      const kebab = toKebab(mut.method)
      if (mut.bulk) {
        router[mut.method] = builder.input(
          z.object({ ...scopeSchema, ids: z.array(z.number().int().positive()) })
        ).handler(async ({ input, context }) => {
          const rel = buildScopedRelation(model, input as any)
          const records = await rel.where({ id: (input as any).ids }).load()
          return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
            (ctrl) => ctrl[mut.method](records))
        })
        routes.push({ method: 'POST', path: `${basePath}/${kebab}`, procedure: mut.method, action: mut.method })
      } else {
        router[mut.method] = builder.input(
          z.object({ ...scopeSchema, id: z.number().int().positive(), data: z.record(z.string(), z.any()).optional() })
        ).handler(async ({ input, context }) => wrapErrors(async () => {
          const rel = buildScopedRelation(model, input as any)
          const record = await rel.where({ id: (input as any).id }).first()
          if (!record) throw new NotFound(model.name)
          return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
            (ctrl) => ctrl[mut.method](record, (input as any).data))
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

    router.get = builder.input(z.object(scopeSchema)).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(singletonModel, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'get',
        async (ctrl) => {
          if (typeof ctrl.get === 'function') return ctrl.get()
          const findBy = config.findBy(context)
          const record = await singletonModel.findBy(findBy)
          if (!record) throw new NotFound(singletonModel.name)
          const inc = config.get?.include ?? []
          if (inc.length) return rel.where(findBy).includes(...inc).first()
          return record
        })
    })
    routes.push({ method: 'GET', path: basePath, procedure: 'get', action: 'get' })

    if (config.findOrCreate) {
      router.findOrCreate = builder.input(z.object(scopeSchema)).handler(async ({ input, context }) => {
        const rel = buildScopedRelation(singletonModel, input as any)
        return dispatch(ControllerClass, context as TContext, input as any, rel, 'findOrCreate',
          async () => singletonFindOrCreate(singletonModel, config.findBy(context), config.defaultValues ?? {}))
      })
      routes.push({ method: 'POST', path: basePath, procedure: 'findOrCreate', action: 'findOrCreate' })
    }

    router.update = builder.input(
      z.object({ ...scopeSchema, data: z.record(z.string(), z.any()) })
    ).handler(async ({ input, context }) => {
      const rel = buildScopedRelation(singletonModel, input as any)
      return dispatch(ControllerClass, context as TContext, input as any, rel, 'update',
        async (ctrl) => {
          if (typeof ctrl.update === 'function') return ctrl.update()
          const findBy = config.findBy(context)
          const record = await singletonModel.findBy(findBy)
          if (!record) throw new NotFound(singletonModel.name)
          const permitted = buildUpdatePermit((input as any).data, config.update)
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
        z.object({ ...scopeSchema, data: z.record(z.string(), z.any()).optional() })
      ).handler(async ({ input, context }) => {
        const rel = buildScopedRelation(singletonModel, input as any)
        const findBy = config.findBy(context)
        const record = await singletonModel.findBy(findBy)
        if (!record) throw new NotFound(model.name)
        return dispatch(ControllerClass, context as TContext, input as any, rel, mut.method,
          (ctrl) => ctrl[mut.method](record, (input as any).data))
      })
      routes.push({ method: 'POST', path: `${basePath}/${kebab}`, procedure: mut.method, action: mut.method })
    }
  }

  // ── Plain @action routes ──────────────────────────────────────────────────

  for (const act of plainActions) {
    const path = act.path ?? `${basePath}/${toKebab(act.method)}`
    const scopeSchema: Record<string, z.ZodTypeAny> = {}
    for (const s of scopes) scopeSchema[s.paramName] = z.number().int().positive()
    router[act.method] = builder.input(
      z.object({ ...scopeSchema, data: z.record(z.string(), z.any()).optional() })
    ).handler(async ({ input, context }) => {
      const rel = null
      return dispatch(ControllerClass, context as TContext, input as any, rel as any, act.method,
        (ctrl) => ctrl[act.method]((input as any).data ?? input))
    })
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
  updateConfig?: { permit?: string[]; restrict?: string[] },
): Record<string, any> {
  const { permit, restrict } = updateConfig ?? {}
  if (permit) {
    return Object.fromEntries(Object.entries(data).filter(([k]) => permit.includes(k)))
  }
  const out = { ...data }
  for (const k of ['id', 'createdAt', 'updatedAt', 'created_at', 'updated_at']) delete out[k]
  if (restrict) for (const k of restrict) delete out[k]
  return out
}
