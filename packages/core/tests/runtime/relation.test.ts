/**
 * Relation tests — smart hash where(), sub-queries, order(), inBatches(),
 * destroyAll(), toSubquery(), and Attr.set() integration in queries.
 *
 * Uses the same mock DB pattern as hooks.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { Attr } from '../../src/runtime/attr.js'
import { model } from '../../src/runtime/decorators.js'
import { eq, and } from 'drizzle-orm'

// ── Mock DB ────────────────────────────────────────────────────────────────

// Builds a mock DB where each query layer captures what was passed to it.
function makeCaptureDb(rows: any[] = []) {
  // Track calls for assertions
  const captured: { select?: any; where?: any; from?: any; orderBy?: any; limit?: any; offset?: any; insert?: any; update?: any; delete?: any } = {}

  // findMany mock (used by buildQuery via db.query[tableName].findMany)
  const findMany = vi.fn(async (config: any) => {
    captured.select = config
    return rows
  })

  const returningMock = vi.fn().mockResolvedValue(rows.length > 0 ? [rows[0]] : [{ id: 99 }])
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock })
  const setMock = vi.fn().mockReturnValue({ where: whereMock })

  // For db.select().from(table).where().orderBy().limit().offset()
  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn((c) => { captured.where = c; return chainMock }),
    orderBy: vi.fn((...args: any[]) => { captured.orderBy = args; return chainMock }),
    limit: vi.fn((l) => { captured.limit = l; return chainMock }),
    offset: vi.fn((o) => { captured.offset = o; return chainMock }),
    then: (res: any) => res(rows),
    // Make it awaitable (Promise-like)
  }
  // Make chainMock thenable
  Object.defineProperty(chainMock, Symbol.toStringTag, { value: 'Promise' })

  const selectMock = vi.fn(() => chainMock)
  const deleteMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ rowCount: rows.length }) }))
  const updateMock = vi.fn(() => ({ set: setMock }))
  const insertMock = vi.fn(() => ({ values: vi.fn(() => ({ returning: returningMock })) }))

  return {
    db: {
      query: { posts: { findMany } },
      select: selectMock,
      delete: deleteMock,
      update: updateMock,
      insert: insertMock,
    } as any,
    findMany,
    selectMock,
    deleteMock,
    updateMock,
    captured,
    returningMock,
  }
}

// Minimal fake column objects — enough for eq()/inArray() to not throw
function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

const schema = {
  posts: fakeTable(['id', 'title', 'status', 'teamId']),
}

// ── Setup ──────────────────────────────────────────────────────────────────

@model('posts')
class Post extends ApplicationRecord {
  static status = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)
  static title  = Attr.string()
}

let mockDb: ReturnType<typeof makeCaptureDb>

beforeAll(() => {
  mockDb = makeCaptureDb([{ id: 1, title: 'hello', status: 0 }])
  boot(mockDb.db, schema)
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ── where() hash conditions ────────────────────────────────────────────────

describe('Relation.where() — hash conditions', () => {
  it('simple equality: eq(col, rawValue)', () => {
    const rel = new Relation(Post)
    rel.where({ title: 'hello' })
    expect(rel['_where']).toHaveLength(1)
  })

  it('applies Attr.set() transform for enum labels', () => {
    // Build the relation and inspect _where directly
    const rel = new Relation(Post)
    rel.where({ status: 'sent' })
    expect(rel['_where']).toHaveLength(1)
    // The single expression should NOT be the raw hash { status: 'sent' }
    // It should be a drizzle SQL object (produced by eq())
    const expr = rel['_where'][0] as any
    expect(expr).not.toMatchObject({ status: 'sent' })
    // And the JSON serialisation should contain the integer 1 (Attr.set('sent') = 1)
    expect(JSON.stringify(expr)).toContain('1')
  })

  it('array value → inArray with Attr.set() per element', async () => {
    let capturedConfig: any
    mockDb.db.query.posts.findMany = vi.fn(async (cfg: any) => {
      capturedConfig = cfg
      return []
    })
    await new Relation(Post).where({ status: ['draft', 'sent'] }).load()
    expect(capturedConfig.where).toBeDefined()
    // Stringify the SQL expression — it should include the transformed integers 0 and 1
    const sqlStr = JSON.stringify(capturedConfig.where)
    expect(sqlStr).toContain('0')
    expect(sqlStr).toContain('1')
  })

  it('null value → isNull expression', () => {
    const rel = new Relation(Post)
    rel.where({ teamId: null })
    expect(rel['_where']).toHaveLength(1)
    // isNull produces a "IS NULL" SQL node
    const expr = rel['_where'][0] as any
    const sql = JSON.stringify(expr).toLowerCase()
    expect(sql).toContain('null')
  })

  it('throws if column not found in schema', () => {
    const rel = new Relation(Post)
    expect(() => rel.where({ nonExistent: 'value' })).toThrow(/nonExistent/i)
  })

  it('passes raw SQL expression through unchanged', () => {
    const rel = new Relation(Post)
    const expr = eq(schema.posts.title!, 'hello')
    rel.where(expr as any)
    expect(rel['_where'][0]).toBe(expr)
  })

  it('chains multiple where() calls with AND semantics', () => {
    const rel = new Relation(Post)
    rel.where({ status: 'draft' }).where({ teamId: 5 })
    expect(rel['_where']).toHaveLength(2)
  })

  it('no-ops on null / undefined condition', () => {
    const rel = new Relation(Post)
    rel.where(null)
    rel.where(undefined)
    expect(rel['_where']).toHaveLength(0)
  })
})

// ── order() ────────────────────────────────────────────────────────────────

describe('Relation.order()', () => {
  it('accepts (field, "desc") and builds desc() expression', () => {
    const rel = new Relation(Post)
    rel.order('title', 'desc')
    expect(rel['_order']).toHaveLength(1)
  })

  it('defaults to asc', () => {
    const rel = new Relation(Post)
    rel.order('title')
    expect(rel['_order']).toHaveLength(1)
  })

  it('throws if column not found', () => {
    const rel = new Relation(Post)
    expect(() => rel.order('missing')).toThrow(/Column "missing" not found/)
  })

  it('accepts raw drizzle SQL expression', () => {
    const expr = eq(schema.posts.id!, 1) as any
    const rel = new Relation(Post)
    rel.order(expr)
    expect(rel['_order'][0]).toBe(expr)
  })
})

// ── limit / offset ─────────────────────────────────────────────────────────

describe('Relation.limit() / offset()', () => {
  it('stores limit and offset', () => {
    const rel = new Relation(Post).limit(10).offset(20)
    expect(rel['_limit']).toBe(10)
    expect(rel['_offset']).toBe(20)
  })
})

// ── toSubquery ─────────────────────────────────────────────────────────────

describe('Relation.toSubquery()', () => {
  it('builds a Drizzle sub-query selecting the given column', () => {
    const rel = new Relation(Post).where({ status: 'draft' })
    // toSubquery() calls getExecutor().select(...).from(table).where(...)
    // We just verify it doesn't throw and returns something
    expect(() => rel.toSubquery('id')).not.toThrow()
    rel.toSubquery('id')
    expect(mockDb.selectMock).toHaveBeenCalled()
  })

  it('throws when column does not exist', () => {
    const rel = new Relation(Post)
    expect(() => rel.toSubquery('nonexistent')).toThrow(/not found/)
  })
})

// ── destroyAll ─────────────────────────────────────────────────────────────

describe('Relation.destroyAll()', () => {
  it('calls db.delete(table) with where clause', async () => {
    const rel = new Relation(Post).where({ status: 'draft' })
    await rel.destroyAll()
    expect(mockDb.deleteMock).toHaveBeenCalled()
  })
})

// ── inBatches ──────────────────────────────────────────────────────────────

describe('Relation.inBatches()', () => {
  it('calls callback once per full batch then stops on partial', async () => {
    // Each call to findMany: first returns 3 rows (< batchSize 5), so should stop after 1 batch
    mockDb.db.query.posts.findMany = vi.fn(async () => [
      { id: 1 }, { id: 2 }, { id: 3 },
    ])

    const callbackCount = vi.fn()
    await new Relation(Post).inBatches(5, async (_batch) => {
      callbackCount()
    })

    expect(callbackCount).toHaveBeenCalledTimes(1)
  })

  it('stops when findMany returns empty array', async () => {
    mockDb.db.query.posts.findMany = vi.fn(async () => [])
    const callbackCount = vi.fn()
    await new Relation(Post).inBatches(10, async () => { callbackCount() })
    expect(callbackCount).not.toHaveBeenCalled()
  })

  it('iterates across multiple full batches then stops', async () => {
    // Return exactly batchSize each of first 2 calls, then 0
    let call = 0
    mockDb.db.query.posts.findMany = vi.fn(async () => {
      call++
      if (call <= 2) return [{ id: call * 10 }, { id: call * 10 + 1 }]  // 2 rows = batchSize
      return []
    })

    const callbackCount = vi.fn()
    await new Relation(Post).inBatches(2, async () => { callbackCount() })
    expect(callbackCount).toHaveBeenCalledTimes(2)
  })
})

// ── Relation sub-query in where ────────────────────────────────────────────

describe('Relation as value in where() → sub-query', () => {
  it('passes inArray(col, subquery) when a Relation is the value', () => {
    @model('posts')
    class Team extends ApplicationRecord {}
    // Make teams table available in schema
    schema['teams' as any] = fakeTable(['id', 'postId'])
    boot(mockDb.db, schema)

    const subRelation = new Relation(Post).where({ status: 'draft' })
    const teamRel = new Relation(Team)
    // This should call inArray with the subquery
    teamRel.where({ id: subRelation })
    expect(teamRel['_where']).toHaveLength(1)
    // The expression should be an inArray / IN expression
    const expr = JSON.stringify(teamRel['_where'][0]).toLowerCase()
    expect(expr).toContain('in')
  })
})

// ── _clone immutability ─────────────────────────────────────────────────────

describe('Relation._clone()', () => {
  it('produces an independent copy that does not mutate the original', () => {
    const original = new Relation(Post).where({ status: 'draft' }).limit(5)
    const cloned = (original as any)._clone() as Relation<any>
    cloned.limit(99)
    cloned.where({ teamId: 1 })
    expect(original['_limit']).toBe(5)
    expect(original['_where']).toHaveLength(1)
  })
})
