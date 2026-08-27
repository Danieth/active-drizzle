/**
 * The optimistic-lock CAS seam between controller and core.
 *
 * Core contract (cross-cluster, enforced by core's own suite):
 *   - save() compare-and-swaps the lock column — auto-bump + WHERE version
 *     guard — ONLY when the lock column is NOT already in the save payload;
 *   - save() throws StaleObjectError (e.name === 'StaleObjectError') when
 *     the CAS matches zero rows.
 *
 * Two regressions covered here:
 *   1. defaultUpdate must NOT pre-bump a numeric lock column: writing it
 *      onto the record puts it in the payload, which DISARMS core's CAS —
 *      the load→save race window silently last-write-wins for exactly the
 *      configs that asked for locking.
 *   2. StaleObjectError must surface as the 409 Conflict the react
 *      conflict machinery (enterConflict/resolveConflict) handles — with
 *      the fresh envelope on envelope doors — never as a raw 500.
 */
import { describe, it, expect, vi } from 'vitest'
import { call } from '@orpc/server'
import { defaultUpdate } from '../src/crud-handlers.js'
import { Conflict } from '../src/errors.js'
import { buildRouter } from '../src/router.js'
import { ActiveController } from '../src/base.js'
import { controller, crud } from '../src/decorators.js'

function staleObjectError(): Error {
  const e = new Error('Attempted to update a stale object: Deal')
  e.name = 'StaleObjectError'
  return e
}

function Deal() {}

// ── 1. No controller-side pre-bump (it would disarm core's CAS) ──────────────

describe('defaultUpdate leaves numeric lock columns to core CAS', () => {
  it('never writes the lock column onto the record (a write puts it in the save payload and disarms the CAS guard)', async () => {
    const writes: string[] = []
    const target: any = {
      id: 1, name: 'before', lockVersion: 3,
      save: vi.fn(async () => true), errors: {},
    }
    // Mirrors the real record proxy: every property set lands in _changes,
    // i.e. in the save payload — so "was it written?" IS "is it in the payload?"
    const record: any = new Proxy(target, {
      set(t, k, v) { writes.push(String(k)); (t as any)[k] = v; return true },
    })
    const relation: any = { where: () => ({ first: async () => record }) }
    const config: any = { update: { permit: ['name'], optimisticLock: 'lockVersion' } }

    await defaultUpdate(relation, Deal as any, config, 1, { name: 'after', _version: '3' }, {}, { state: {} })

    expect(record.name).toBe('after')
    expect(record.save).toHaveBeenCalled()
    expect(writes).not.toContain('lockVersion')
    expect(record.lockVersion).toBe(3)
  })
})

// ── 2. StaleObjectError → 409 Conflict ───────────────────────────────────────

describe('StaleObjectError from save() → 409 Conflict', () => {
  it('envelope door: the Conflict carries the RE-FETCHED server truth, not the rejected client values', async () => {
    const record: any = {
      id: 1, name: 'loaded', lockVersion: 3,
      save: vi.fn(async () => { throw staleObjectError() }), errors: {},
    }
    const fresh: any = { id: 1, name: 'server-won', lockVersion: 4 }
    let loads = 0
    const relation: any = { where: () => ({ first: async () => (loads++ === 0 ? record : fresh) }) }
    const config: any = {
      get: { expose: ['name'], abilities: true },
      update: { permit: ['name'], optimisticLock: true },
    }

    let thrown: any
    try {
      // _version matches the loaded record — the friendly pre-check passes;
      // the CAS then loses the load→save race inside save()
      await defaultUpdate(relation, Deal as any, config, 1,
        { name: 'client-value', _version: '3' }, {}, { state: {} })
    } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(Conflict)
    expect(thrown.envelope?.record?.name).toBe('server-won')
    expect(thrown.envelope?.version).toBe('4')
  })

  it('non-envelope door: a plain Conflict (no envelope), never the raw error', async () => {
    const record: any = {
      id: 1, name: 'loaded',
      save: vi.fn(async () => { throw staleObjectError() }), errors: {},
    }
    const relation: any = { where: () => ({ first: async () => record }) }
    const config: any = { update: { permit: ['name'] } }

    let thrown: any
    try {
      await defaultUpdate(relation, Deal as any, config, 1, { name: 'x' }, {}, { state: {} })
    } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(Conflict)
    expect(thrown.envelope).toBeUndefined()
  })

  it('dispatch maps a StaleObjectError escaping ANY action to CONFLICT (never a raw 500)', async () => {
    const Model: any = class { static all() { return {} } }

    @controller('/deals')
    @crud(Model, { update: { permit: ['name'] } })
    class DealController extends ActiveController {
      // A custom action that held its record across an await and lost the
      // race inside record.save() — the error escapes to dispatch raw
      async update() { throw staleObjectError() }
    }

    const { router } = buildRouter(DealController as any)
    await expect(call(router.update, { id: 1, data: { name: 'x' } } as any, { context: {} }))
      .rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
  })
})
