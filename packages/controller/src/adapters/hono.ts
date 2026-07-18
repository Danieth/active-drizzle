/**
 * Hono adapter — maps oRPC router procedures to Hono routes.
 *
 * Usage:
 *   import { Hono } from 'hono'
 *   import { honoAdapter } from '@active-drizzle/controller/hono'
 *
 *   const app = new Hono()
 *   app.route('/api', honoAdapter(mergedRouter, routes, getContext))
 */
import type { RouteRecord } from '../router.js'
import { serializeError, HttpError } from '../errors.js'
import { reportError, translateDbError } from '@active-drizzle/core'

type AnyContext = Record<string, any>

/**
 * Creates a minimal Hono-compatible route handler object.
 * Rather than depending on Hono directly (keeping it optional), we return
 * a plain descriptor array that users mount on their Hono app.
 *
 * For projects using Hono:
 *
 *   const handlers = honoAdapter(router, routes, ctx => ctx.var.auth)
 *   for (const h of handlers) app[h.method](h.path, h.handler)
 */
export function honoAdapter<TContext = AnyContext>(
  router: Record<string, any>,
  routes: RouteRecord[],
  getContext: (c: any) => TContext,
): Array<{ method: string; path: string; handler: (c: any) => Promise<Response> }> {
  return routes.map(route => ({
    method: route.method.toLowerCase(),
    path: toHonoPath(route.path),
    handler: async (c: any) => {
      try {
        const context = getContext(c)
        const pathParams = c.req.param() ?? {}
        const queryParams = route.method === 'GET' ? c.req.query() ?? {} : {}
        let body: Record<string, any> = {}
        if (route.method !== 'GET') {
          try { body = await c.req.json() } catch { body = {} }
        }
        // Coerce numeric path params — but only CANONICAL numbers, i.e.
        // strings that survive a Number round-trip. This keeps zip codes
        // ('01234'), hex/exponent forms ('0x10', '1e5'), 'Infinity'/'NaN',
        // and ids past 2^53 (which Number would silently round) as strings.
        const numericParams: Record<string, any> = {}
        for (const [k, v] of Object.entries({ ...pathParams, ...queryParams })) {
          const n = Number(v)
          numericParams[k] =
            typeof v === 'string' && v !== '' && Number.isFinite(n) && String(n) === v ? n : v
        }
        const input = { ...numericParams, ...body }
        const procedure = resolveProcedure(router, route.procedure)
        const result = await callProcedure(procedure, input, context)
        return Response.json(result)
      } catch (err) {
        if (err instanceof HttpError) {
          const { status, body } = serializeError(err)
          return Response.json(body, { status })
        }
        // Raw error to the app's onError handlers (Rollbar/Sentry/…);
        // a translated, user-safe message in the response.
        reportError(err, { procedure: route.procedure, method: route.method, path: route.path })
        const t = translateDbError(err)
        if (t) {
          const status = t.kind === 'unavailable' ? 503 : t.kind === 'retryable' ? 409 : 422
          const body = t.field ? { errors: { [t.field]: [t.message] } } : { error: t.friendly }
          return Response.json(body, { status })
        }
        return Response.json({ error: 'Internal server error' }, { status: 500 })
      }
    },
  }))
}

// Convert express/rails-style `:param` to Hono's `:param` (same syntax)
function toHonoPath(path: string): string {
  return path  // they already match
}

function resolveProcedure(router: Record<string, any>, dotPath: string): any {
  return dotPath.split('.').reduce((obj, key) => obj?.[key], router)
}

async function callProcedure(procedure: any, input: any, context: any): Promise<any> {
  if (!procedure) throw new Error('Procedure not found')
  // oRPC procedures are callable via .handler or as functions
  if (typeof procedure === 'function') return procedure({ input, context })
  if (typeof procedure?.handler === 'function') return procedure.handler({ input, context })
  // oRPC 1.x: call via the built-in call helper
  if (procedure?.['~orpc']) {
    const { call } = await import('@orpc/server')
    return call(procedure, input, { context })
  }
  throw new Error('Cannot call procedure')
}
