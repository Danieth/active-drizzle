/**
 * Post-wave-2 hardening — the reviewer-flagged follow-ups + the encryption
 * carve-out (DESIGN-field-encryption §3.3: permissive-by-default is
 * SUSPENDED the moment a column is .encrypt()'d) + taxonomy threading
 * through the oRPC lane.
 */
import { describe, it, expect, vi } from 'vitest'
import { call } from '@orpc/server'
import { buildRouter } from '../src/router.js'
import { ActiveController } from '../src/base.js'
import { controller, crud, singleton } from '../src/decorators.js'
import { defaultUpdate, encryptedAttrNames } from '../src/crud-handlers.js'

const encryptedAttr = { _encrypted: { mode: 'randomized' } }

function crudModel(extra: Record<string, any> = {}) {
  const M: any = class Deal {
    static all() { return { where: () => M.all(), first: async () => null } }
  }
  for (const [k, v] of Object.entries(extra)) M[k] = v
  return M
}

describe('the encryption carve-out (permissive-by-default suspended)', () => {
  it('a crud door over an encrypted model with NO read ceiling refuses to build', () => {
    @controller('/deals')
    @crud(crudModel({ ssn: encryptedAttr }), {})
    class C extends ActiveController {}
    expect(() => buildRouter(C as any)).toThrow(/ssn is encrypted.*no read ceiling.*get: \{ expose/s)
  })

  it('a declared ceiling satisfies the carve-out — even one excluding the encrypted field', () => {
    @controller('/deals')
    @crud(crudModel({ ssn: encryptedAttr }), { get: { expose: ['name'] } })
    class C extends ActiveController {}
    expect(() => buildRouter(C as any)).not.toThrow()
  })

  it('an unencrypted model keeps permissive-by-default (no ceiling required)', () => {
    @controller('/deals')
    @crud(crudModel(), {})
    class C extends ActiveController {}
    expect(() => buildRouter(C as any)).not.toThrow()
  })

  it('a singleton door over an encrypted model refuses outright (no ceiling exists to declare)', () => {
    @controller('/settings')
    @singleton(crudModel({ apiSecret: encryptedAttr }))
    class C extends ActiveController {}
    expect(() => buildRouter(C as any)).toThrow(/singleton doors have no read ceiling/)
  })

  it('encryptedAttrNames sees STI-inherited encrypted attrs', () => {
    const Parent = crudModel({ ssn: encryptedAttr })
    class Child extends Parent {}
    expect(encryptedAttrNames(Child)).toContain('ssn')
  })
})

describe('mismatched numeric lock column fails loud (reviewer follow-up)', () => {
  const makeRecord = (lockVal: any) => ({
    id: 1, rev: lockVal,
    save: vi.fn(async () => true),
    errors: { all: () => ({}), details: () => ({}) },
    toJSON: () => ({ id: 1 }),
  })
  const relation = { where: () => relation, first: async () => makeRecord(3), includes: () => relation } as any

  it("optimisticLock: 'rev' on a model without lockingColumn = 'rev' → teaching error", async () => {
    const model = crudModel()
    await expect(
      defaultUpdate(relation, model, { update: { optimisticLock: 'rev', permit: ['name'] } } as any,
        { id: 1, data: { name: 'x' } }, {}, undefined, { constructor: {} }),
    ).rejects.toThrow(/lockingColumn = 'rev'.*never advances/s)
  })

  it('the declared lockingColumn silences it', async () => {
    const model = crudModel({ lockingColumn: 'rev' })
    const rec = makeRecord(3)
    const rel = { where: () => rel, first: async () => rec, includes: () => rel } as any
    await expect(
      defaultUpdate(rel, model, { update: { optimisticLock: 'rev', permit: ['name'] } } as any,
        { id: 1, data: { name: 'x' } }, {}, undefined, { constructor: {} }),
    ).resolves.toBeDefined()
  })

  it("the 'lockVersion' convention needs no declaration", async () => {
    const rec = { id: 1, lockVersion: 3, save: vi.fn(async () => true), errors: { all: () => ({}) }, toJSON: () => ({ id: 1 }) }
    const rel = { where: () => rel, first: async () => rec, includes: () => rel } as any
    await expect(
      defaultUpdate(rel, crudModel(), { update: { optimisticLock: 'lockVersion', permit: ['name'] } } as any,
        { id: 1, data: { name: 'x' } }, {}, undefined, { constructor: {} }),
    ).resolves.toBeDefined()
  })
})

describe('taxonomy threading through the oRPC lane', () => {
  it('a required-param 422 carries coded details end-to-end through a real route', async () => {
    const rec = { id: 1, teamId: 7, save: vi.fn(async () => true), errors: {}, toJSON: () => ({ id: 1 }) }
    const rel: any = { where: () => rel, first: async () => rec }
    const Model: any = class Deal { static all() { return rel } }
    @controller('/deals')
    @crud(Model, {})
    class C extends ActiveController {
      declare record: any
      async reject(this: any) { return { ok: true } }
    }
    // decorate via metadata helpers indirectly: use a mutation with required
    const { mutation } = await import('../src/decorators.js')
    @controller('/deals2')
    @crud(Model, {})
    class D extends ActiveController {
      @mutation({ required: ['reason'] })
      async reject(this: any) { return { ok: true } }
    }
    const { router } = buildRouter(D as any)
    const err: any = await call(router.reject, { id: 1, data: {} } as any, { context: {} })
      .then(() => null, (e: any) => e)
    expect(err).not.toBeNull()
    expect(err.status).toBe(422)
    expect(err.data.code).toBe('validation_failed')
    expect(err.data.details).toEqual({ reason: [{ code: 'blank', message: 'is required' }] })
    expect(err.data.errors).toEqual({ reason: ['is required'] })
  })
})

describe('_key echo: the envelope stitches created-child keys onto serialized rows', () => {
  it('buildRecordEnvelope adds _key to rows named in _lastNestedKeys', async () => {
    const { buildRecordEnvelope } = await import('../src/crud-handlers.js')
    const record: any = {
      id: 1,
      _lastNestedKeys: { notes: { '41': 'new:3' } },
      toJSON: () => ({ id: 1, notes: [{ id: 40, body: 'old' }, { id: 41, body: 'fresh' }] }),
    }
    const Model: any = class Deal {}
    const env = buildRecordEnvelope(record, Model,
      { get: { expose: ['notes'], include: ['notes'] } } as any, {}, { constructor: {} })
    expect(env.record.notes).toEqual([
      { id: 40, body: 'old' },
      { id: 41, body: 'fresh', _key: 'new:3' },
    ])
  })

  it('no map → rows untouched (hand-rolled and read paths unchanged)', async () => {
    const { buildRecordEnvelope } = await import('../src/crud-handlers.js')
    const record: any = { id: 1, toJSON: () => ({ id: 1, notes: [{ id: 40 }] }) }
    const env = buildRecordEnvelope(record, class Deal {} as any,
      { get: { expose: ['notes'], include: ['notes'] } } as any, {}, { constructor: {} })
    expect(env.record.notes).toEqual([{ id: 40 }])
  })
})
