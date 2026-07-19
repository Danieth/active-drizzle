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
