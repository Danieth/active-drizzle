import { describe, it, expect, vi } from 'vitest'
import { defaultUpdate } from '../src/crud-handlers.js'

describe('defaultUpdate permit context', () => {
  it('passes request context to dynamic update permit function', async () => {
    const record: any = {
      name: 'before',
      secret: 'before-secret',
      save: vi.fn().mockResolvedValue(true),
      errors: {},
    }
    const relation = {
      where: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(record),
      }),
    } as any

    const permitFn = vi.fn((ctx: any) => (ctx.user.role === 'admin' ? ['name', 'secret'] : ['name']))
    const config: any = {
      update: { permit: permitFn },
    }
    const ctx = { user: { role: 'member' } }
    const ctrl = { state: {} }

    await defaultUpdate(relation, { name: 'Campaign' }, config, 1, { name: 'after', secret: 'dont-allow' }, ctx, ctrl)

    // permit now receives (ctx, ctrl, record) — record-state-aware permits
    expect(permitFn).toHaveBeenCalledWith(ctx, ctrl, record)
    expect(record.name).toBe('after')
    expect(record.secret).toBe('before-secret')
  })
})

import { applyNestedAutoSet } from '../src/crud-handlers.js'

describe('applyNestedAutoSet', () => {
  const ctx = { userId: 42 }

  it('forces the field on nested CREATE rows (client value never trusted)', () => {
    const out = applyNestedAutoSet(
      { notesAttributes: [{ body: 'hi', reactionsAttributes: [{ kind: 'like', userId: 999 }] }] },
      { nestedAutoSet: { 'notes.reactions': { userId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['notesAttributes'][0].reactionsAttributes[0].userId).toBe(42)
  })

  it('strips the field on nested UPDATE rows (immutable through nesting)', () => {
    const out = applyNestedAutoSet(
      { notesAttributes: [{ id: 1, reactionsAttributes: [{ id: 7, kind: 'like', userId: 999 }] }] },
      { nestedAutoSet: { 'notes.reactions': { userId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['notesAttributes'][0].reactionsAttributes[0]).not.toHaveProperty('userId')
    expect(out['notesAttributes'][0].reactionsAttributes[0].kind).toBe('like')
  })

  it('single-segment paths target the top-level nested rows', () => {
    const out = applyNestedAutoSet(
      { notesAttributes: [{ body: 'new one' }, { id: 3, body: 'old', authorId: 5 }] },
      { nestedAutoSet: { notes: { authorId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['notesAttributes'][0].authorId).toBe(42)
    expect(out['notesAttributes'][1]).not.toHaveProperty('authorId')
  })

  it('is a no-op without config or without matching rows', () => {
    const data = { name: 'x', notesAttributes: [{ body: 'y' }] }
    expect(applyNestedAutoSet(data, undefined, ctx)).toBe(data)
    expect(applyNestedAutoSet(data, { nestedAutoSet: { activities: { x: () => 1 } } }, ctx)['notesAttributes'][0]).not.toHaveProperty('x')
  })
})

describe('applyNestedAutoSet — singular (hasOne) payloads', () => {
  const ctx = { userId: 42 }

  it('forces the field on a singular CREATE object', () => {
    const out = applyNestedAutoSet(
      { profileAttributes: { bio: 'hi', userId: 999 } },
      { nestedAutoSet: { profile: { userId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['profileAttributes'].userId).toBe(42)
  })

  it('strips the field on a singular UPDATE object', () => {
    const out = applyNestedAutoSet(
      { profileAttributes: { id: 7, bio: 'hi', userId: 999 } },
      { nestedAutoSet: { profile: { userId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['profileAttributes']).not.toHaveProperty('userId')
    expect(out['profileAttributes'].bio).toBe('hi')
  })

  it('walks THROUGH a singular node into an array grandchild', () => {
    const out = applyNestedAutoSet(
      { profileAttributes: { linksAttributes: [{ url: 'x', userId: 999 }] } },
      { nestedAutoSet: { 'profile.links': { userId: (c: any) => c.userId } } },
      ctx,
    )
    expect(out['profileAttributes'].linksAttributes[0].userId).toBe(42)
  })
})

import { sanitizeNestedWrites, buildRecordEnvelope } from '../src/crud-handlers.js'

/** Duck-typed model — real markers, no decorators (registry not needed). */
class DuckOwner {
  static tableName = 'duck_owners'
  static profile = { _type: 'hasOne', options: { acceptsNested: { allowDestroy: true } } }
  static notes = { _type: 'hasMany', options: { acceptsNested: true } }
}

describe('sanitizeNestedWrites — singular (hasOne) payloads', () => {
  it('sanitizes the singular object: protocol keys pass, server-owned + fk strip', async () => {
    const out = await sanitizeNestedWrites(
      {
        profileAttributes: {
          id: 5, _destroy: true, bio: 'x',
          duck_ownerId: 999,          // parent fk — forged re-parenting attempt
          createdAt: 'z', type: 'Evil',
        },
      },
      DuckOwner,
    )
    expect(out['profileAttributes']).toEqual({ id: 5, _destroy: true, bio: 'x' })
  })

  it('drops an ARRAY sent for a declared hasOne (shape violation, fail closed)', async () => {
    const out = await sanitizeNestedWrites({ profileAttributes: [{ bio: 'x' }] }, DuckOwner)
    expect(out).not.toHaveProperty('profileAttributes')
  })

  it('drops a single OBJECT sent for a declared hasMany (shape violation, fail closed)', async () => {
    const out = await sanitizeNestedWrites({ notesAttributes: { body: 'x' } }, DuckOwner)
    expect(out).not.toHaveProperty('notesAttributes')
  })

  it('hasMany arrays still sanitize as before', async () => {
    const out = await sanitizeNestedWrites(
      { notesAttributes: [{ body: 'x', duck_ownerId: 7, updatedAt: 'y' }] },
      DuckOwner,
    )
    expect(out['notesAttributes']).toEqual([{ body: 'x' }])
  })
})

describe('buildRecordEnvelope — nested abilities keys', () => {
  const record = { id: 1, bio: 'x' }

  it('hasOne <assoc>Attributes gets an edit/view verdict from the permit', () => {
    const config: any = {
      get: { expose: ['bio'], abilities: true },
      update: { permit: ['bio', 'profileAttributes'] },
    }
    const env = buildRecordEnvelope(record, DuckOwner, config, {}, {})
    expect(env.abilities['profileAttributes']).toBe('edit')
    expect(env.abilities['notesAttributes']).toBe('view')   // declared but not permitted
  })

  it('the { allowDestroy: true } object form is governed too (was previously skipped)', () => {
    const config: any = { get: { expose: [], abilities: true }, update: { permit: [] } }
    const env = buildRecordEnvelope(record, DuckOwner, config, {}, {})
    expect(env.abilities).toHaveProperty('profileAttributes', 'view')
  })
})

// ── Optimistic concurrency (update.optimisticLock → 409 Conflict) ────────────

import { Conflict } from '../src/errors.js'

describe('defaultUpdate optimistic lock', () => {
  const updatedAt = new Date('2026-07-19T10:00:00.000Z')
  const freshToken = String(updatedAt.getTime())

  function makeRecord(extra: Record<string, any> = {}) {
    return {
      id: 1, name: 'before', updatedAt,
      save: vi.fn().mockResolvedValue(true),
      errors: {},
      ...extra,
    } as any
  }
  function makeRelation(record: any) {
    return { where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(record) }) } as any
  }
  const lockConfig: any = { update: { permit: ['name'], optimisticLock: true } }

  it('a STALE _version → 409 Conflict, nothing applied, nothing saved', async () => {
    const record = makeRecord()
    const relation = makeRelation(record)
    await expect(
      defaultUpdate(relation, { name: 'Deal' }, lockConfig, 1, { name: 'after', _version: 'stale-token' }, {}, {}),
    ).rejects.toBeInstanceOf(Conflict)
    expect(record.name).toBe('before')
    expect(record.save).not.toHaveBeenCalled()
  })

  it('the MATCHING _version passes and saves', async () => {
    const record = makeRecord()
    const relation = makeRelation(record)
    await defaultUpdate(relation, { name: 'Deal' }, lockConfig, 1, { name: 'after', _version: freshToken }, {}, {})
    expect(record.name).toBe('after')
    expect(record.save).toHaveBeenCalled()
  })

  it('no _version on the wire → no check (pre-lock clients keep working)', async () => {
    const record = makeRecord()
    const relation = makeRelation(record)
    await defaultUpdate(relation, { name: 'Deal' }, lockConfig, 1, { name: 'after' }, {}, {})
    expect(record.name).toBe('after')
    expect(record.save).toHaveBeenCalled()
  })

  it('optimisticLock off → _version is ignored entirely', async () => {
    const record = makeRecord()
    const relation = makeRelation(record)
    await defaultUpdate(relation, { name: 'Deal' }, { update: { permit: ['name'] } } as any, 1,
      { name: 'after', _version: 'whatever' }, {}, {})
    expect(record.name).toBe('after')
  })

  it('a NUMERIC lock field auto-increments on every governed update', async () => {
    const record = makeRecord({ lockVersion: 3 })
    const relation = makeRelation(record)
    const config: any = { update: { permit: ['name'], optimisticLock: 'lockVersion' } }
    await defaultUpdate(relation, { name: 'Deal' }, config, 1, { name: 'after', _version: '3' }, {}, {})
    expect(record.lockVersion).toBe(4)
    expect(record.save).toHaveBeenCalled()
  })

  it('the envelope carries the version token (Dates → epoch millis, opaque)', () => {
    const record = { id: 1, name: 'x', updatedAt }
    const config: any = {
      get: { expose: ['name'], abilities: true },
      update: { permit: ['name'], optimisticLock: true },
    }
    const env = buildRecordEnvelope(record, { tableName: 'deals' }, config, {}, {})
    expect(env.version).toBe(freshToken)
  })

  it('the 409 carries the CURRENT envelope when the controller uses envelopes', async () => {
    const record = makeRecord()
    const relation = makeRelation(record)
    const config: any = {
      get: { expose: ['name'], abilities: true },
      update: { permit: ['name'], optimisticLock: true },
    }
    let thrown: any
    try {
      await defaultUpdate(relation, { name: 'Deal' }, config, 1, { name: 'after', _version: 'stale' }, {}, {})
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Conflict)
    expect(thrown.envelope?.record?.name).toBe('before')
    expect(thrown.envelope?.version).toBe(freshToken)
  })
})

describe('buildRecordEnvelope — STI subclass inherits governance', () => {
  /** The canonical STI child: one own static, everything else inherited. */
  class DuckSubOwner extends DuckOwner {
    static stiType = 'Sub'
  }

  it('nested abilities keys come from the PARENT declarations', () => {
    const config: any = {
      get: { expose: ['bio'], abilities: true },
      update: { permit: ['bio', 'profileAttributes'] },
    }
    const env = buildRecordEnvelope({ id: 1, bio: 'x' }, DuckSubOwner, config, {}, {})
    // Both parent-declared nested surfaces are governed on the subclass —
    // an own-properties scan saw NONE of them (no keys, mask silently open)
    expect(env.abilities['profileAttributes']).toBe('edit')
    expect(env.abilities['notesAttributes']).toBe('view')
  })

  it('state events from an inherited machine still gate _event (can map present)', () => {
    class StateBase { static tableName = 'sb'; static stage = { _type: 'state', transitions: { go: {}, stop: {} } } }
    class StateChild extends StateBase { static stiType = 'Child' }
    const config: any = { get: { expose: ['id'], abilities: true }, update: { permit: [] } }
    const env = buildRecordEnvelope({ id: 1 }, StateChild, config, {}, {})
    expect(Object.keys(env.can).sort()).toEqual(['go', 'stop'])
  })
})

// ── $or combinator — depth-1, allowlisted, capped ────────────────────────────

import { defaultIndex } from '../src/crud-handlers.js'
import { BadRequest as BR } from '../src/errors.js'

describe('defaultIndex $or', () => {
  function makeRel() {
    const rel: any = {
      where: vi.fn(() => rel),
      whereAny: vi.fn(() => rel),
      order: vi.fn(() => rel),
      count: vi.fn(async () => 0),
      limit: vi.fn(() => rel),
      offset: vi.fn(() => rel),
      includes: vi.fn(() => rel),
      load: vi.fn(async () => []),
    }
    return rel
  }
  const model: any = { name: 'Deal' }
  const config: any = { index: { filterable: ['stage', 'priority'] } }

  it('valid branches route through whereAny with converted values', async () => {
    const rel = makeRel()
    await defaultIndex(rel, model, config, { filters: { $or: [{ stage: 'draft' }, { priority: 'high' }] } } as any)
    expect(rel.whereAny).toHaveBeenCalledWith([{ stage: 'draft' }, { priority: 'high' }])
  })

  it('rejects non-allowlisted fields inside branches', async () => {
    const rel = makeRel()
    await expect(defaultIndex(rel, model, config, { filters: { $or: [{ secret: 1 }] } } as any))
      .rejects.toBeInstanceOf(BR)
  })

  it('rejects nesting and over-cap branch counts', async () => {
    const rel = makeRel()
    await expect(defaultIndex(rel, model, config, { filters: { $or: [{ stage: { $or: [] } }] } } as any))
      .rejects.toBeInstanceOf(BR)
    const eleven = Array.from({ length: 11 }, () => ({ stage: 'draft' }))
    await expect(defaultIndex(rel, model, config, { filters: { $or: eleven } } as any))
      .rejects.toBeInstanceOf(BR)
  })

  it('rejects non-array / non-object shapes', async () => {
    const rel = makeRel()
    await expect(defaultIndex(rel, model, config, { filters: { $or: { stage: 'x' } } } as any))
      .rejects.toBeInstanceOf(BR)
    await expect(defaultIndex(rel, model, config, { filters: { $or: ['nope'] } } as any))
      .rejects.toBeInstanceOf(BR)
  })
})

// ── @mutation rules: guard + params allowlist + required (enforced, not advisory) ──

import { enforceMutationRules, buildRecordEnvelope as buildEnv2 } from '../src/crud-handlers.js'
import { ValidationError } from '../src/errors.js'
import { mutation } from '../src/decorators.js'

describe('enforceMutationRules', () => {
  const record = { id: 1, stage: 'submitted' }

  it('guard false → 422 base error (the grey button is enforced server-side)', () => {
    const mut: any = { method: 'sendBack', bulk: false, if: (r: any) => r.stage === 'draft' }
    expect(() => enforceMutationRules(mut, record, { reason: 'x' }, {}, {}))
      .toThrowError(ValidationError)
    try { enforceMutationRules(mut, record, undefined, {}, {}) } catch (e: any) {
      expect(e.errors.base[0]).toContain('sendBack is not available')
    }
  })

  it('guard true → payload flows; params allowlist strips undeclared keys', () => {
    const mut: any = { method: 'sendBack', bulk: false, if: (r: any) => r.stage === 'submitted', params: ['reason'] }
    const out = enforceMutationRules(mut, record, { reason: 'needs numbers', isHot: true, ownerId: 99 }, {}, {})
    expect(out).toEqual({ reason: 'needs numbers' })   // forged fields never reach the method
  })

  it('required params missing/blank → 422 with per-field issues', () => {
    const mut: any = { method: 'sendBack', bulk: false, params: ['reason'], required: ['reason'] }
    for (const data of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
      try {
        enforceMutationRules(mut, record, data as any, {}, {})
        expect.unreachable('should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError)
        expect(e.errors.reason).toEqual(['is required'])
      }
    }
    expect(enforceMutationRules(mut, record, { reason: 'ok' }, {}, {})).toEqual({ reason: 'ok' })
  })

  it('no params declared → data passes through untouched (back-compat)', () => {
    const mut: any = { method: 'poke', bulk: false }
    expect(enforceMutationRules(mut, record, { anything: 1 }, {}, {})).toEqual({ anything: 1 })
  })

  it('guard receives (record, ctx, ctrl)', () => {
    const seen: any[] = []
    const mut: any = { method: 'x', bulk: false, if: (...args: any[]) => { seen.push(args); return true } }
    const ctx = { user: { id: 7 } }, ctrl = { relation: 'rel' }
    enforceMutationRules(mut, record, undefined, ctx, ctrl)
    expect(seen[0]).toEqual([record, ctx, ctrl])
  })
})

describe('buildRecordEnvelope — @mutation verdicts ride the can map', () => {
  class GuardedCtrl {
    @mutation({ if: (r: any) => r.stage === 'submitted', label: 'Mark won' })
    async win() {}
    @mutation()
    async poke() {}
    @mutation({ bulk: true })
    async archiveAll() {}
  }

  const config: any = { get: { expose: ['stage'], abilities: true }, update: { permit: [] } }
  const model: any = { name: 'Deal', fieldMeta: {} }

  it('guarded mutation projects its per-record verdict; unguarded is always true; bulk is excluded', () => {
    const ctrl = new GuardedCtrl()
    const env = buildEnv2({ id: 1, stage: 'submitted' }, model, config, {}, ctrl)
    expect(env.can['win']).toBe(true)
    expect(env.can['poke']).toBe(true)
    expect(env.can).not.toHaveProperty('archiveAll')

    const env2 = buildEnv2({ id: 2, stage: 'draft' }, model, config, {}, ctrl)
    expect(env2.can['win']).toBe(false)
  })
})
