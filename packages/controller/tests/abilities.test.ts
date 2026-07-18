/**
 * Forms envelope — expose / abilities / can / version / _event.
 *
 * The M1 acceptance contract:
 *   - DRAFT record → abilities.amount === 'edit'; SUBMITTED → 'view'
 *   - field ∉ expose absent from both record and abilities
 *   - PATCH of a non-permitted field → stripped + { field, code: 'forbidden' }
 *   - stale version → 409 Conflict
 *   - _event fires the transition in the same save; blocked → 422
 *   - PATCH response = GET envelope (post-transition re-masking)
 */

import { describe, it, expect, vi } from 'vitest'
import { defaultGet, defaultUpdate, buildRecordEnvelope, versionOf } from '../src/crud-handlers.js'
import { Conflict, ValidationError } from '../src/errors.js'

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

  it('version derives from updatedAt', async () => {
    const record = makeRecord({ id: 1, status: 'DRAFT', updatedAt: new Date(123456) })
    const res = await defaultGet(relationFor(record), makeModel(), envelopeConfig, 1, ctx, ctrl)
    expect(res.version).toBe('123456')
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

// ── Optimistic locking ───────────────────────────────────────────────────────

describe('version conflict', () => {
  it('stale version → 409 Conflict, nothing saved', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(2000) })
    await expect(
      defaultUpdate(relationFor(record), makeModel(), envelopeConfig, 1,
        { amount: 250 }, ctx, ctrl, '1000'),
    ).rejects.toBeInstanceOf(Conflict)
    expect(record.save).not.toHaveBeenCalled()
  })

  it('matching version proceeds', async () => {
    const record = makeRecord({ id: 1, amount: 100, status: 'DRAFT', updatedAt: new Date(2000) })
    const res = await defaultUpdate(relationFor(record), makeModel(), envelopeConfig, 1,
      { amount: 250 }, ctx, ctrl, '2000')
    expect(res.record.amount).toBe(250)
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
})

// ── versionOf helper ─────────────────────────────────────────────────────────

describe('versionOf', () => {
  it('null when the record has no updatedAt', () => {
    expect(versionOf(makeRecord({ id: 1 }))).toBeNull()
  })

  it('stringified epoch millis when it does', () => {
    expect(versionOf(makeRecord({ id: 1, updatedAt: new Date(42) }))).toBe('42')
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
})
