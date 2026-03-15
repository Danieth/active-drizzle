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

    expect(permitFn).toHaveBeenCalledWith(ctx, ctrl)
    expect(record.name).toBe('after')
    expect(record.secret).toBe('before-secret')
  })
})
