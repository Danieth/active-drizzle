/**
 * ROUTE-LEVEL tests — the gap the security review named ("precisely the
 * surface the test suite doesn't cover at the route level"). Every test
 * drives a REAL oRPC procedure built by buildRouter, through dispatch,
 * hooks, scopeBy, and the guards — no handler internals mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { call } from '@orpc/server'
import { buildRouter } from '../src/router.js'
import { ActiveController } from '../src/base.js'
import { controller, crud, scope, mutation, action, before } from '../src/decorators.js'

// A chainable relation stub — where() narrows a predicate list; first()/
// load() resolve against the ROWS table so scoping is actually exercised.
function makeModel(rows: Array<Record<string, any>>) {
  const matches = (row: any, preds: Array<Record<string, any>>) =>
    preds.every(p => Object.entries(p).every(([k, v]) =>
      Array.isArray(v) ? v.includes(row[k]) : row[k] === v))
  const relation = (preds: Array<Record<string, any>>): any => ({
    where: (p: Record<string, any>) => relation([...preds, p]),
    includes: () => relation(preds),
    first: async () => rows.find(r => matches(r, preds)) ?? null,
    load: async () => rows.filter(r => matches(r, preds)),
    count: async () => rows.filter(r => matches(r, preds)).length,
    limit: () => relation(preds),
    offset: () => relation(preds),
    order: () => relation(preds),
    updateAll: vi.fn(async () => rows.filter(r => matches(r, preds)).length),
  })
  return class Model {
    static all() { return relation([]) }
    static name = 'Deal'
  } as any
}

const row = (id: number, teamId: number, extra: Record<string, any> = {}) => ({
  id, teamId, orgId: teamId * 10, name: `deal-${id}`,
  save: vi.fn(async () => true), errors: {},
  toJSON({ only }: { only?: string[] } = {}) {
    const o: any = {}
    for (const k of only ?? Object.keys(this)) if (k in this && typeof (this as any)[k] !== 'function') o[k] = (this as any)[k]
    return o
  },
})

describe('scope params are LAW at the route boundary', () => {
  const Model = makeModel([row(1, 7), row(2, 8)])

  @controller('/deals')
  @scope('teamId')
  @crud(Model, { get: { expose: ['id', 'name'] } })
  class DealController extends ActiveController {}

  const { router } = buildRouter(DealController as any)

  it('a missing scope param is a 400, never an unscoped query', async () => {
    await expect(call(router.index, {} as any, { context: {} }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it("'' / non-numeric scope params die at the ZOD gate before any query", async () => {
    // The oRPC input schema (z.number().int().positive()) rejects garbage
    // before our handler runs — the runtime '' check remains for the REST
    // adapter path where params arrive as strings
    await expect(call(router.index, { teamId: '' } as any, { context: {} }))
      .rejects.toThrow(/Input validation failed/)
    await expect(call(router.index, { teamId: -1 } as any, { context: {} }))
      .rejects.toThrow(/Input validation failed/)
  })

  it('get through the WRONG team is a 404 — the row exists, the door says no', async () => {
    const mine = await call(router.get, { teamId: 7, id: 1 } as any, { context: {} })
    expect((mine as any).id).toBe(1)
    await expect(call(router.get, { teamId: 8, id: 1 } as any, { context: {} }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('index only serves the scoped rows', async () => {
    const res: any = await call(router.index, { teamId: 7 } as any, { context: {} })
    expect(res.data.map((r: any) => r.id)).toEqual([1])
  })
})

describe('scopeBy narrows AFTER @before state loads (route-level)', () => {
  const Model = makeModel([row(1, 7), row(2, 8)])

  @controller('/deals')
  @crud(Model, { scopeBy: (ctrl: any) => ({ orgId: ctrl.state.orgId }), get: { expose: ['id'] } })
  class OrgDealController extends ActiveController {
    @before()
    loadOrg(this: any) { this.state.orgId = this.context.orgId }
  }
  const { router } = buildRouter(OrgDealController as any)

  it("get 404s a foreign-tenant row even with a valid id", async () => {
    const mine = await call(router.get, { id: 1 } as any, { context: { orgId: 70 } })
    expect((mine as any).id).toBe(1)
    await expect(call(router.get, { id: 1 } as any, { context: { orgId: 80 } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('@action({load:true}) RE-VERIFIES through scopeBy (the #8 fix, at the route)', async () => {
    const Model2 = makeModel([row(1, 7)])
    @controller('/deals2')
    @crud(Model2, { scopeBy: (ctrl: any) => ({ orgId: ctrl.state.orgId }) })
    class C extends ActiveController {
      @before() loadOrg(this: any) { this.state.orgId = this.context.orgId }
      @action('POST', undefined, { load: true })
      async duplicate(record: any) { return { duplicated: record.id } }
    }
    const { router: r } = buildRouter(C as any)
    const ok: any = await call(r.duplicate, { id: 1 } as any, { context: { orgId: 70 } })
    expect(ok.duplicated).toBe(1)
    await expect(call(r.duplicate, { id: 1 } as any, { context: { orgId: 999 } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('mutations at the route boundary', () => {
  it('bulk records:false runs WITHOUT ids on the door-scoped relation', async () => {
    const Model = makeModel([row(1, 7), row(2, 7), row(3, 8)])
    let sawIds: any
    @controller('/deals')
    @scope('teamId')
    @crud(Model, {})
    class C extends ActiveController {
      @mutation({ bulk: true, records: false })
      async markAllRead(this: any, ids: number[]) {
        sawIds = ids
        return { count: await this.relation.count() }
      }
    }
    const { router } = buildRouter(C as any)
    const res: any = await call(router.markAllRead, { teamId: 7 } as any, { context: {} })
    expect(sawIds).toEqual([])                    // no ids sent, none required
    expect(res.count).toBe(2)                     // relation stayed DOOR-scoped
  })

  it('a bulk if-guard refuses ALL-OR-NOTHING with the count in the message', async () => {
    const Model = makeModel([
      { ...row(1, 7), active: true }, { ...row(2, 7), active: false },
    ])
    @controller('/deals')
    @scope('teamId')
    @crud(Model, {})
    class C extends ActiveController {
      @mutation({ bulk: true, if: (d: any) => d.active })
      async archive(records: any[]) { return { n: records.length } }
    }
    const { router } = buildRouter(C as any)
    const err: any = await call(router.archive, { teamId: 7, ids: [1, 2] } as any, { context: {} })
      .then(() => null, (e: any) => e)
    expect(err).not.toBeNull()
    expect(err.status).toBe(422)                             // all-or-nothing 422 on the wire
    expect(JSON.stringify(err.data)).toMatch(/not available for 1 of 2 selected/)
  })

  it('an undeclared _event on update is a 400, not a method call', async () => {
    const Model = makeModel([row(1, 7)])
    @controller('/deals')
    @scope('teamId')
    @crud(Model, { update: { permit: ['name'] } })
    class C extends ActiveController {}
    const { router } = buildRouter(C as any)
    await expect(call(router.update, { teamId: 7, id: 1, data: { _event: 'destroy' } } as any, { context: {} }))
      .rejects.toThrow(/Unknown event 'destroy'/)
  })
})
