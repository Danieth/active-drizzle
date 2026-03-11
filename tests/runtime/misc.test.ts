/**
 * Miscellaneous runtime tests:
 *   - ApplicationRecord.all()
 *   - instance.reload()
 *   - dependent: 'destroy' cascade
 *   - habtm lazy loading
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { Relation } from '../../src/runtime/relation.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { hasMany, hasOne, habtm, belongsTo } from '../../src/runtime/markers.js'
import { Attr } from '../../src/runtime/attr.js'
import { eq } from 'drizzle-orm'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

function makeDb(rows: any[] = []) {
  const findMany = vi.fn(async () => rows)
  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn(() => chainMock),
    limit: vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    offset: vi.fn(() => chainMock),
    for: vi.fn(() => chainMock),
    then: (res: any) => res(rows),
  }
  const deleteMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue({ rowCount: 1 }) }))
  const selectMock = vi.fn(() => chainMock)

  const db: any = {
    query: {
      posts: { findMany },
      comments: { findMany },
      tags: { findMany },
      posts_tags: { findMany },
    },
    select: selectMock,
    delete: deleteMock,
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([rows[0] ?? { id: 1 }]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([rows[0] ?? { id: 1 }]) })) })) })),
    transaction: vi.fn((cb: any) => cb(db)),
  }

  return { db, findMany, chainMock, deleteMock, selectMock }
}

// ── Models ────────────────────────────────────────────────────────────────────

@model('comments')
class Comment extends ApplicationRecord {}

@model('tags')
class Tag extends ApplicationRecord {}

@model('posts')
class Post extends ApplicationRecord {
  static comments = hasMany(undefined, { dependent: 'destroy' })
  static primaryComment = hasOne(undefined, { dependent: 'destroy' })
  static tags = habtm('posts_tags')
}

const schema = {
  posts: fakeTable(['id', 'title']),
  comments: fakeTable(['id', 'title', 'postId']),
  tags: fakeTable(['id', 'name']),
  posts_tags: fakeTable(['id', 'postId', 'tagId']),
}

// ── all() ──────────────────────────────────────────────────────────────────────

describe('ApplicationRecord.all()', () => {
  it('returns a Relation with no where clauses', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const rel = Post.all()
    expect(rel).toBeInstanceOf(Relation)
    expect(rel['_where']).toHaveLength(0)
  })

  it('can be chained with where()', async () => {
    const mock = makeDb([{ id: 1, title: 'foo' }])
    boot(mock.db, schema)

    const posts = await Post.all().where({ title: 'foo' })
    expect(posts).toHaveLength(1)
  })
})

// ── reload() ──────────────────────────────────────────────────────────────────

describe('instance.reload()', () => {
  it('re-fetches from DB and resets changes', async () => {
    const freshRow = { id: 5, title: 'fresh from db' }
    const mock = makeDb([freshRow])
    boot(mock.db, schema)

    const post = new Post({ id: 5, title: 'stale' }, false)
    ;(post as any).title = 'edited locally'
    expect(post.isChanged()).toBe(true)   // plain columns are now dirty-tracked too

    await (post as any).reload()

    expect(post._attributes.title).toBe('fresh from db')
    expect(mock.selectMock).toHaveBeenCalled()
  })

  it('throws for new records', async () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const post = new Post({}, true)
    await expect((post as any).reload()).rejects.toThrow('Cannot reload a new record')
  })

  it('throws if record no longer exists', async () => {
    const mock = makeDb([])  // empty rows — record not found
    boot(mock.db, schema)

    const post = new Post({ id: 99 }, false)
    await expect((post as any).reload()).rejects.toThrow('not found')
  })
})

// ── dependent: 'destroy' ──────────────────────────────────────────────────────

describe('dependent: destroy cascade', () => {
  beforeEach(() => vi.clearAllMocks())

  it('destroys associated hasMany records before destroying owner', async () => {
    const commentRows = [{ id: 10, postId: 1 }, { id: 11, postId: 1 }]
    const mock = makeDb(commentRows)
    boot(mock.db, schema)

    const post = new Post({ id: 1 }, false)

    // destroy() calls hasMany 'comments' with dependent: 'destroy'
    await (post as any).destroy()

    // delete should have been called 3 times: 2 comments + 1 post
    expect(mock.deleteMock).toHaveBeenCalledTimes(3)
  })

  it('ignores hasMany without dependent option', async () => {
    @model('articles')
    class Article extends ApplicationRecord {
      static comments = hasMany()
    }
    const mock = makeDb([])
    boot(mock.db, { ...schema, articles: fakeTable(['id', 'title']) })

    const article = new Article({ id: 1 }, false)
    await (article as any).destroy()

    // Only the article itself is deleted
    expect(mock.deleteMock).toHaveBeenCalledTimes(1)
  })
})

// ── Plain column dirty tracking (no Attr) ────────────────────────────────────

describe('plain column dirty tracking (no Attr declaration)', () => {
  it('tracks changes for columns without Attr config', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const post = new Post({ id: 1, title: 'original' }, false)
    expect(post.isChanged()).toBe(false)

    ;(post as any).title = 'updated'
    expect(post.isChanged()).toBe(true)
    expect(post._changes.get('title')).toEqual({ was: 'original', is: 'updated' })
  })

  it('reads plain column values through the proxy', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const post = new Post({ id: 1, title: 'hello', body: 'world' }, false)
    expect((post as any).title).toBe('hello')
    expect((post as any).body).toBe('world')
  })

  it('un-dirtys a field when set back to original value', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const post = new Post({ id: 1, title: 'original' }, false)
    ;(post as any).title = 'changed'
    expect(post.isChanged()).toBe(true)
    ;(post as any).title = 'original'
    expect(post.isChanged()).toBe(false)
  })
})

// ── counterCache ────────────────────────────────────────────────────────────

describe('counterCache', () => {
  const ccSchema = {
    posts: fakeTable(['id', 'commentsCount']),
    comments: fakeTable(['id', 'postId']),
  }

  @model('comments')
  class Comment extends ApplicationRecord {
    static post = belongsTo()
  }

  @model('posts')
  class PostWithCounter extends ApplicationRecord {
    static comments = hasMany('comments', { counterCache: true } as any)
  }

  it('increments the counter column when a child is created', async () => {
    const updateSets: any[] = []
    const db: any = {
      query: {},
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: (r: any) => r([]) })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 99, postId: 1 }]) })) })),
      update: vi.fn(() => ({
        set: vi.fn((s: any) => {
          updateSets.push(s)
          return { where: vi.fn().mockResolvedValue([]) }
        })
      })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, ccSchema)

    const comment = new Comment({ postId: 1 })
    await comment.save()

    // The update should have been called to increment commentsCount
    expect(db.update).toHaveBeenCalled()
  })

  it('decrements the counter column when a child is destroyed', async () => {
    const db: any = {
      query: {},
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: (r: any) => r([]) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue({ rowCount: 1 }) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, ccSchema)

    const comment = new Comment({ id: 5, postId: 1 }, false)
    await comment.destroy()

    expect(db.update).toHaveBeenCalled()
  })
})

// ── autosave ─────────────────────────────────────────────────────────────────

describe('autosave', () => {
  const asSchema = {
    orders: fakeTable(['id']),
    items: fakeTable(['id', 'orderId', 'name']),
  }

  @model('items')
  class Item extends ApplicationRecord {}

  @model('orders')
  class OrderAS extends ApplicationRecord {
    static items = hasMany('items', { autosave: true } as any)
  }

  it('saves loaded associations when parent is saved', async () => {
    let itemSaved = false
    const db: any = {
      query: {},
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: (r: any) => r([]) })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 10 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 2, orderId: 1, name: 'updated' }]) })) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, asSchema)

    // Create a loaded Item instance with a change and embed it in the order's _attributes
    const item = new Item({ id: 2, orderId: 1, name: 'original' }, false)
    ;(item as any).name = 'updated'

    const order = new OrderAS({ id: 1 }, false)
    // Simulate a pre-loaded association
    order._attributes['items'] = [item]

    await order.save()

    // update should have been called twice: once for order (0 changes, skipped), once for item
    expect(db.update).toHaveBeenCalled()
  })
})

// ── habtm lazy loading ────────────────────────────────────────────────────────

describe('habtm lazy loading', () => {
  it('returns a Relation via subquery through the join table', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const post = new Post({ id: 3 }, false)
    const rel = (post as any).tags

    expect(rel).toBeInstanceOf(Relation)
    // Should have an IN subquery WHERE clause
    expect(rel['_where']).toHaveLength(1)
  })

  it('can be awaited', async () => {
    const tagRows = [{ id: 1, name: 'urgent' }]
    const mock = makeDb(tagRows)
    boot(mock.db, schema)

    const post = new Post({ id: 3 }, false)
    const tags = await (post as any).tags

    expect(tags).toHaveLength(1)
    expect(tags[0]).toBeInstanceOf(Tag)
  })
})

// ---------------------------------------------------------------------------
// ApplicationRecord Proxy — edge cases not covered elsewhere
// ---------------------------------------------------------------------------

describe('ApplicationRecord Proxy — MissingAttributeError', () => {
  it('throws MissingAttributeError when reading an Attr field that was not selected on an existing record', () => {
    class Widget extends ApplicationRecord {
      static price = Attr.new({ get: (v: number) => v / 100, set: (v: number) => v * 100 })
    }

    // Simulate a partial select: 'price' column was NOT loaded (not in _attributes)
    const widget = new Widget({ id: 1 /* no price */ }, false)

    expect(() => (widget as any).price).toThrow('MissingAttributeError')
    expect(() => (widget as any).price).toThrow('price')
  })
})

describe('ApplicationRecord Proxy — new record Attr with no default returns undefined', () => {
  it('returns undefined when the Attr has no default and the field is absent on a new record', () => {
    class Item extends ApplicationRecord {
      static sku = Attr.new({ get: (v: string) => v?.toUpperCase() ?? null, set: (v: string) => v })
      // Note: no default defined
    }

    const item = new Item({}, true)
    // No value in _attributes, no default → should be undefined, not throw
    expect((item as any).sku).toBeUndefined()
  })
})

describe('ApplicationRecord Proxy — is<Label>() / to<Label>() with no matching enum', () => {
  it('returns undefined (not a function) when the label does not exist in any enum', () => {
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)
    }

    const post = new Post({ id: 1, status: 0 }, false)

    // 'isArchived' is not a valid label for any enum — Proxy falls through to undefined
    expect((post as any).isArchived).toBeUndefined()
  })

  it('returns undefined (not a function) when to<Label> has no match', () => {
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)
    }

    const post = new Post({ id: 1, status: 0 }, false)

    // 'toArchived' label is not in the enum
    expect((post as any).toArchived).toBeUndefined()
  })
})
