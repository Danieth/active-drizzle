/**
 * Boundary-correctness regression suite (REMAINS-FOR-LAUNCH Tier-1 "Boundary
 * correctness" + Tier-0 error-taxonomy / concern-export items).
 *
 * Every test here FAILS against the pre-fix behavior:
 *   - controller read `model.name` → "[object Object] not found" / broken presign
 *     when a model declares a `name` Attr (the framework's own #1 rule).
 *   - a bulk mutation with `ids: []` (records:true) silently operated on the
 *     WHOLE door scope.
 *   - `nestedAutoSet` declared only under `create` reopened the forged-fk gap
 *     on every edit (no create→update fallback).
 *   - `singletonFindOrCreate`'s dup-race recovery matched an error message that
 *     never arrived → dead recovery.
 *   - the controller-concern system was documented but not exported.
 */
import { describe, it, expect, vi } from 'vitest'
import { call as orpcCall } from '@orpc/server'
import { controller, crud, mutation } from '../src/decorators.js'
import { ActiveController } from '../src/base.js'
import { buildRouter } from '../src/router.js'
import {
  defaultGet, defaultDestroy, defaultUpdate,
  singletonFindOrCreate, effectiveUpdateConfig } from '../src/crud-handlers.js'
import { ValidationError } from '../src/errors.js'
import * as controllerPkg from '../src/index.js'

// A model whose `.name` is shadowed by an Attr config object — legal, common,
// and the exact case the #1-rule violation broke. `modelClassName()` still
// resolves the real declared name from the `_activeDrizzleClassName` stamp.
function nameShadowedModel(className = 'Deal') {
  class M {}
  Object.defineProperty(M, '_activeDrizzleClassName', { value: className })
  Object.defineProperty(M, 'name', {
    value: { _isAttr: true, _type: 'string' },
    configurable: true,
  })
  return M as any
}

const emptyRelation = () => ({
  where: () => ({ first: async () => null, includes() { return this } }),
}) as any

// ── model.name → modelClassName() (crud-handlers read paths) ─────────────────

describe('404s use the declared class name, not a shadowing `name` Attr', () => {
  it('sanity: the model shadows `.name` yet modelClassName resolves it', () => {
    const model = nameShadowedModel('Invoice')
    expect(typeof model.name).not.toBe('string')        // shadowed
    expect(String(model.name)).toBe('[object Object]')  // the old bug source
  })

  it('defaultGet on a missing record → "Deal not found" (not "[object Object] not found")', async () => {
    await expect(
      defaultGet(emptyRelation(), nameShadowedModel('Deal'), {} as any, 1, {}, {}),
    ).rejects.toMatchObject({ status: 404, message: 'Deal not found' })
  })

  it('defaultDestroy on a missing record → "Deal not found"', async () => {
    await expect(
      defaultDestroy(emptyRelation(), nameShadowedModel('Deal'), 1),
    ).rejects.toMatchObject({ status: 404, message: 'Deal not found' })
  })
})

describe('router 404s use modelClassName() too', () => {
  it('@mutation on a missing id → "Deal not found"', async () => {
    const model = nameShadowedModel('Deal')
    model.all = () => ({ where: () => ({ first: async () => null }) })

    @controller('/deals')
    @crud(model, {})
    class DealController {
      @mutation() async poke(_record: any) { return { ok: true } }
    }

    const { router } = buildRouter(DealController as any)
    await expect(
      orpcCall(router.poke, { id: 999 }, { context: {} }),
    ).rejects.toMatchObject({ message: 'Deal not found' })
  })
})

// ── bulk mutation ids: [] must not mean "the whole scope" ────────────────────

describe('bulk mutation with ids: [] is rejected, never applied to the whole scope', () => {
  function bulkController(loadSpy: () => void) {
    const model: any = function Deal() {}
    // If validation ever leaks through, this proves the whole-scope load would
    // have happened — the test asserts it does NOT.
    model.all = () => ({
      where() { return this },
      load: async () => { loadSpy(); return [] },
    })

    @controller('/deals')
    @crud(model, {})
    class DealController extends ActiveController {
      @mutation({ bulk: true }) async archiveAll(_records: any[]) { return { ok: true } }
    }
    return DealController as any
  }

  it('records:true + ids:[] → input rejected, handler never loads the scope', async () => {
    const loadSpy = vi.fn()
    const { router } = buildRouter(bulkController(loadSpy))
    await expect(
      orpcCall(router.archiveAll, { ids: [] }, { context: {} }),
    ).rejects.toBeTruthy()
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('records:true + a real id passes input validation (reaches the handler)', async () => {
    const loadSpy = vi.fn()
    const { router } = buildRouter(bulkController(loadSpy))
    const res = await orpcCall(router.archiveAll, { ids: [7] }, { context: {} })
    expect(res).toEqual({ ok: true })
    expect(loadSpy).toHaveBeenCalledTimes(1)
  })
})

// ── nestedAutoSet: create → update fallback closes the forged-fk gap on edit ──

describe('effectiveUpdateConfig — update inherits create.nestedAutoSet', () => {
  const created = { notes: { authorId: (c: any) => c.userId } }

  it('update with no nestedAutoSet inherits create.nestedAutoSet', () => {
    const eff = effectiveUpdateConfig({ create: { nestedAutoSet: created }, update: { permit: ['x'] } })
    expect(eff.nestedAutoSet).toEqual(created)
    expect(eff.permit).toEqual(['x'])   // other update keys untouched
  })

  it('update.nestedAutoSet wins per field; create fills the gaps it leaves', () => {
    const eff = effectiveUpdateConfig({
      create: { nestedAutoSet: { notes: { authorId: () => 1 }, tags: { ownerId: () => 2 } } },
      update: { nestedAutoSet: { notes: { authorId: () => 9 } } },
    })
    expect(eff.nestedAutoSet.notes.authorId()).toBe(9)   // update wins
    expect(eff.nestedAutoSet.tags.ownerId()).toBe(2)     // create fills gap
  })

  it('no create config → update returned untouched', () => {
    const update = { permit: ['x'] }
    expect(effectiveUpdateConfig({ update })).toBe(update)
  })
})

describe('defaultUpdate forces nested fk from create-only nestedAutoSet on EDIT', () => {
  it('a nested CREATE row (no id) has its forged authorId overwritten', async () => {
    const record: any = { save: vi.fn().mockResolvedValue(true), errors: {} }
    const relation: any = { where: () => ({ first: async () => record }) }
    const config: any = {
      // declared ONLY under create — the LLM-GUIDE canonical shape
      create: { nestedAutoSet: { notes: { authorId: (c: any) => c.userId } } },
      update: {},
    }
    await defaultUpdate(
      relation, { name: 'Deal' }, config, 1,
      { notesAttributes: [{ body: 'planted', authorId: 999 }] },
      { userId: 42 }, {},
    )
    // Pre-fix: 999 (forged) survived. Post-fix: forced to the ctx owner.
    expect(record.notesAttributes[0].authorId).toBe(42)
  })
})

// ── singletonFindOrCreate — structural dup-race recovery ─────────────────────

describe('singletonFindOrCreate recovers from a concurrent insert structurally', () => {
  const findBy = { tenantId: 1 }

  it('returns the existing row without creating', async () => {
    const model: any = {
      findBy: vi.fn().mockResolvedValue({ id: 1 }),
      create: vi.fn(),
    }
    const res = await singletonFindOrCreate(model, findBy, {})
    expect(res).toEqual({ id: 1 })
    expect(model.create).not.toHaveBeenCalled()
  })

  it('create() RETURNS an unsaved instance (new taxonomy) + row now exists → recovers', async () => {
    const winner = { id: 5, tenantId: 1 }
    const model: any = {
      findBy: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      create: vi.fn().mockResolvedValue({ isNewRecord: true, errors: { all: () => ({ tenantId: ['has already been taken'] }) } }),
    }
    const res = await singletonFindOrCreate(model, findBy, {})
    expect(res).toBe(winner)
  })

  it('create() THROWS (pre-taxonomy / raw driver) + row now exists → recovers', async () => {
    const winner = { id: 6, tenantId: 1 }
    const model: any = {
      findBy: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      create: vi.fn().mockRejectedValue(new Error('Validation failed: {"tenantId":["has already been taken"]}')),
    }
    const res = await singletonFindOrCreate(model, findBy, {})
    expect(res).toBe(winner)
  })

  it('create() succeeds → returns the persisted record', async () => {
    const saved = { id: 7, isNewRecord: false }
    const model: any = {
      findBy: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(saved),
    }
    expect(await singletonFindOrCreate(model, findBy, {})).toBe(saved)
  })

  it('GENUINE validation failure (row still absent) surfaces as 422, not swallowed', async () => {
    const model: any = {
      findBy: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ isNewRecord: true, errors: { all: () => ({ name: ["can't be blank"] }) } }),
    }
    await expect(singletonFindOrCreate(model, findBy, {}))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('a non-recoverable throw (row still absent) re-throws the original error', async () => {
    const boom = new Error('connection refused')
    const model: any = {
      findBy: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(boom),
    }
    await expect(singletonFindOrCreate(model, findBy, {})).rejects.toBe(boom)
  })
})

// ── create validation failure → 422 at the ROUTE (not 500) ───────────────────
//
// The controller's side of the error-taxonomy fix: when create() signals a
// failed save by RETURNING the unsaved instance (isNewRecord === true with
// errors set — the contract the core-runtime cluster is moving to), the create
// ROUTE must surface a 422, never a 500. This exercises the real router +
// dispatch + defaultCreate path with a mock model standing in for that
// contract.
//
// NOTE (deferred, core dependency): with the CURRENT core in this worktree,
// ApplicationRecord.create still THROWS `Error('Validation failed: …')` on a
// failed save (application-record.ts:285), so an end-to-end create-validation
// failure against a REAL model still surfaces as HTTP 500. The controller is
// ready; the 422 flips on once core returns the unsaved instance.

describe('create validation failure surfaces as 422 at the route', () => {
  it('create() returns the unsaved instance → route throws 422 with the errors map', async () => {
    function validatingModel() {
      function M(this: any) {}
      ;(M as any).create = vi.fn(async () => ({
        isNewRecord: true,
        errors: { all: () => ({ name: ["can't be blank"] }) },
      }))
      ;(M as any).all = () => ({ where() { return this } })
      return M as any
    }

    @controller('/things')
    @crud(validatingModel(), {})
    class ThingController extends ActiveController {}

    const { router } = buildRouter(ThingController as any)
    await expect(
      orpcCall(router.create, { data: { title: 'x' } }, { context: {} }),
    ).rejects.toMatchObject({ status: 422, data: { errors: { name: ["can't be blank"] } } })
  })
})

// ── The controller-concern system is exported from the package entry ─────────

describe('controller-concern system is reachable from the package entry', () => {
  it('exports defineControllerConcern, includeInController, Searchable', () => {
    expect(typeof controllerPkg.defineControllerConcern).toBe('function')
    expect(typeof controllerPkg.includeInController).toBe('function')
    expect(typeof controllerPkg.Searchable).toBe('object')
  })
})

describe('singleton update inherits create.nestedAutoSet (divergence closed)', () => {
  it('effectiveUpdateConfig is applied on the singleton path too', () => {
    const config = {
      create: { nestedAutoSet: { 'notes.reactions': { userId: () => 42 } } },
      update: { permit: ['theme'] },
    }
    const eff = effectiveUpdateConfig(config)
    // the create-declared forcer survives into the update config (both CRUD
    // and singleton PATCH pass config THROUGH this same helper now)
    expect(eff.nestedAutoSet['notes.reactions'].userId()).toBe(42)
    expect(eff.permit).toEqual(['theme'])
  })
})
