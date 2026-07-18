/**
 * Attr.state — state machine tests.
 *
 * Covers:
 *   - Definition-time validation (unknown states, bad initial, reserved events)
 *   - Enum-like label read/write (int hash + string array forms)
 *   - is<Label>() predicates
 *   - can(event) / can<Event>() — from-set checks and guards
 *   - Synthesized event methods (assign-only, no save)
 *   - advance(event) — fire + persist in one call
 *   - Save-time transition legality for direct assignment
 *   - `from: '*'` wildcards, initial-as-default on INSERT
 *   - Composition with lifecycle hooks (statusChanged condition)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model, beforeUpdate } from '../../src/runtime/decorators.js'
import { Attr } from '../../src/runtime/attr.js'

// ── Mock database ────────────────────────────────────────────────────────────

function makeMockDb(returnRow: Record<string, any> = { id: 1 }) {
  const insertValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([returnRow]) }))
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([returnRow]) })),
  }))
  return {
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    _insertValues: insertValues,
    _updateSet: updateSet,
  }
}

let db: ReturnType<typeof makeMockDb>

beforeAll(() => {
  db = makeMockDb({ id: 1, status: 1 })
  const schema = {
    loans: {
      id: { name: 'id' },
      status: { name: 'status' },
      amount: { name: 'amount' },
      stage: { name: 'stage' },
    },
  }
  boot(db as any, schema)
})

// ── Model under test ─────────────────────────────────────────────────────────

const loanStates = { draft: 0, submitted: 1, approved: 2, rejected: 3 } as const

function defineLoan() {
  @model('loans')
  class Loan extends ApplicationRecord {
    static status = Attr.state({
      states: loanStates,
      initial: 'draft',
      transitions: {
        submit:  { from: ['draft'], to: 'submitted' },
        approve: { from: ['submitted'], to: 'approved', if: (r: any) => r.amount != null, message: 'needs an amount' },
        reject:  { from: ['submitted'], to: 'rejected' },
        reopen:  { from: '*', to: 'draft' },
      },
    })
  }
  return Loan
}

// ── Definition-time validation ───────────────────────────────────────────────

describe('Attr.state definition validation', () => {
  it('throws on a transition targeting an unknown state', () => {
    expect(() =>
      Attr.state({
        states: ['a', 'b'],
        transitions: { go: { from: ['a'], to: 'zzz' as any } },
      })
    ).toThrow(/unknown state 'zzz'/)
  })

  it('throws on an unknown state in from', () => {
    expect(() =>
      Attr.state({
        states: ['a', 'b'],
        transitions: { go: { from: ['nope' as any], to: 'b' } },
      })
    ).toThrow(/unknown state 'nope'/)
  })

  it('throws when initial is not a declared state', () => {
    expect(() =>
      Attr.state({
        states: ['a'],
        initial: 'x' as any,
        transitions: {},
      })
    ).toThrow(/initial 'x'/)
  })

  it('throws when an event name collides with a built-in member', () => {
    expect(() =>
      Attr.state({
        states: ['a', 'b'],
        transitions: { save: { from: ['a'], to: 'b' } },
      })
    ).toThrow(/collides with a built-in/)
  })

  it('throws on empty states', () => {
    expect(() => Attr.state({ states: [], transitions: {} })).toThrow(/at least one state/)
  })
})

// ── Enum-like behavior ───────────────────────────────────────────────────────

describe('Attr.state reads/writes like Attr.enum', () => {
  it('reads the label for the stored int and writes labels back as ints', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    expect(loan.status).toBe('draft')

    loan.status = 'submitted'
    expect(loan.status).toBe('submitted')
    expect(loan._changes.get('status')!.is).toBe(1) // raw stored value
  })

  it('supports string-array states (text columns) with identity storage', () => {
    @model('loans')
    class Ticket extends ApplicationRecord {
      static stage = Attr.state({
        states: ['open', 'closed'],
        initial: 'open',
        transitions: { close: { from: ['open'], to: 'closed' } },
      })
    }
    const t = new (Ticket as any)({ id: 1, stage: 'open' }, false)
    expect(t.stage).toBe('open')
    t.close()
    expect(t.stage).toBe('closed')
    expect(t._changes.get('stage')!.is).toBe('closed')
  })

  it('synthesizes is<Label>() predicates', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1 }, false)
    expect(loan.isSubmitted()).toBe(true)
    expect(loan.isDraft()).toBe(false)
  })
})

// ── can() / can<Event>() ─────────────────────────────────────────────────────

describe('can(event)', () => {
  it('is true when current state is in from and guard passes', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    expect(loan.can('submit')).toBe(true)
    expect(loan.canSubmit()).toBe(true)
  })

  it('is false from the wrong state', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 2 }, false) // approved
    expect(loan.can('submit')).toBe(false)
    expect(loan.canSubmit()).toBe(false)
  })

  it('guard blocks the event', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1, amount: null }, false)
    expect(loan.canApprove()).toBe(false)
    loan.amount = 50_000
    expect(loan.canApprove()).toBe(true)
  })

  it('wildcard from allows the event from every state', () => {
    const Loan = defineLoan()
    for (const raw of [0, 1, 2, 3]) {
      const loan = new (Loan as any)({ id: 1, status: raw }, false)
      expect(loan.can('reopen')).toBe(true)
    }
  })

  it('is false for unknown events', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    expect(loan.can('launch')).toBe(false)
  })
})

// ── Event methods (assign-only) ──────────────────────────────────────────────

describe('synthesized event methods', () => {
  it('assigns the target state and returns true when legal', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    expect(loan.submit()).toBe(true)
    expect(loan.status).toBe('submitted')
    expect(loan.isChanged()).toBe(true) // assign-only: nothing persisted
  })

  it('returns false and does NOT assign when illegal', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 2 }, false) // approved
    expect(loan.submit()).toBe(false)
    expect(loan.status).toBe('approved')
    expect(loan.isChanged()).toBe(false)
  })

  it('guard failure blocks the event method', () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1, amount: null }, false)
    expect(loan.approve()).toBe(false)
    expect(loan.status).toBe('submitted')
  })
})

// ── advance() — fire + persist ───────────────────────────────────────────────

describe('advance(event)', () => {
  it('assigns and saves when legal', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    const ok = await loan.advance('submit')
    expect(ok).toBe(true)
    expect(db.update).toHaveBeenCalled()
    expect(loan.isChanged()).toBe(false) // committed
  })

  it('returns false with errors and no DB call when illegal', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 2 }, false) // approved
    db.update.mockClear()
    const ok = await loan.advance('submit')
    expect(ok).toBe(false)
    expect(db.update).not.toHaveBeenCalled()
    expect(loan.errors.all().status).toBeDefined()
  })

  it('reports the transition message on guard failure', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1, amount: null }, false)
    const ok = await loan.advance('approve')
    expect(ok).toBe(false)
    expect(loan.errors.all().status).toContain('needs an amount')
  })

  it('unknown event → false with a base error', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    const ok = await loan.advance('launch')
    expect(ok).toBe(false)
    expect(loan.errors.all().base).toBeDefined()
  })
})

// ── Save-time legality for direct assignment ─────────────────────────────────

describe('validate() enforces transition legality on direct assignment', () => {
  it('allows a legal direct assignment', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0 }, false)
    loan.status = 'submitted'
    expect(await loan.validate()).toBe(true)
  })

  it('rejects an illegal jump (draft → approved skips submit)', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 0, amount: 100 }, false)
    loan.status = 'approved'
    expect(await loan.validate()).toBe(false)
    expect(loan.errors.all().status).toBeDefined()
  })

  it('rejects a legal-shaped move whose guard fails (submitted → approved without amount)', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1, amount: null }, false)
    loan.status = 'approved'
    expect(await loan.validate()).toBe(false)
    expect(loan.errors.all().status).toContain('needs an amount')
  })

  it('new records skip transition validation (create in any state)', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({}, true)
    loan.status = 'approved'
    expect(await loan.validate()).toBe(true)
  })

  it('records with a null previous state may enter the machine anywhere', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: null }, false)
    loan.status = 'approved'
    expect(await loan.validate()).toBe(true)
  })

  it('no-op reassignment to the same state passes', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ id: 1, status: 1 }, false)
    loan.status = 'submitted'
    expect(await loan.validate()).toBe(true)
  })
})

// ── initial as INSERT default ────────────────────────────────────────────────

describe('initial state', () => {
  it('applies initial as the column default on INSERT (stored raw value)', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ amount: 10 }, true)
    await loan.save()
    const payload = db._insertValues.mock.calls.at(-1)![0] as Record<string, any>
    expect(payload.status).toBe(0) // 'draft' stored as 0
  })

  it('does not override an explicitly set state on INSERT', async () => {
    const Loan = defineLoan()
    const loan = new (Loan as any)({ amount: 10 }, true)
    loan.status = 'submitted'
    await loan.save()
    const payload = db._insertValues.mock.calls.at(-1)![0] as Record<string, any>
    expect(payload.status).toBe(1)
  })
})

// ── Composition with lifecycle hooks ─────────────────────────────────────────

describe('hooks composition', () => {
  it("fires @beforeUpdate({ if: 'statusChanged' }) only when the machine moved", async () => {
    const fired = vi.fn()

    @model('loans')
    class Loan extends ApplicationRecord {
      static status = Attr.state({
        states: loanStates,
        initial: 'draft',
        transitions: { submit: { from: ['draft'], to: 'submitted' } },
      })

      @beforeUpdate({ if: 'statusChanged' })
      onTransition() { fired() }
    }

    const loan = new (Loan as any)({ id: 1, status: 0, amount: 5 }, false)
    loan.amount = 6
    await loan.save()
    expect(fired).not.toHaveBeenCalled()

    const loan2 = new (Loan as any)({ id: 1, status: 0 }, false)
    await loan2.advance('submit')
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
