/**
 * Forms envelope — expose / abilities / can / version / _event.
 *
 * The M1 acceptance contract:
 *   - DRAFT record → abilities.amount === 'edit'; SUBMITTED → 'view'
 *   - field ∉ expose absent from both record and abilities
 *   - PATCH of a non-permitted field → stripped + { field, code: 'forbidden' }
 *   - _event fires the transition in the same save; blocked → 422
 *   - PATCH response = GET envelope (post-transition re-masking)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  defaultGet, defaultUpdate, defaultIndex, buildRecordEnvelope, sanitizeNestedWrites,
} from '../src/crud-handlers.js'
import { ValidationError, BadRequest } from '../src/errors.js'

// ── Mock model + record (duck-typed ApplicationRecord surface) ───────────────

/** Model statics carrying an Attr.state-shaped config for can() discovery. */
function makeModel() {
  function Loan(this: any) {}
  ;(Loan as any).status = {
    _isAttr: true,
    _type: 'state',
    values: { DRAFT: 0, SUBMITTED: 1 },
    transitions: {
      submit: { from: ['DRAFT'], to: 'SUBMITTED' },
      reopen: { from: ['SUBMITTED'], to: 'DRAFT' },
    },
  }
  return Loan as any // fn.name is already 'Loan'
}

function makeRecord(attrs: Record<string, any>) {
  const record: any = {
    ...attrs,
    _attributes: { ...attrs },
    errors: {},
    save: vi.fn().mockResolvedValue(true),
    toJSON(opts?: { only?: string[] }) {
      const all = { ...attrs }
      for (const k of Object.keys(record)) {
        if (typeof record[k] !== 'function' && !k.startsWith('_') && k !== 'errors') {
          ;(all as any)[k] = record[k]
        }
      }
      delete (all as any)._attributes
      if (opts?.only) return Object.fromEntries(opts.only.filter(k => k in all).map(k => [k, (all as any)[k]]))
      return all
    },
    can(event: string) {
      if (event === 'submit') return record.status === 'DRAFT'
      if (event === 'reopen') return record.status === 'SUBMITTED'
      return false
    },
    submit() {
      if (record.status !== 'DRAFT') return false
      record.status = 'SUBMITTED'
      return true
    },
  }
  return record
}

function relationFor(record: any) {
  return {
    where: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(record),
      includes: vi.fn().mockReturnThis(),
    }),
  } as any
}

const envelopeConfig: any = {
  get: {
    expose: ['id', 'amount', 'status', 'internalNote'],
    abilities: true,
  },
  update: {
    permit: (_ctx: any, _ctrl: any, loan: any) =>
      loan.status === 'DRAFT' ? ['amount', 'internalNote'] : [],
  },
}

const ctx = { userId: 1 }
const ctrl = { state: {} }

// ── GET envelope ─────────────────────────────────────────────────────────────

describe('GET envelope', () => {
  it('DRAFT record → amount is edit; SUBMITTED → view (permit narrows by record state)', async () => {
    const draft = makeRecord({ id: 1, amount: 100, status: 'DRAFT', secret: 'x', updatedAt: new Date(1000) })
    const res1 = await defaultGet(relationFor(draft), makeModel(), envelopeConfig, 1, ctx, ctrl)
    expect(res1.abilities.amount).toBe('edit')
    expect(res1.abilities.status).toBe('view')

    const submitted = makeRecord({ id: 1, amount: 100, status: 'SUBMITTED', updatedAt: new Date(1000) })
    const res2 = await defaultGet(relationFor(submitted), makeModel(), envelopeConfig, 1, ctx, ctrl)
    expect(res2.abilities.amount).toBe('view')
  })

  it('field outside expose is absent from record AND abilities', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', secret: 'classified', updatedAt: new Date(1000) })
    const res = await defaultGet(relationFor(record), makeModel(), envelopeConfig, 1, ctx, ctrl)
    expect(res.record.secret).toBeUndefined()
    expect(res.abilities.secret).toBeUndefined()
  })

  it('can map is server-computed per state event', async () => {
    const record = makeRecord({ id: 1, status: 'DRAFT', updatedAt: new Date(1000) })
    const res = await defaultGet(relationFor(record), makeModel(), envelopeConfig, 1, ctx, ctrl)
    expect(res.can).toEqual({ submit: true, reopen: false })
  })

  it('expose WITHOUT abilities returns a bare filtered record (no envelope)', async () => {
    const record = makeRecord({ id: 1, amount: 5, status: 'DRAFT', secret: 'x' })
    const config = { get: { expose: ['id', 'amount'] } } as any
    const res = await defaultGet(relationFor(record), makeModel(), config, 1, ctx, ctrl)
    expect(res).toEqual({ id: 1, amount: 5 })
  })

  it('no expose → today’s behavior: the record itself', async () => {
    const record = makeRecord({ id: 1, amount: 5 })
    const res = await defaultGet(relationFor(record), makeModel(), {} as any, 1, ctx, ctrl)
    expect(res).toBe(record)
  })
})

// ── PATCH: stripping + forbidden issues + envelope response ──────────────────

describe('PATCH with envelope', () => {
  it('non-permitted field is stripped AND reported as forbidden', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'SUBMITTED', updatedAt: new Date(1000) })
    const res = await defaultUpdate(
      relationFor(record), makeModel(), envelopeConfig, 1,
      { amount: 999 }, ctx, ctrl,
    )
    // SUBMITTED → permit [] → amount stripped
    expect(record.amount).toBe(100)
    expect(res.issues).toContainEqual({ field: 'amount', code: 'forbidden' })
    expect(res.abilities.amount).toBe('view')
  })

  it('permitted PATCH responds with the full envelope (same shape as GET)', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(1000) })
    const res = await defaultUpdate(
      relationFor(record), makeModel(), envelopeConfig, 1,
      { amount: 250 }, ctx, ctrl,
    )
    expect(record.amount).toBe(250)
    expect(res.record.amount).toBe(250)
    expect(res.abilities).toBeDefined()
    expect(res.can).toBeDefined()
    expect(res.issues).toBeUndefined()
  })
})

// ── _event: submit-as-transition ─────────────────────────────────────────────

describe('_event transitions', () => {
  it('fires the event in the same save; envelope re-masks (post-transition self-locking)', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(1000) })
    const res = await defaultUpdate(
      relationFor(record), makeModel(), envelopeConfig, 1,
      { amount: 250, _event: 'submit' }, ctx, ctrl,
    )
    expect(record.status).toBe('SUBMITTED')
    expect(record.save).toHaveBeenCalledTimes(1)     // ONE save: diff + transition
    // Re-masked: SUBMITTED → permit [] → everything view
    expect(res.abilities.amount).toBe('view')
    expect(res.can).toEqual({ submit: false, reopen: true })
  })

  it('blocked event → 422 with transition_blocked, record not saved', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'SUBMITTED', updatedAt: new Date(1000) })
    await expect(
      defaultUpdate(relationFor(record), makeModel(), envelopeConfig, 1,
        { _event: 'submit' }, ctx, ctrl),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(record.save).not.toHaveBeenCalled()
  })

  it('_event never reaches mass assignment', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(1000) })
    await defaultUpdate(relationFor(record), makeModel(), envelopeConfig, 1,
      { _event: 'submit' }, ctx, ctrl)
    expect((record as any)._event).toBeUndefined()
  })

  it("_event is a strict allowlist — '_event: destroy' cannot invoke arbitrary methods", async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(1000) })
    ;(record as any).destroy = vi.fn(async () => true)
    await expect(
      defaultUpdate(relationFor(record), makeModel(), envelopeConfig, 1,
        { _event: 'destroy' }, ctx, ctrl),
    ).rejects.toBeInstanceOf(BadRequest)
    expect((record as any).destroy).not.toHaveBeenCalled()
    expect(record.save).not.toHaveBeenCalled()
  })
})

// ── Nested write sanitization (the controller-level lock) ────────────────────

describe('sanitizeNestedWrites', () => {
  function nestedModel() {
    const m = makeModel()
    ;(m as any).tableName = 'loans'
    ;(m as any).notes = { _type: 'hasMany', table: 'notes', options: { acceptsNested: true } }
    return m
  }

  it('strips server-owned fields, the parent fk, STI type, and undeclared grandchild keys', async () => {
    const out = await sanitizeNestedWrites({
      amount: 5,
      notesAttributes: [{
        id: 7, _destroy: true, _key: 'new:1', body: 'hi',
        loanId: 999,                    // re-parent attempt — forced server-side
        type: 'EvilSubclass',           // STI discriminator forgery
        createdAt: 'x', updatedAt: 'y', // server-owned
        bogusAttributes: [{ a: 1 }],    // undeclared nesting → would 500 as unknown column
      }],
    }, nestedModel())
    expect(out['notesAttributes']).toEqual([{ id: 7, _destroy: true, _key: 'new:1', body: 'hi' }])
    expect(out['amount']).toBe(5)       // flat fields untouched
  })

  it('drops non-object rows and mistyped protocol fields', async () => {
    const out = await sanitizeNestedWrites({
      notesAttributes: [
        'a string', null, 42,
        { id: { evil: true }, _destroy: 'yes', _key: 9, body: 'ok' },
      ],
    }, nestedModel())
    expect(out['notesAttributes']).toEqual([{ body: 'ok' }])
  })
})

// ── Index respects the read ceiling ──────────────────────────────────────────

describe('index expose', () => {
  it('the list endpoint cannot leak columns the GET envelope hides', async () => {
    const record = makeRecord({ id: 1, amount: 5, status: 'DRAFT', secret: 'classified' })
    const rel: any = {
      count: async () => 1,
      limit: () => rel, offset: () => rel, order: () => rel,
      where: () => rel, includes: () => rel,
      load: async () => [record],
    }
    const res = await defaultIndex(rel, makeModel(), envelopeConfig as any, {})
    expect(res.data[0].secret).toBeUndefined()
    expect(res.data[0].amount).toBe(5)
    expect(res.data[0].id).toBe(1)
  })
})

// ── buildRecordEnvelope directly ─────────────────────────────────────────────

describe('buildRecordEnvelope', () => {
  it('the mask only narrows the ceiling — permit fields outside expose gain nothing', () => {
    const record = makeRecord({ id: 1, amount: 1, status: 'DRAFT', secret: 'x' })
    const config: any = {
      get: { expose: ['id', 'amount'], abilities: true },
      update: { permit: ['amount', 'secret'] },   // secret permitted but NOT exposed
    }
    const env = buildRecordEnvelope(record, makeModel(), config, ctx, ctrl)
    expect(env.abilities.secret).toBeUndefined()  // not exposed ⇒ absent, period
    expect(env.record.secret).toBeUndefined()
  })

  it('acceptsNested assocs get a `<name>Attributes` verdict from the same permit', () => {
    const model = makeModel()
    ;(model as any).notes = { _type: 'hasMany', options: { acceptsNested: true } }
    ;(model as any).activities = { _type: 'hasMany', options: {} }   // NOT acceptsNested
    const record = makeRecord({ id: 1, amount: 1, status: 'DRAFT' })

    const allowed: any = {
      get: { expose: ['id', 'amount'], abilities: true },
      update: { permit: ['amount', 'notesAttributes'] },
    }
    expect(buildRecordEnvelope(record, model, allowed, ctx, ctrl).abilities['notesAttributes']).toBe('edit')

    const denied: any = {
      get: { expose: ['id', 'amount'], abilities: true },
      update: { permit: ['amount'] },
    }
    const env = buildRecordEnvelope(record, model, denied, ctx, ctrl)
    expect(env.abilities['notesAttributes']).toBe('view')             // governed, locked
    expect(env.abilities['activitiesAttributes']).toBeUndefined()     // plain hasMany: ungoverned
  })
})

// ── PATCH envelope carries the GET includes ──────────────────────────────────

describe('save-response includes', () => {
  it('the PATCH envelope reloads with get.include — nested rows echo back WITH ids', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(1000) })
    const withNotes = makeRecord({
      id: 1, amount: 250, status: 'DRAFT',
      notes: [{ id: 51, body: 'saved child' }], updatedAt: new Date(1000),
    })
    const rel: any = {
      where: vi.fn()
        .mockReturnValueOnce({ first: vi.fn().mockResolvedValue(record), includes: vi.fn().mockReturnThis() })
        .mockReturnValue({ includes: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(withNotes) }),
    }
    const config: any = {
      get: { expose: ['id', 'amount', 'status', 'internalNote'], abilities: true, include: ['notes'] },
      update: envelopeConfig.update,
    }
    const res = await defaultUpdate(rel, makeModel(), config, 1, { amount: 250 }, ctx, ctrl)
    // Without the reload the client can never settle new rows → duplicates
    expect(res.record.notes).toEqual([{ id: 51, body: 'saved child' }])
  })
})

// ── Create: forbidden issues (same contract as update) ───────────────────────

describe('create with envelope', () => {
  it('reports stripped non-permitted fields as forbidden issues', async () => {
    const model = makeModel()
    ;(model as any).create = vi.fn(async (data: any) => makeRecord({ id: 9, status: 'DRAFT', ...data }))
    const config: any = {
      get: { expose: ['id', 'amount', 'status'], abilities: true },
      create: { permit: ['amount'] },
    }
    const { defaultCreate } = await import('../src/crud-handlers.js')
    const res = await defaultCreate(
      {} as any, model, config,
      { amount: 5, notesAttributes: [{ body: 'dropped' }] },
      ctx, {}, ctrl,
    )
    expect(res.record.id).toBe(9)
    expect(res.issues).toEqual([{ field: 'notesAttributes', code: 'forbidden' }])
  })
})
