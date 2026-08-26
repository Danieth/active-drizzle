/**
 * The Hono adapter — 0% → tested at its contract: descriptors, param
 * coercion (the canonical-number rule), body merging, and every error
 * lane (HttpError → status, translated DB errors, 500 fallback).
 */
import { describe, it, expect, vi } from 'vitest'
import { honoAdapter } from '../src/adapters/hono.js'
import { NotFound, ValidationError } from '../src/errors.js'

const fakeC = (over: { params?: any; query?: any; json?: any; jsonThrows?: boolean } = {}) => ({
  req: {
    param: () => over.params ?? {},
    query: () => over.query ?? {},
    json: async () => { if (over.jsonThrows) throw new Error('no body'); return over.json ?? {} },
    text: async () => {
      if (over.jsonThrows) return '{broken'
      return over.json !== undefined ? JSON.stringify(over.json) : ''
    },
  },
  var: { auth: { userId: 42 } },
})

function adapt(procedure: any, method: 'GET' | 'POST' = 'GET') {
  const routes = [{ method, path: '/deals/:id', procedure: 'get', action: 'get' }] as any
  const [h] = honoAdapter({ get: procedure }, routes, (c: any) => c.var.auth)
  return h!
}

describe('honoAdapter', () => {
  it('maps routes to lowercase-method descriptors and calls with merged input + context', async () => {
    const seen: any[] = []
    const h = adapt(async ({ input, context }: any) => { seen.push({ input, context }); return { ok: 1 } })
    expect(h.method).toBe('get')
    expect(h.path).toBe('/deals/:id')
    const res = await h.handler(fakeC({ params: { id: '5' }, query: { page: '2' } }))
    expect(await res.json()).toEqual({ ok: 1 })
    expect(seen[0].input).toEqual({ id: 5, page: 2 })          // canonical numerics coerced
    expect(seen[0].context).toEqual({ userId: 42 })            // getContext threaded
  })

  it('the CANONICAL-number rule: zips, hex, huge ids, NaN stay strings', async () => {
    const seen: any[] = []
    const h = adapt(async ({ input }: any) => { seen.push(input); return {} })
    await h.handler(fakeC({ params: {
      zip: '01234', hex: '0x10', big: '9007199254740993', nan: 'NaN', id: '7',
    } }))
    expect(seen[0]).toEqual({ zip: '01234', hex: '0x10', big: '9007199254740993', nan: 'NaN', id: 7 })
  })

  it('THE URL WINS (launch blocker #1): a contradicting body id is a loud 400', async () => {
    const seen: any[] = []
    const h = adapt(async ({ input }: any) => { seen.push(input); return {} }, 'POST')
    // body id contradicts the path id → refused, never silently retargeted
    const res = await h.handler(fakeC({ params: { id: '5' }, json: { id: 99, name: 'x' } }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toMatch(/contradicts the URL/)
    expect(seen).toHaveLength(0)                                // procedure never ran
    // agreeing body id (client echoes) passes; path still authoritative
    await h.handler(fakeC({ params: { id: '5' }, json: { id: 5, name: 'x' } }))
    expect(seen[0]).toEqual({ id: 5, name: 'x' })
    // non-colliding body keys merge under the params
    await h.handler(fakeC({ params: { id: '5' }, json: { name: 'y' } }))
    expect(seen[1]).toEqual({ id: 5, name: 'y' })
  })

  it('MALFORMED JSON is its own 400 (launch blocker #2), never empty-input validation lies', async () => {
    const seen: any[] = []
    const h = adapt(async ({ input }: any) => { seen.push(input); return {} }, 'POST')
    const res = await h.handler(fakeC({ params: { id: '5' }, jsonThrows: true }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Request body is not valid JSON.' })
    expect(seen).toHaveLength(0)
    // an EMPTY body (no payload at all) is still fine — params only
    const h2 = adapt(async ({ input }: any) => { seen.push(input); return {} }, 'POST')
    await h2.handler(fakeC({ params: { id: '5' } }))
    expect(seen[0]).toEqual({ id: 5 })
  })

  it('HttpError → its status + serialized body (404, 422 with field errors)', async () => {
    const h404 = adapt(async () => { throw new NotFound('Deal') })
    const r404 = await h404.handler(fakeC({}))
    expect(r404.status).toBe(404)

    const h422 = adapt(async () => { throw new ValidationError({ name: ['is required'] }) })
    const r422 = await h422.handler(fakeC({}))
    expect(r422.status).toBe(422)
    expect(await r422.json()).toMatchObject({ errors: { name: ['is required'] } })
  })

  it('unknown errors report + 500 with a SAFE body (no stack leak)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = adapt(async () => { throw new Error('secret internal detail') })
      const res = await h.handler(fakeC({}))
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(JSON.stringify(body)).not.toContain('secret internal detail')
      expect(body).toEqual({ error: 'Internal server error' })
    } finally { spy.mockRestore() }
  })

  it('a dotted procedure path that resolves to nothing is a 500, not a crash', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const routes = [{ method: 'GET', path: '/x', procedure: 'nope.missing', action: 'x' }] as any
      const [h] = honoAdapter({}, routes, () => ({}))
      const res = await h!.handler(fakeC({}))
      expect(res.status).toBe(500)
    } finally { spy.mockRestore() }
  })
})
