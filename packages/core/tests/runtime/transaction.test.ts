/**
 * Transaction tests.
 *
 * - ApplicationRecord.transaction() routes all DB ops through AsyncLocalStorage tx client
 * - AbortChain rolls back the transaction
 * - @validate() decorator wired into save()
 * - ApplicationRecord.find() / create() / findBy() convenience methods
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, transaction, AbortChain } from '../../src/runtime/boot.js'
import { Attr } from '../../src/runtime/attr.js'
import { model, validate, beforeSave, afterCommit, transactional } from '../../src/runtime/decorators.js'

// ── Mock DB ────────────────────────────────────────────────────────────────

const mockRow = { id: 1, title: 'test', status: 0 }
const mockReturning = vi.fn().mockResolvedValue([mockRow])

const mockDb = {
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: mockReturning })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: mockReturning })) })) })),
  delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([mockRow]),
      })),
    })),
  })),
  query: {
    posts: { findMany: vi.fn().mockResolvedValue([mockRow]) },
  },
  // Simulates drizzle's transaction() API
  transaction: vi.fn((cb: (tx: any) => Promise<any>) => {
    const tx = { ...mockDb, _isTx: true }
    return cb(tx)
  }),
} as any

const schema = {
  posts: { id: { name: 'id' }, title: { name: 'title' }, status: { name: 'status' } },
}

beforeAll(() => {
  boot(mockDb, schema)
})

// ── transaction() ──────────────────────────────────────────────────────────

describe('ApplicationRecord.transaction()', () => {
  it('delegates to the DB transaction() method', async () => {
    const result = await ApplicationRecord.transaction(async () => 'done')
    expect(result).toBe('done')
    expect(mockDb.transaction).toHaveBeenCalled()
  })

  it('rolls back when callback throws', async () => {
    await expect(
      ApplicationRecord.transaction(async () => {
        throw new Error('oops')
      })
    ).rejects.toThrow('oops')
  })

  it('AbortChain propagates as a regular throw (triggers rollback)', async () => {
    await expect(
      ApplicationRecord.transaction(async () => {
        throw new AbortChain('cancelled')
      })
    ).rejects.toThrow('cancelled')
  })

  it('transaction() function itself works the same way', async () => {
    const result = await transaction(async () => 42)
    expect(result).toBe(42)
  })
})

// ── @validate() decorator ──────────────────────────────────────────────────

describe('@validate() decorator', () => {
  it('runs the decorated method during validate()', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @validate()
      checkTitle() {
        log.push('validated')
        if (!(this as any).title) return 'title is required'
      }
    }

    const p = new Post({ title: '' }, true)
    const valid = await p.validate()
    expect(log).toContain('validated')
    expect(valid).toBe(false)
    expect(p.errors['base']).toContain('title is required')
  })

  it('passes when @validate() method returns undefined', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      @validate()
      alwaysPass() {
        // no return = no error
      }
    }

    const p = new Post({ title: 'ok' }, true)
    const valid = await p.validate()
    expect(valid).toBe(true)
  })

  it('multiple @validate() decorators all run', async () => {
    const ran: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @validate()
      checkA() { ran.push('A') }

      @validate()
      checkB() { ran.push('B') }
    }

    await new Post({}, true).validate()
    expect(ran).toEqual(['A', 'B'])
  })

  it('@validate() blocking save when it returns an error', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      @validate()
      mustHaveTitle() {
        if (!(this as any).title) return 'title required'
      }
    }

    const p = new Post({}, true)
    const saved = await p.save()
    expect(saved).toBe(false)
    expect(p.errors['base']).toContain('title required')
  })
})

// ── find() / findBy() / create() ──────────────────────────────────────────

describe('ApplicationRecord.find() / findBy() / create()', () => {
  it('find() calls db.select().from().where().limit() and returns instance', async () => {
    @model('posts')
    class Post extends ApplicationRecord {}

    const found = await Post.find(1)
    expect(found).toBeInstanceOf(Post)
    expect((found as any)._attributes.id).toBe(1)
  })

  it('findBy() returns first matching record', async () => {
    @model('posts')
    class Post extends ApplicationRecord {}

    const found = await Post.findBy({ title: 'test' })
    expect(found).toBeTruthy()
  })

  it('create() saves and returns the instance', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      static title = Attr.string()
    }

    const post = await Post.create({ title: 'hello' })
    expect(post).toBeInstanceOf(Post)
  })

  it('create() throws if validation fails', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      static title = Attr.string({ validate: v => v ? null : 'required' })
    }

    await expect(Post.create({ title: '' })).rejects.toThrow(/Validation failed/)
  })
})

// ── update() convenience method ────────────────────────────────────────────

describe('instance.update()', () => {
  it('assigns attrs and saves', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      static title = Attr.string()
    }

    const post = new Post({ id: 1, title: 'old' }, false)
    const saved = await post.update({ title: 'new' })
    expect(saved).toBe(true)
    // The update should have set title via proxy set trap
    expect(post._changes.size).toBe(0) // cleared after save
  })
})

// ── toJSON({ only, except }) ───────────────────────────────────────────────

describe('toJSON() with opts', () => {
  it('{ only } filters to named fields', () => {
    const p = new ApplicationRecord({ id: 1, title: 'hello', status: 0 }, false)
    expect(p.toJSON({ only: ['id', 'title'] })).toEqual({ id: 1, title: 'hello' })
  })

  it('{ except } excludes named fields', () => {
    const p = new ApplicationRecord({ id: 1, title: 'hello', status: 0 }, false)
    const json = p.toJSON({ except: ['status'] })
    expect(json).not.toHaveProperty('status')
    expect(json).toHaveProperty('id')
    expect(json).toHaveProperty('title')
  })

  it('no opts returns all attributes', () => {
    const p = new ApplicationRecord({ id: 1, title: 'hello' }, false)
    expect(p.toJSON()).toEqual({ id: 1, title: 'hello' })
  })

  it('{ include } embeds already-loaded association data from _attributes', () => {
    const p = new ApplicationRecord(
      { id: 1, title: 'hello', comments: [{ id: 2, body: 'nice' }] },
      false
    )
    const json = p.toJSON({ include: ['comments'] })
    expect(json['comments']).toEqual([{ id: 2, body: 'nice' }])
    expect(json['title']).toBe('hello')
  })

  it('{ include } returns null for unloaded associations', () => {
    const p = new ApplicationRecord({ id: 1, title: 'hello' }, false)
    const json = p.toJSON({ include: ['campaigns'] })
    expect(json['campaigns']).toBeNull()
  })
})

// ── inspect() format ───────────────────────────────────────────────────────

describe('inspect() output format', () => {
  it('renders inline comma-separated format', () => {
    @model('posts')
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)
    }

    const p = new Post({ id: 99, status: 0, title: 'Hello' }, false)
    const str = (p as any)[Symbol.for('nodejs.util.inspect.custom')]?.(1, {})
      ?? require('util').inspect(p)

    expect(str).toMatch(/^#<Post:99/)
    expect(str).toContain('status: "draft"')
    expect(str).toContain('title: "Hello"')
    // Should be on a single line (comma-separated), not multi-line
    expect(str).not.toMatch(/\n  status:/)
  })

  it('shows (was: x) annotation for dirty fields', () => {
    @model('posts')
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)
    }

    const p = new Post({ id: 1, status: 0, title: 'old' }, false)
    ;(p as any).status = 'sent'
    const str = (p as any)[Symbol.for('nodejs.util.inspect.custom')]?.(1, {})

    expect(str).toContain('(was: "draft")')
    expect(str).toContain('(dirty: status)')
  })
})

// ── afterCommit queuing in transactions ────────────────────────────────────

describe('afterCommit queuing inside transaction()', () => {
  it('@afterCommit fires after transaction() completes', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterCommit()
      notifyAfterCommit() {
        log.push('afterCommit fired')
      }
    }

    await Post.transaction(async () => {
      const p = new Post({}, true)
      ;(p as any).title = 'test'
      await p.save()
      expect(log).toHaveLength(0) // not yet
    })

    expect(log).toContain('afterCommit fired')
  })
})

// ── beforeSave returning false rolls back transaction ─────────────────────

describe('beforeSave returning false inside transaction()', () => {
  it('throws AbortChain to trigger rollback when inside a transaction', async () => {
    const { AbortChain } = await import('../../src/runtime/boot.js')

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave()
      rejectAlways() {
        return false
      }
    }

    await expect(
      Post.transaction(async () => {
        const p = new Post({}, true)
        await p.save()
      })
    ).rejects.toThrow(AbortChain)
  })
})

// ── @transactional decorator ────────────────────────────────────────────────

describe('@transactional decorator', () => {
  it('wraps a method in a transaction automatically', async () => {
    let ranInsideTx = false
    const txSpy = vi.fn((cb: (tx: any) => Promise<any>) => {
      ranInsideTx = true
      return cb({ ...mockDb, _isTx: true })
    })

    const txDb = { ...mockDb, transaction: txSpy } as any
    boot(txDb, { posts: {} })

    class Service {
      @transactional
      async doWork() {
        // Inside the wrapped method — just return a value
        return 'done'
      }
    }

    const svc = new Service()
    const result = await svc.doWork()

    expect(result).toBe('done')
    expect(ranInsideTx).toBe(true)
    expect(txSpy).toHaveBeenCalledOnce()
  })

  it('re-wraps the return value in the transaction result', async () => {
    boot(mockDb, { posts: {} })

    class Calculator {
      @transactional
      async add(a: number, b: number) {
        return a + b
      }
    }

    const calc = new Calculator()
    expect(await calc.add(3, 4)).toBe(7)
  })

  it('rolls back and re-throws when the decorated method throws', async () => {
    let rolledBack = false
    const txDb = {
      ...mockDb,
      transaction: vi.fn((cb: (tx: any) => Promise<any>) =>
        cb({ ...mockDb }).catch((e: Error) => {
          rolledBack = true
          throw e
        })
      ),
    } as any
    boot(txDb, { posts: {} })

    class Exploder {
      @transactional
      async boom() {
        throw new Error('boom!')
      }
    }

    await expect(new Exploder().boom()).rejects.toThrow('boom!')
    expect(rolledBack).toBe(true)
  })
})

// ── Nested transaction detection ─────────────────────────────────────────────

describe('nested transaction() detection', () => {
  it('calls db.transaction() once per nesting level', async () => {
    let txCallCount = 0
    const nestedTxDb = {
      ...mockDb,
      transaction: vi.fn((cb: (tx: any) => Promise<any>) => {
        txCallCount++
        return cb({ ...mockDb, _isTx: true })
      }),
    } as any
    boot(nestedTxDb, { posts: {} })

    await transaction(async () => {
      await transaction(async () => {
        // innermost — no-op
      })
    })

    // Drizzle's transaction() should be invoked for each nesting level
    expect(txCallCount).toBe(2)
  })
})

// ── DB without .transaction() method ─────────────────────────────────────────

describe('transaction() with unsupported DB driver', () => {
  it('throws when the DB does not expose a transaction() function', async () => {
    const noTxDb = {
      // everything except transaction()
      select: mockDb.select,
      insert: mockDb.insert,
      update: mockDb.update,
      delete: mockDb.delete,
      query: mockDb.query,
    } as any
    boot(noTxDb, { posts: {} })

    await expect(
      transaction(async () => { /* noop */ })
    ).rejects.toThrow('DB driver does not support transactions')

    // restore a working db for subsequent tests
    boot(mockDb, { posts: {} })
  })
})

// ── Nested transaction warning in non-test environment ───────────────────────

describe('nested transaction() warning in non-test env', () => {
  it('emits console.warn when depth > 0 outside the test environment', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const origEnv = process.env['NODE_ENV']

    let txCallCount = 0
    const warnTxDb = {
      ...mockDb,
      transaction: vi.fn((cb: (tx: any) => Promise<any>) => {
        txCallCount++
        return cb({ ...mockDb, _isTx: true })
      }),
    } as any
    boot(warnTxDb, { posts: {} })

    try {
      process.env['NODE_ENV'] = 'development'
      await transaction(async () => {
        await transaction(async () => { /* nested */ })
      })
    } finally {
      process.env['NODE_ENV'] = origEnv
    }

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Nested transaction detected'))
    warnSpy.mockRestore()

    // restore a working db
    boot(mockDb, { posts: {} })
  })
})
