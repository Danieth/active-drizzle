/**
 * Atomicity (save/destroy companion writes wrapped in one transaction),
 * optimistic-lock compare-and-swap, and nested-transaction afterCommit merge.
 */
import { describe, it, expect, vi } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, transaction, StaleObjectError } from '../../src/runtime/boot.js'
import { model, afterCommit } from '../../src/runtime/decorators.js'
import { hasMany, belongsTo } from '../../src/runtime/markers.js'
import { Attr } from '../../src/runtime/attr.js'

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, name: c, _name: c }
  return t
}

// ── save() atomicity wrap ─────────────────────────────────────────────────────

describe('save() wraps companion writes in a transaction', () => {
  @model('atom_children')
  class AtomChild extends ApplicationRecord {}
  void AtomChild
  @model('atom_orders')
  class AtomOrder extends ApplicationRecord {
    static children = hasMany('atom_children', { acceptsNested: true } as any)
  }
  @model('plain_orders')
  class PlainOrder extends ApplicationRecord {
    static title = Attr.string()
  }
  const schema = {
    atom_orders: fakeTable(['id']),
    atom_children: fakeTable(['id', 'atom_orderId', 'name']),
    plain_orders: fakeTable(['id', 'title']),
  }

  function makeDb(childRow: any) {
    const findMany = vi.fn(async () => (childRow ? [childRow] : []))
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany }) }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 10 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [childRow]) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return db
  }

  it('opens a transaction when there are nested-attribute companion writes', async () => {
    const db = makeDb({ id: 99, atom_orderId: 10, name: 'ok' })
    boot(db, schema)
    const ok = await new AtomOrder({ childrenAttributes: [{ id: 99, name: 'edit' }] }).save()
    expect(ok).toBe(true)
    expect(db.transaction).toHaveBeenCalledTimes(1)   // atomic parent + child
  })

  it('does NOT open a transaction for a plain single-statement save (no round-trip cost)', async () => {
    const db = makeDb(null)
    boot(db, schema)
    await new PlainOrder({ title: 'hi' }).save()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('a forged/foreign nested child id fails the save (422 shape) inside the wrap', async () => {
    // child belongs to order 777, not 10 → ownership gate rejects
    const db = makeDb({ id: 99, atom_orderId: 777, name: 'someone elses' })
    boot(db, schema)
    const order = new AtomOrder({ childrenAttributes: [{ id: 99, name: 'pwned' }] })
    expect(await order.save()).toBe(false)
    expect(db.transaction).toHaveBeenCalledTimes(1)   // the wrap ran (and rolled back)
    expect(db.update).not.toHaveBeenCalled()          // never re-parented
  })
})

// ── nested child update() result is checked ───────────────────────────────────

describe('invalid nested child update fails the whole save (no silent 200)', () => {
  @model('nv_items')
  class NvItem extends ApplicationRecord {
    static name = Attr.string({ validate: v => v ? null : 'is required' })
  }
  void NvItem
  @model('nv_orders')
  class NvOrder extends ApplicationRecord {
    static items = hasMany('nv_items', { acceptsNested: true } as any)
  }
  const schema = {
    nv_orders: fakeTable(['id']),
    nv_items: fakeTable(['id', 'nv_orderId', 'name']),
  }

  it('a child that fails validation surfaces as the parent save returning false', async () => {
    const childRow = { id: 5, nv_orderId: 10, name: 'Widget' }
    const findMany = vi.fn(async () => [childRow])
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany }) }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 10 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [childRow]) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, schema)
    // blank name → child validate() fails → child.update() returns false
    const order = new NvOrder({ itemsAttributes: [{ id: 5, name: '' }] })
    expect(await order.save()).toBe(false)
    expect(order.errors.all()).toHaveProperty('items')   // routed onto the association
  })
})

// ── destroy() cascade transactional ───────────────────────────────────────────

describe('destroy() cascade is transactional', () => {
  @model('dc_comments')
  class DcComment extends ApplicationRecord {}
  void DcComment
  @model('dc_posts')
  class DcPost extends ApplicationRecord {
    static comments = hasMany('dc_comments', { dependent: 'destroy' } as any)
  }
  const schema = {
    dc_posts: fakeTable(['id']),
    dc_comments: fakeTable(['id', 'dc_postId']),
  }

  it('wraps the child destroys + parent delete in one transaction', async () => {
    const findMany = vi.fn(async () => [{ id: 1, dc_postId: 1 }, { id: 2, dc_postId: 1 }])
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany }) }),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, schema)
    await new DcPost({ id: 1 }, false).destroy()
    expect(db.transaction).toHaveBeenCalledTimes(1)   // single outer wrap
    expect(db.delete).toHaveBeenCalledTimes(3)        // 2 children + parent
  })
})

// ── optimistic lock — compare-and-swap ────────────────────────────────────────

describe('optimistic locking (lockVersion) is compare-and-swap', () => {
  @model('ol_docs')
  class OlDoc extends ApplicationRecord {
    static title = Attr.string()
  }
  const schema = { ol_docs: fakeTable(['id', 'title', 'lockVersion']) }

  function makeDb(matched: boolean) {
    const sets: any[] = []
    const wheres: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn((s: any) => { sets.push(s); return { where: vi.fn((w: any) => { wheres.push(w); return { returning: vi.fn(async () => (matched ? [{ id: 1, ...s }] : [])) } }) } }) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, sets, wheres }
  }

  it('bumps the version in SET and adds the loaded version to WHERE', async () => {
    const { db, sets, wheres } = makeDb(true)
    boot(db, schema)
    const doc = new OlDoc({ id: 1, title: 'a', lockVersion: 3 }, false)
    ;(doc as any).title = 'b'
    expect(await doc.save()).toBe(true)
    expect(sets[0].lockVersion).toBe(4)          // bumped 3→4
    expect(wheres[0]).toBeDefined()              // compound WHERE (pk AND version)
  })

  it('raises StaleObjectError when the CAS matches zero rows (concurrent writer won)', async () => {
    const { db } = makeDb(false)   // UPDATE ... WHERE version=3 matches nothing
    boot(db, schema)
    const doc = new OlDoc({ id: 1, title: 'a', lockVersion: 3 }, false)
    ;(doc as any).title = 'b'
    await expect(doc.save()).rejects.toBeInstanceOf(StaleObjectError)
  })

  it('a model without a lockVersion column is unaffected (no version predicate)', async () => {
    @model('nolock_docs')
    class NoLock extends ApplicationRecord { static title = Attr.string() }
    const nlSchema = { nolock_docs: fakeTable(['id', 'title']) }
    const { db, sets } = makeDb(true)
    boot(db, nlSchema)
    const d = new NoLock({ id: 1, title: 'a' }, false)
    ;(d as any).title = 'b'
    expect(await d.save()).toBe(true)
    expect(sets[0]).not.toHaveProperty('lockVersion')
  })
})

// ── afterCommit in nested transactions ────────────────────────────────────────

describe('afterCommit callbacks survive nested transactions', () => {
  it('an @afterCommit queued in a nested tx fires after the OUTERMOST commit', async () => {
    const log: string[] = []
    @model('ac_posts')
    class AcPost extends ApplicationRecord {
      @afterCommit()
      notify() { log.push('committed') }
    }
    const db: any = {
      query: { ac_posts: { findMany: vi.fn(async () => []) } },
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, { ac_posts: fakeTable(['id', 'title']) })

    await transaction(async () => {
      await transaction(async () => {
        const p = new AcPost({}, true)
        ;(p as any).title = 'x'
        await p.save()
        expect(log).toHaveLength(0)   // deferred, not fired mid-tx
      })
      expect(log).toHaveLength(0)     // inner queue MERGED up, still deferred
    })
    expect(log).toEqual(['committed'])  // fires once, after the outer commit
  })
})

// ── the shared resolver's override + disable branches (save side) ─────────────

describe('save() CAS follows the RESOLVED locking column, not the literal convention', () => {
  function makeCaptureDb(matched: boolean) {
    const sets: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn((s: any) => { sets.push(s); return { where: vi.fn(() => ({ returning: vi.fn(async () => (matched ? [{ id: 1, ...s }] : [])) })) } }) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, sets }
  }

  it("a declared `static lockingColumn = 'rev'` is what bumps and guards (a hardcoded 'lockVersion' lookup would freeze it)", async () => {
    @model('rv_docs')
    class RvDoc extends ApplicationRecord {
      static lockingColumn = 'rev'
      static title = Attr.string()
    }
    const { db, sets } = makeCaptureDb(true)
    boot(db, { rv_docs: fakeTable(['id', 'title', 'rev']) })
    const doc = new RvDoc({ id: 1, title: 'a', rev: 6 }, false)
    ;(doc as any).title = 'b'
    expect(await doc.save()).toBe(true)
    expect(sets[0].rev).toBe(7)
    expect(sets[0]).not.toHaveProperty('lockVersion')
  })

  it("a declared `static lockingColumn = 'rev'` raises StaleObjectError on a stale copy", async () => {
    @model('rv2_docs')
    class Rv2Doc extends ApplicationRecord {
      static lockingColumn = 'rev'
      static title = Attr.string()
    }
    const { db } = makeCaptureDb(false)
    boot(db, { rv2_docs: fakeTable(['id', 'title', 'rev']) })
    const doc = new Rv2Doc({ id: 1, title: 'a', rev: 6 }, false)
    ;(doc as any).title = 'b'
    await expect(doc.save()).rejects.toBeInstanceOf(StaleObjectError)
  })

  it('`static lockingColumn = false` disables the CAS even when a lockVersion column exists', async () => {
    @model('off_docs')
    class OffDoc extends ApplicationRecord {
      static lockingColumn = false
      static title = Attr.string()
    }
    const { db, sets } = makeCaptureDb(true)
    boot(db, { off_docs: fakeTable(['id', 'title', 'lockVersion']) })
    const doc = new OffDoc({ id: 1, title: 'a', lockVersion: 3 }, false)
    ;(doc as any).title = 'b'
    expect(await doc.save()).toBe(true)
    expect(sets[0]).not.toHaveProperty('lockVersion')   // no bump — locking is off
  })
})

// ── destroy() rides the CAS too ───────────────────────────────────────────────

describe('destroy() is guarded by the lock column (a stale copy cannot silently hard-delete)', () => {
  function makeDeleteDb(deletedRows: any[]) {
    const deleteWheres: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      delete: vi.fn(() => ({ where: vi.fn((w: any) => { deleteWheres.push(w); const p: any = Promise.resolve([]); p.returning = vi.fn(async () => deletedRows); return p }) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, deleteWheres }
  }

  it('a stale copy raises StaleObjectError and stays un-destroyed', async () => {
    @model('dl_docs')
    class DlDoc extends ApplicationRecord { static title = Attr.string() }
    const { db } = makeDeleteDb([])   // CAS DELETE matches zero rows
    boot(db, { dl_docs: fakeTable(['id', 'title', 'lockVersion']) })
    const doc = new DlDoc({ id: 1, title: 'a', lockVersion: 3 }, false)
    await expect(doc.destroy()).rejects.toBeInstanceOf(StaleObjectError)
    expect((doc as any).isDestroyed).toBeFalsy()
  })

  it('a fresh copy destroys normally (the CAS matches)', async () => {
    @model('dl2_docs')
    class Dl2Doc extends ApplicationRecord { static title = Attr.string() }
    const { db } = makeDeleteDb([{ id: 1 }])
    boot(db, { dl2_docs: fakeTable(['id', 'title', 'lockVersion']) })
    const doc = new Dl2Doc({ id: 1, title: 'a', lockVersion: 3 }, false)
    expect(await doc.destroy()).toBe(true)
    expect((doc as any).isDestroyed).toBe(true)
  })

  it('a lockless model takes the plain DELETE path (no returning round-trip)', async () => {
    @model('dl3_docs')
    class Dl3Doc extends ApplicationRecord { static title = Attr.string() }
    // The plain path awaits .where() directly — a mock WITHOUT returning
    // support proves the guarded branch is never entered.
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, { dl3_docs: fakeTable(['id', 'title']) })
    const doc = new Dl3Doc({ id: 1, title: 'a' }, false)
    expect(await doc.destroy()).toBe(true)
  })
})

// ── counter-cache writes bump the parent's token in the SAME statement ────────

describe('counterCache bumps a lock-tokened parent token atomically with the count', () => {
  function makeCcDb() {
    const sets: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      insert: vi.fn(() => ({ values: vi.fn((v: any) => ({ returning: vi.fn(async () => [{ id: 7, ...v }]) })) })),
      update: vi.fn(() => ({ set: vi.fn((s: any) => { sets.push(s); return { where: vi.fn(async () => []) } }) })),
      delete: vi.fn(() => {
        const p: any = { where: vi.fn(() => { const q: any = Promise.resolve([]); q.returning = vi.fn(async () => [{ id: 7 }]); return q }) }
        return p
      }),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, sets }
  }

  @model('cc_locked_posts')
  class CcLockedPost extends ApplicationRecord {
    static comments = hasMany('cc_lc_comments', { counterCache: true } as any)
  }
  void CcLockedPost
  @model('cc_lc_comments')
  class CcLcComment extends ApplicationRecord {
    static post = belongsTo('cc_locked_posts')
  }
  const schema = {
    cc_locked_posts: fakeTable(['id', 'commentsCount', 'lockVersion']),
    cc_lc_comments: fakeTable(['id', 'postId', 'body']),
  }

  it('child create: ONE parent UPDATE carries counter + token together (a frozen token would keep certifying the stale count)', async () => {
    const { db, sets } = makeCcDb()
    boot(db, schema)
    const c = new CcLcComment({ postId: 5 }, true)
    expect(await c.save()).toBe(true)
    expect(sets).toHaveLength(1)                       // one statement, not a follow-up bump
    expect(sets[0]).toHaveProperty('commentsCount')
    expect(sets[0]).toHaveProperty('lockVersion')      // sql`lock_version + 1` rides the same SET
  })

  it('a lockless parent gets only the counter (no phantom token column)', async () => {
    @model('cc_plain_posts')
    class CcPlainPost extends ApplicationRecord {
      static comments = hasMany('cc_pl_comments', { counterCache: true } as any)
    }
    void CcPlainPost
    @model('cc_pl_comments')
    class CcPlComment extends ApplicationRecord {
      static post = belongsTo('cc_plain_posts')
    }
    const { db, sets } = makeCcDb()
    boot(db, {
      cc_plain_posts: fakeTable(['id', 'commentsCount']),
      cc_pl_comments: fakeTable(['id', 'postId']),
    })
    const c = new CcPlComment({ postId: 5 }, true)
    expect(await c.save()).toBe(true)
    expect(sets[0]).toHaveProperty('commentsCount')
    expect(sets[0]).not.toHaveProperty('lockVersion')
  })
})

// ── updateAll: the bump is IN the single generated statement ──────────────────

describe('updateAll bumps the resolved lock column in the SAME statement', () => {
  function makeBulkDb() {
    const sets: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      update: vi.fn(() => ({ set: vi.fn((s: any) => { sets.push(s); return { where: vi.fn(async () => ({ rowCount: 1 })) } }) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, sets }
  }

  it("the one .set() payload carries the data column AND `lockVersion + 1` — no second statement to race through", async () => {
    @model('ba_docs')
    class BaDoc extends ApplicationRecord { static title = Attr.string() }
    const { db, sets } = makeBulkDb()
    boot(db, { ba_docs: fakeTable(['id', 'title', 'lockVersion']) })
    await (BaDoc as any).all().updateAll({ title: 'bulk' })
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(sets).toHaveLength(1)
    expect(sets[0].title).toBe('bulk')
    expect(sets[0]).toHaveProperty('lockVersion')       // the sql`… + 1` expression, same SET
    expect(typeof sets[0].lockVersion).not.toBe('number') // an increment, not an absolute write
  })

  it("a declared `static lockingColumn = 'rev'` is the column bumped", async () => {
    @model('ba_rev_docs')
    class BaRevDoc extends ApplicationRecord {
      static lockingColumn = 'rev'
      static title = Attr.string()
    }
    const { db, sets } = makeBulkDb()
    boot(db, { ba_rev_docs: fakeTable(['id', 'title', 'rev', 'lockVersion']) })
    await (BaRevDoc as any).all().updateAll({ title: 'bulk' })
    expect(sets[0]).toHaveProperty('rev')
    expect(sets[0]).not.toHaveProperty('lockVersion')   // convention column ignored under an override
  })

  it('`static lockingColumn = false` suppresses the bump entirely', async () => {
    @model('ba_off_docs')
    class BaOffDoc extends ApplicationRecord {
      static lockingColumn = false
      static title = Attr.string()
    }
    const { db, sets } = makeBulkDb()
    boot(db, { ba_off_docs: fakeTable(['id', 'title', 'lockVersion']) })
    await (BaOffDoc as any).all().updateAll({ title: 'bulk' })
    expect(sets[0]).not.toHaveProperty('lockVersion')
  })
})
