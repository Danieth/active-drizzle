/**
 * Relation tests — comprehensive coverage of all query-builder methods.
 *
 * Covers: where/order/limit/offset, load, first/firstBang, last/lastBang, take,
 * count, sum, average, minimum, maximum, tally, exists/any/many/one/empty,
 * none, pluck, pick, ids, findOrInitializeBy, findOrCreateBy, updateAll,
 * destroyAll, inBatches, findEach, toSubquery, withLock, loadAsync, clone.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { Attr } from '../../src/runtime/attr.js'
import { model } from '../../src/runtime/decorators.js'
import { belongsTo } from '../../src/runtime/markers.js'
import { RecordNotFound } from '../../src/runtime/boot.js'
import { eq } from 'drizzle-orm'

// ── Mock DB helpers ──────────────────────────────────────────────────────────

/**
 * Creates a mock DB that:
 *   - db.query[table].findMany → returns findManyRows
 *   - db.select() chains → thenable that resolves to selectRows
 *   - db.update()/delete()/insert() mocks
 */
function makeFlexibleDb(opts: {
  findManyRows?: any[]
  selectRows?: any[]
  insertRows?: any[]
} = {}) {
  const findManyRows = opts.findManyRows ?? []
  const selectRows   = opts.selectRows   ?? []
  const insertRows   = opts.insertRows   ?? [{ id: 1 }]

  const findMany = vi.fn(async () => findManyRows)

  const chainMock: any = {
    from:    vi.fn(() => chainMock),
    where:   vi.fn(() => chainMock),
    limit:   vi.fn(() => chainMock),
    offset:  vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    groupBy: vi.fn(() => chainMock),
    for:     vi.fn(() => chainMock),
    then:    (res: any) => res(selectRows),
  }

  const selectMock = vi.fn(() => chainMock)
  const deleteMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ rowCount: findManyRows.length }) }))
  const updateSetMock  = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ rowCount: 2 }) }))
  const updateMock = vi.fn(() => ({ set: updateSetMock }))
  const returningMock  = vi.fn().mockResolvedValue(insertRows)
  const insertMock = vi.fn(() => ({ values: vi.fn(() => ({ returning: returningMock })) }))

  const db: any = {
    query: { posts: { findMany } },
    select: selectMock,
    delete: deleteMock,
    update: updateMock,
    insert: insertMock,
    transaction: vi.fn(async (cb: any) => cb(db)),
  }

  return { db, findMany, selectMock, deleteMock, updateMock, updateSetMock, insertMock, chainMock }
}

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

const schema = {
  posts:   fakeTable(['id', 'title', 'status', 'teamId', 'score', 'price']),
  authors: fakeTable(['id', 'name', 'reputation']),
}

// ── Models ───────────────────────────────────────────────────────────────────

@model('authors')
class Author extends ApplicationRecord {
  static reputation = Attr.enum({ novice: 0, expert: 1 } as const)
}

@model('posts')
class Post extends ApplicationRecord {
  static status = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)
  static title  = Attr.string()
  static author = belongsTo('authors')
}

let defaultDb: ReturnType<typeof makeFlexibleDb>

beforeAll(() => {
  defaultDb = makeFlexibleDb({ findManyRows: [{ id: 1, title: 'hello', status: 0 }] })
  boot(defaultDb.db, schema)
})

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.clearAllMocks())

// ─────────────────────────────────────────────────────────────────────────────
// 1. where() hash conditions
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.where() — hash conditions', () => {
  it('simple equality: eq(col, rawValue)', () => {
    const rel = new Relation(Post)
    rel.where({ title: 'hello' })
    expect(rel['_where']).toHaveLength(1)
  })

  it('applies Attr.set() transform for enum labels', () => {
    const rel = new Relation(Post)
    rel.where({ status: 'sent' })
    expect(rel['_where']).toHaveLength(1)
    const expr = rel['_where'][0] as any
    expect(expr).not.toMatchObject({ status: 'sent' })
    expect(JSON.stringify(expr)).toContain('1')
  })

  it('array value → inArray with Attr.set() per element', async () => {
    let capturedConfig: any
    defaultDb.db.query.posts.findMany = vi.fn(async (cfg: any) => {
      capturedConfig = cfg
      return []
    })
    await new Relation(Post).where({ status: ['draft', 'sent'] }).load()
    expect(capturedConfig.where).toBeDefined()
    const sqlStr = JSON.stringify(capturedConfig.where)
    expect(sqlStr).toContain('0')
    expect(sqlStr).toContain('1')
  })

  it('null value → isNull expression', () => {
    const rel = new Relation(Post)
    rel.where({ teamId: null })
    expect(rel['_where']).toHaveLength(1)
    const sql = JSON.stringify(rel['_where'][0]).toLowerCase()
    expect(sql).toContain('null')
  })

  it('throws if column not found in schema', () => {
    const rel = new Relation(Post)
    expect(() => rel.where({ nonExistent: 'value' })).toThrow(/Column "nonExistent" not found/)
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. order()
// ─────────────────────────────────────────────────────────────────────────────

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

  it('chains multiple order() calls', () => {
    const rel = new Relation(Post).order('status', 'asc').order('title', 'desc')
    expect(rel['_order']).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. limit / offset
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.limit() / offset()', () => {
  it('stores limit and offset', () => {
    const rel = new Relation(Post).limit(10).offset(20)
    expect(rel['_limit']).toBe(10)
    expect(rel['_offset']).toBe(20)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. load() / all()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.load()', () => {
  it('calls db.query[tableName].findMany and returns model instances', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, title: 'A', status: 0 }, { id: 2, title: 'B', status: 1 }] })
    boot(mock.db, schema)

    const posts = await new Relation(Post).load()
    expect(posts).toHaveLength(2)
    expect(posts[0]).toBeInstanceOf(Post)
    expect(mock.findMany).toHaveBeenCalled()
  })

  it('returns empty array when no rows match', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const posts = await new Relation(Post).load()
    expect(posts).toEqual([])
  })

  it('Relation is thenable — can be awaited directly', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, title: 'T', status: 0 }] })
    boot(mock.db, schema)

    const posts: Post[] = await new Relation(Post) as any
    expect(posts).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. first() / firstBang()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.first() / firstBang()', () => {
  it('first() returns the first record', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, title: 'first', status: 0 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).first()
    expect(post).toBeInstanceOf(Post)
    expect((post as any).id).toBe(1)
  })

  it('first() returns null when no rows', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const post = await new Relation(Post).first()
    expect(post).toBeNull()
  })

  it('firstBang() returns the record when found', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 5, title: 'exists', status: 1 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).firstBang()
    expect(post).toBeInstanceOf(Post)
  })

  it('firstBang() throws RecordNotFound when empty', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    await expect(new Relation(Post).firstBang()).rejects.toThrow(RecordNotFound)
  })

  it('first() sets _limit = 1 on the cloned relation', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)
    let capturedConfig: any
    mock.db.query.posts.findMany = vi.fn(async (cfg: any) => { capturedConfig = cfg; return [] })

    await new Relation(Post).first()
    expect(capturedConfig?.limit).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. last() / lastBang()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.last() / lastBang()', () => {
  it('last() with no args returns the last record (desc id)', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 99, title: 'last', status: 0 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).last()
    expect(post).toBeInstanceOf(Post)
    expect((post as any).id).toBe(99)
  })

  it('last() returns null when no rows', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const post = await new Relation(Post).last()
    expect(post).toBeNull()
  })

  it('last(n) returns an array of n records', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, status: 0 }, { id: 2, status: 0 }, { id: 3, status: 0 }] })
    boot(mock.db, schema)

    const posts = await new Relation(Post).last(3) as Post[]
    expect(Array.isArray(posts)).toBe(true)
    expect(posts).toHaveLength(3)
  })

  it('last() reverses an existing order', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)
    let capturedConfig: any
    mock.db.query.posts.findMany = vi.fn(async (cfg: any) => { capturedConfig = cfg; return [] })

    await new Relation(Post).order('title', 'asc').last()
    // order should have been reversed
    expect(capturedConfig?.orderBy).toBeDefined()
  })

  it('lastBang() throws when empty', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    await expect(new Relation(Post).lastBang()).rejects.toThrow(RecordNotFound)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. take()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.take()', () => {
  it('take() with no args returns a single record', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, status: 0 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).take()
    expect(post).toBeInstanceOf(Post)
  })

  it('take() with no args returns null when empty', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const post = await new Relation(Post).take()
    expect(post).toBeNull()
  })

  it('take(n) returns an array of n records', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, status: 0 }, { id: 2, status: 0 }] })
    boot(mock.db, schema)

    const posts = await new Relation(Post).take(2) as Post[]
    expect(Array.isArray(posts)).toBe(true)
    expect(posts).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. count()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.count()', () => {
  it('returns count from db.select()', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 42 }] })
    boot(mock.db, schema)

    const n = await new Relation(Post).count()
    expect(n).toBe(42)
    expect(mock.selectMock).toHaveBeenCalled()
  })

  it('returns 0 when no rows', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: null }] })
    boot(mock.db, schema)

    const n = await new Relation(Post).count()
    expect(n).toBe(0)
  })

  it('count() on a none() relation returns 0 without hitting the DB', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    const n = await new Relation(Post).none().count()
    expect(n).toBe(0)
    expect(mock.selectMock).not.toHaveBeenCalled()
  })

  it('applies where clauses to the count query', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 5 }] })
    boot(mock.db, schema)

    const n = await new Relation(Post).where({ status: 'draft' }).count()
    expect(n).toBe(5)
    expect(mock.chainMock.where).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. sum() / average() / minimum() / maximum()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.sum() / average() / minimum() / maximum()', () => {
  it('sum() returns the sum as a number', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 1500 }] })
    boot(mock.db, schema)

    const total = await new Relation(Post).sum('score')
    expect(total).toBe(1500)
  })

  it('sum() returns 0 on none() relation', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    const total = await new Relation(Post).none().sum('score')
    expect(total).toBe(0)
  })

  it('sum() throws when column not found', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    await expect(new Relation(Post).sum('nonexistent')).rejects.toThrow(/not found/)
  })

  it('average() returns the average', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: '7.5' }] })
    boot(mock.db, schema)

    const avg = await new Relation(Post).average('score')
    expect(avg).toBe(7.5)
  })

  it('average() returns null when no rows', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: null }] })
    boot(mock.db, schema)

    const avg = await new Relation(Post).average('score')
    expect(avg).toBeNull()
  })

  it('average() returns null on none() relation', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(await new Relation(Post).none().average('score')).toBeNull()
  })

  it('minimum() returns the min value', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 3 }] })
    boot(mock.db, schema)

    const min = await new Relation(Post).minimum('score')
    expect(min).toBe(3)
  })

  it('minimum() returns null on none()', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(await new Relation(Post).none().minimum('score')).toBeNull()
  })

  it('minimum() throws when column not found', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    await expect(new Relation(Post).minimum('noField')).rejects.toThrow(/not found/)
  })

  it('maximum() returns the max value', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 99 }] })
    boot(mock.db, schema)

    const max = await new Relation(Post).maximum('score')
    expect(max).toBe(99)
  })

  it('maximum() returns null on none()', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(await new Relation(Post).none().maximum('score')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. tally()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.tally()', () => {
  it('returns a Record mapping labels to counts', async () => {
    // status 0 = 'draft', status 1 = 'sent'
    const mock = makeFlexibleDb({ selectRows: [{ val: 0, n: 5 }, { val: 1, n: 3 }] })
    boot(mock.db, schema)

    const counts = await new Relation(Post).tally('status')
    expect(counts).toEqual({ draft: 5, sent: 3 })
  })

  it('tally() on a plain string column', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ val: 'US', n: 10 }, { val: 'UK', n: 4 }] })
    boot(mock.db, schema)

    const counts = await new Relation(Post).tally('title')
    expect(counts).toEqual({ US: 10, UK: 4 })
  })

  it('tally() returns {} on none() relation', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    const counts = await new Relation(Post).none().tally('status')
    expect(counts).toEqual({})
  })

  it('tally() throws when column not found', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    await expect(new Relation(Post).tally('badColumn')).rejects.toThrow(/not found/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. exists() / any() / many() / one() / empty()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.exists() / any() / many() / one() / empty()', () => {
  it('exists() returns true when rows exist', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ one: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).exists()).toBe(true)
  })

  it('exists() returns false when no rows', async () => {
    const mock = makeFlexibleDb({ selectRows: [] })
    boot(mock.db, schema)
    expect(await new Relation(Post).exists()).toBe(false)
  })

  it('exists() returns false on none() relation', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(await new Relation(Post).none().exists()).toBe(false)
  })

  it('exists() accepts additional conditions', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ one: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).exists({ status: 'draft' })).toBe(true)
  })

  it('any() is an alias for exists()', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ one: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).any()).toBe(true)
  })

  it('many() returns true when count > 1', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 5 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).many()).toBe(true)
  })

  it('many() returns false when count is 1', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).many()).toBe(false)
  })

  it('one() returns true when count is exactly 1', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).one()).toBe(true)
  })

  it('one() returns false when count is 0 or > 1', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ n: 0 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).one()).toBe(false)
  })

  it('empty() returns true when no records exist', async () => {
    const mock = makeFlexibleDb({ selectRows: [] })
    boot(mock.db, schema)
    expect(await new Relation(Post).empty()).toBe(true)
  })

  it('empty() returns false when records exist', async () => {
    const mock = makeFlexibleDb({ selectRows: [{ one: 1 }] })
    boot(mock.db, schema)
    expect(await new Relation(Post).empty()).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. none()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.none()', () => {
  it('load() on none() returns [] without hitting the DB', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1 }] })
    boot(mock.db, schema)

    const posts = await new Relation(Post).none().load()
    expect(posts).toEqual([])
    expect(mock.findMany).not.toHaveBeenCalled()
  })

  it('first() on none() returns null', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1 }] })
    boot(mock.db, schema)
    const post = await new Relation(Post).none().first()
    expect(post).toBeNull()
  })

  it('count() on none() returns 0', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(await new Relation(Post).none().count()).toBe(0)
    expect(mock.selectMock).not.toHaveBeenCalled()
  })

  it('pluck() on none() returns []', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    const ids = await new Relation(Post).none().pluck('id')
    expect(ids).toEqual([])
  })

  it('none() is chainable with where/order/limit', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1 }] })
    boot(mock.db, schema)
    const rel = new Relation(Post).none().where({ status: 'draft' }).limit(5).order('title')
    const posts = await rel.load()
    expect(posts).toEqual([])
    expect(mock.findMany).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. pluck() — flat fields
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.pluck() — flat fields', () => {
  it('single field → flat array of values', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    // Flat pluck uses db.select()
    mock.chainMock.then = (res: any) => res([{ id: 1 }, { id: 2 }, { id: 3 }])

    const ids = await new Relation(Post).pluck('id')
    expect(ids).toEqual([1, 2, 3])
    expect(mock.selectMock).toHaveBeenCalled()
  })

  it('multiple fields → array of objects', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.chainMock.then = (res: any) => res([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ])

    const results = await new Relation(Post).pluck('id', 'title')
    expect(results).toEqual([{ id: 1, title: 'A' }, { id: 2, title: 'B' }])
  })

  it('applies Attr.get transform for enum fields', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    // status is Attr.enum — stored as integer, returned as label
    mock.chainMock.then = (res: any) => res([{ status: 0 }, { status: 1 }])

    const labels = await new Relation(Post).pluck('status')
    expect(labels).toEqual(['draft', 'sent'])
  })

  it('pluck() on none() returns []', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    const result = await new Relation(Post).none().pluck('id')
    expect(result).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 14. pick()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.pick()', () => {
  it('pick(single) returns the first record\'s value', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.chainMock.then = (res: any) => res([{ id: 42 }])

    const id = await new Relation(Post).pick('id')
    expect(id).toBe(42)
  })

  it('pick(multiple) returns the first record as an object', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.chainMock.then = (res: any) => res([{ id: 1, title: 'First' }])

    const result = await new Relation(Post).pick('id', 'title')
    expect(result).toEqual({ id: 1, title: 'First' })
  })

  it('pick() returns null when no rows', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.chainMock.then = (res: any) => res([])

    const result = await new Relation(Post).pick('id')
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 15. ids()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.ids()', () => {
  it('returns all primary key values', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.chainMock.then = (res: any) => res([{ id: 1 }, { id: 2 }, { id: 5 }])

    const ids = await new Relation(Post).ids()
    expect(ids).toEqual([1, 2, 5])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 16. updateAll()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.updateAll()', () => {
  it('calls db.update(table).set(attrs).where(conditions)', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    await new Relation(Post).where({ status: 'draft' }).updateAll({ status: 'sent' })
    expect(mock.updateMock).toHaveBeenCalled()
    expect(mock.updateSetMock).toHaveBeenCalled()
  })

  it('applies Attr.set transforms when building the update', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    let capturedSet: any
    mock.db.update = vi.fn(() => ({
      set: vi.fn((s: any) => {
        capturedSet = s
        return { where: vi.fn().mockResolvedValue({ rowCount: 1 }) }
      }),
    }))

    await new Relation(Post).updateAll({ status: 'sent' })
    // status: 'sent' → integer 1 via Attr.set
    expect(capturedSet).toBeDefined()
    // The value should be the integer 1, not the string 'sent'
    expect(Object.values(capturedSet)).toContain(1)
  })

  it('updateAll() without where clause updates all rows', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    await new Relation(Post).updateAll({ status: 'failed' })
    expect(mock.updateMock).toHaveBeenCalled()
    // where clause should NOT be applied when there's no _where
    const setFn = mock.db.update.mock.results[0]?.value?.set
    expect(setFn).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 17. destroyAll()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.destroyAll()', () => {
  it('calls db.delete(table) with where clause', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    const rel = new Relation(Post).where({ status: 'draft' })
    await rel.destroyAll()
    expect(mock.deleteMock).toHaveBeenCalled()
  })

  it('destroyAll() without conditions deletes all rows', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    await new Relation(Post).destroyAll()
    expect(mock.deleteMock).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 18. inBatches()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.inBatches()', () => {
  it('calls callback once per batch until empty', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    let call = 0
    mock.db.query.posts.findMany = vi.fn(async () => {
      call++
      if (call <= 2) return [{ id: call * 10 }, { id: call * 10 + 1 }]
      return []
    })

    const batchCount = vi.fn()
    await new Relation(Post).inBatches(2, async () => { batchCount() })
    expect(batchCount).toHaveBeenCalledTimes(2)
  })

  it('stops when findMany returns partial batch', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    mock.db.query.posts.findMany = vi.fn(async () => [{ id: 1 }, { id: 2 }, { id: 3 }])

    const calls = vi.fn()
    await new Relation(Post).inBatches(5, async () => { calls() })
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('never calls callback when empty', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const calls = vi.fn()
    await new Relation(Post).inBatches(10, async () => { calls() })
    expect(calls).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 19. findEach()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.findEach()', () => {
  it('calls callback for each individual record', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    // inBatches calls batch.load() to check row count (call 1),
    // then findEach's callback calls batch.load() again (call 2).
    // Both calls return the same rows; rows.length < batchSize breaks the loop.
    let call = 0
    mock.db.query.posts.findMany = vi.fn(async () => {
      call++
      if (call <= 2) return [{ id: 1, status: 0 }, { id: 2, status: 1 }]
      return []
    })

    const seen: number[] = []
    await new Relation(Post).findEach(10, async (post) => {
      seen.push((post as any).id)
    })

    expect(seen).toEqual([1, 2])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 20. findOrInitializeBy() / findOrCreateBy()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.findOrInitializeBy()', () => {
  it('returns the existing record if found', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 5, title: 'existing', status: 0 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).findOrInitializeBy({ title: 'existing' })
    expect(post).toBeInstanceOf(Post)
    expect((post as any).isNewRecord).toBe(false)
  })

  it('returns a new unsaved instance when not found', async () => {
    const mock = makeFlexibleDb({ findManyRows: [] })
    boot(mock.db, schema)

    const post = await new Relation(Post).findOrInitializeBy({ title: 'new one' })
    expect(post).toBeInstanceOf(Post)
    expect((post as any).isNewRecord).toBe(true)
  })
})

describe('Relation.findOrCreateBy()', () => {
  it('returns existing record if found', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 10, title: 'existing', status: 0 }] })
    boot(mock.db, schema)

    const post = await new Relation(Post).findOrCreateBy({ title: 'existing' })
    expect(post).toBeInstanceOf(Post)
    expect(mock.insertMock).not.toHaveBeenCalled()
  })

  it('creates and returns a new record when not found', async () => {
    const mock = makeFlexibleDb({
      findManyRows: [],
      insertRows: [{ id: 99, title: 'new one', status: 0 }],
    })
    boot(mock.db, schema)

    const post = await new Relation(Post).findOrCreateBy({ title: 'new one' })
    expect(post).toBeInstanceOf(Post)
    expect(mock.insertMock).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 21. toSubquery()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.toSubquery()', () => {
  it('builds a subquery without throwing', () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    expect(() => new Relation(Post).where({ status: 'draft' }).toSubquery('id')).not.toThrow()
    expect(mock.selectMock).toHaveBeenCalled()
  })

  it('defaults to selecting "id" column', () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    expect(() => new Relation(Post).toSubquery()).not.toThrow()
    expect(mock.selectMock).toHaveBeenCalled()
  })

  it('throws when the column does not exist in the schema', () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    expect(() => new Relation(Post).toSubquery('nonexistent')).toThrow(/not found/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 22. withLock()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.withLock()', () => {
  it('calls the callback within a transaction', async () => {
    const mock = makeFlexibleDb({ findManyRows: [{ id: 1, status: 0 }] })
    boot(mock.db, schema)

    let callbackFired = false
    await new Relation(Post).where({ id: 1 }).withLock(async (_rel) => {
      callbackFired = true
      return null
    })

    expect(callbackFired).toBe(true)
    expect(mock.db.transaction).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 23. Relation.loadAsync() — fire-and-collect
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.loadAsync()', () => {
  it('returns the relation itself for chaining', () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)

    const rel = new Relation(Post)
    const result = rel.loadAsync()
    expect(result).toBe(rel)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 24. Relation as subquery value in where()
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation as value in where() → sub-query', () => {
  it('passes inArray(col, subquery) when a Relation is the value', () => {
    @model('teams')
    class Team extends ApplicationRecord {}
    schema['teams' as any] = fakeTable(['id', 'postId'])
    boot(defaultDb.db, schema)

    const subRelation = new Relation(Post).where({ status: 'draft' })
    const teamRel = new Relation(Team)
    teamRel.where({ id: subRelation })
    expect(teamRel['_where']).toHaveLength(1)
    const expr = JSON.stringify(teamRel['_where'][0]).toLowerCase()
    expect(expr).toContain('in')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 25. _clone() immutability
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// 26. RecordNotFound from boot.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('RecordNotFound', () => {
  it('constructs with model name and id', () => {
    const err = new RecordNotFound('User', 42)
    expect(err.message).toBe('User with id=42 not found')
    expect(err.model).toBe('User')
    expect(err.id).toBe(42)
    expect(err.name).toBe('RecordNotFound')
    expect(err).toBeInstanceOf(Error)
  })

  it('serializes complex id values with JSON.stringify', () => {
    const err = new RecordNotFound('Post', { teamId: 1, id: 5 })
    expect(err.message).toContain('teamId')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 27. pluck() — nested (dotted) paths
// ─────────────────────────────────────────────────────────────────────────────

describe('Relation.pluck() — nested dotted paths', () => {
  beforeAll(() => {
    // Re-boot with both tables in schema
    const nestedMock = makeFlexibleDb({ findManyRows: [] })
    boot(nestedMock.db, schema)
  })

  it('single nested path → flat array of values', async () => {
    const rows = [
      { id: 1, author: { name: 'Alice' } },
      { id: 2, author: { name: 'Bob' } },
    ]
    const mock = makeFlexibleDb()
    mock.db.query.posts = { findMany: vi.fn(async () => rows) }
    boot(mock.db, schema)

    const names = await new Relation(Post).pluck('author.name')
    expect(names).toEqual(['Alice', 'Bob'])
  })

  it('mixed flat + nested → array of objects with dotted keys', async () => {
    const rows = [
      { id: 1, status: 0, author: { name: 'Alice' } },
      { id: 2, status: 1, author: { name: 'Bob' } },
    ]
    const mock = makeFlexibleDb()
    mock.db.query.posts = { findMany: vi.fn(async () => rows) }
    boot(mock.db, schema)

    const results = await new Relation(Post).pluck('id', 'author.name')
    expect(results).toEqual([
      { id: 1, 'author.name': 'Alice' },
      { id: 2, 'author.name': 'Bob' },
    ])
  })

  it('applies Attr.get transform on the nested field', async () => {
    // Author.reputation is Attr.enum: 0 → 'novice', 1 → 'expert'
    const rows = [
      { author: { reputation: 0 } },
      { author: { reputation: 1 } },
    ]
    const mock = makeFlexibleDb()
    mock.db.query.posts = { findMany: vi.fn(async () => rows) }
    boot(mock.db, schema)

    const reps = await new Relation(Post).pluck('author.reputation')
    expect(reps).toEqual(['novice', 'expert'])
  })

  it('null association → undefined value in result (optional chaining)', async () => {
    const rows = [
      { id: 1, author: null },
      { id: 2, author: { name: 'Bob' } },
    ]
    const mock = makeFlexibleDb()
    mock.db.query.posts = { findMany: vi.fn(async () => rows) }
    boot(mock.db, schema)

    const names = await new Relation(Post).pluck('author.name')
    // null?.name returns undefined (optional chaining semantics)
    expect(names[0]).toBeUndefined()
    expect(names[1]).toBe('Bob')
  })

  it('nested pluck passes limit and offset to findMany', async () => {
    let capturedConfig: any
    const mock = makeFlexibleDb()
    mock.db.query.posts = {
      findMany: vi.fn(async (cfg: any) => { capturedConfig = cfg; return [] }),
    }
    boot(mock.db, schema)

    await new Relation(Post).limit(5).offset(10).pluck('author.name')
    expect(capturedConfig?.limit).toBe(5)
    expect(capturedConfig?.offset).toBe(10)
  })

  it('nested pluck returns [] on none() relation', async () => {
    const mock = makeFlexibleDb()
    boot(mock.db, schema)
    const result = await new Relation(Post).none().pluck('author.name')
    expect(result).toEqual([])
  })

  it('resolves association target by inferred plural name (no explicit table on marker)', async () => {
    // When belongsTo() has no explicit table, _lookupAssocTarget falls back to
    // inferring the table from the property name (lines 848-855 in relation.ts)
    @model('posts')
    class PostNoTable extends ApplicationRecord {
      // belongsTo() with no table arg → marker.table is undefined → inferential path
      static author = belongsTo()
    }

    const rows = [{ id: 1, author: { name: 'Alice' } }]
    const mock = makeFlexibleDb()
    mock.db.query['posts'] = { findMany: vi.fn(async () => rows) }
    boot(mock.db, { ...schema })

    const names = await new Relation(PostNoTable).pluck('author.name')
    expect(names).toEqual(['Alice'])
  })
})
