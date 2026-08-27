/**
 * A failed save()/destroy() must leave the instance reflecting DB REALITY.
 *
 * runWritePhase flips isNewRecord / clears _changes / adopts the INSERT row
 * mid-phase; when the atomic wrap (or the ambient transaction) rolls the
 * writes back, the record must roll back with it. create()'s documented
 * contract — "still-unsaved (isNewRecord === true) on failure, callers gate
 * on isNewRecord" — must hold for post-INSERT rollbacks too, or the
 * controller's create() gate reports a phantom success for a row that does
 * not exist in the DB.
 *
 * Also: optimistic locking must never silently disable itself — a lockVersion
 * that is not a JS number (pg bigint/numeric strings, Dates, a partial SELECT
 * that omitted the column) is a teaching error, not a skipped predicate.
 */
import { describe, it, expect, vi } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, transaction, StaleObjectError } from '../../src/runtime/boot.js'
import { model, afterSave, afterDestroy } from '../../src/runtime/decorators.js'
import { hasMany } from '../../src/runtime/markers.js'
import { Attr } from '../../src/runtime/attr.js'

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, name: c, _name: c }
  return t
}

@model('rs_children')
class RsChild extends ApplicationRecord {}
void RsChild
@model('rs_orders')
class RsOrder extends ApplicationRecord {
  static children = hasMany('rs_children', { acceptsNested: true } as any)
  static title = Attr.string()
}

const schema = {
  rs_orders: fakeTable(['id', 'title']),
  rs_children: fakeTable(['id', 'rs_orderId', 'name', 'lockVersion']),
}

/** Mock drizzle db with per-call knobs for the failure being simulated. */
function makeDb(opts: {
  childRow?: any
  insertImpl?: () => Promise<any[]>
  updateImpl?: () => Promise<any[]>
} = {}) {
  const db: any = {
    query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => (opts.childRow ? [opts.childRow] : [])) }) }),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(opts.insertImpl ?? (async () => [{ id: 10 }])) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(opts.updateImpl ?? (async () => [opts.childRow])) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
    transaction: vi.fn((cb: any) => cb(db)),
  }
  return db
}

// ── create() rolled back by its own wrap ──────────────────────────────────────

describe('failed create: the wrap rolls back → the instance rolls back with it', () => {
  it('forged nested child id: save() is false AND isNewRecord stays true (no phantom)', async () => {
    // child belongs to order 777, not the new order 10 → ownership gate throws
    // inside the wrap → the parent INSERT is rolled back
    const db = makeDb({ childRow: { id: 99, rs_orderId: 777, name: 'not-ours' } })
    boot(db, schema)
    const order = new RsOrder({ title: 'x', childrenAttributes: [{ id: 99, name: 'pwn' }] })

    expect(await order.save()).toBe(false)
    expect(order.errors.all()).toHaveProperty('children')
    // DB reality: the row does not exist. The instance must say so.
    expect(order.isNewRecord).toBe(true)
    expect(order._attributes['id']).toBeUndefined()   // did not adopt the rolled-back INSERT row
    expect((order as any).title).toBe('x')            // pre-save attributes intact
  })

  it('dirty _changes survive the failed save (the record is retryable)', async () => {
    const db = makeDb({ childRow: { id: 99, rs_orderId: 777, name: 'not-ours' } })
    boot(db, schema)
    const order = new RsOrder({ childrenAttributes: [{ id: 99, name: 'pwn' }] })
    ;(order as any).title = 'assigned-later'

    expect(await order.save()).toBe(false)
    expect(order.changedFields()).toContain('title')
    expect((order as any).title).toBe('assigned-later')
  })

  it('a translated DB error during a companion write also restores the state', async () => {
    // Child IS owned (rs_orderId matches the new parent id 10), but its UPDATE
    // hits a unique violation → rethrown inside the wrap → rollback → 422 shape
    const db = makeDb({
      childRow: { id: 99, rs_orderId: 10, name: 'ours', lockVersion: 1 },
      updateImpl: async () => { throw Object.assign(new Error('duplicate'), { code: '23505', detail: 'Key (name)=(pwn) already exists.' }) },
    })
    boot(db, schema)
    const order = new RsOrder({ title: 'x', childrenAttributes: [{ id: 99, name: 'pwn' }] })

    expect(await order.save()).toBe(false)
    expect(order.isNewRecord).toBe(true)
    expect(order._attributes['id']).toBeUndefined()
  })

  it('a StaleObjectError from a companion write restores state before rethrowing', async () => {
    // Owned child with lockVersion → its CAS UPDATE matches zero rows → Stale
    // thrown mid-write-phase, after the parent INSERT already flipped state
    const db = makeDb({
      childRow: { id: 99, rs_orderId: 10, name: 'ours', lockVersion: 3 },
      updateImpl: async () => [],
    })
    boot(db, schema)
    const order = new RsOrder({ title: 'x', childrenAttributes: [{ id: 99, name: 'edit' }] })

    await expect(order.save()).rejects.toBeInstanceOf(StaleObjectError)
    expect(order.isNewRecord).toBe(true)
    expect(order._attributes['id']).toBeUndefined()
  })
})

// ── inside an ambient same-db transaction ─────────────────────────────────────

describe('failed nested write inside an ambient transaction', () => {
  it('rethrows (aborting the tx) instead of returning false over a pending orphan INSERT', async () => {
    const db = makeDb({ childRow: { id: 99, rs_orderId: 777, name: 'not-ours' } })
    boot(db, schema)
    let order: any
    await expect(transaction(async () => {
      order = new RsOrder({ title: 'x', childrenAttributes: [{ id: 99, name: 'pwn' }] })
      await order.save()
    })).rejects.toThrow(/not part of this record's/)
    // the tx rolled back — the instance reflects that
    expect(order.isNewRecord).toBe(true)
    expect(order._attributes['id']).toBeUndefined()
    expect(order.errors.all()).toHaveProperty('children')
  })
})

// ── the UNWRAPPED single-statement path is excluded from the restore ──────────

describe('unwrapped saves keep matching DB reality', () => {
  @model('rs_plain')
  class RsPlain extends ApplicationRecord {
    static title = Attr.string()
  }
  @model('rs_hooked')
  class RsHooked extends ApplicationRecord {
    static title = Attr.string()
    @afterSave()
    boom() { throw new Error('hook-boom') }
  }
  const plainSchema = {
    rs_plain: fakeTable(['id', 'title']),
    rs_hooked: fakeTable(['id', 'title']),
  }

  it('a failing plain INSERT keeps isNewRecord true (nothing was flipped)', async () => {
    const db = makeDb({ insertImpl: async () => { throw Object.assign(new Error('dup'), { code: '23505', detail: 'Key (title)=(x) already exists.' }) } })
    boot(db, plainSchema)
    const p = new RsPlain({ title: 'x' })
    expect(await p.save()).toBe(false)
    expect(p.isNewRecord).toBe(true)
  })

  it('an afterSave throw AFTER a durable unwrapped INSERT does NOT restore (the row exists)', async () => {
    const db = makeDb({})
    boot(db, plainSchema)
    const p = new RsHooked({ title: 'x' })
    await expect(p.save()).rejects.toThrow('hook-boom')
    // no wrap, no ambient tx: the INSERT committed — the instance must keep saying so
    expect(p.isNewRecord).toBe(false)
    expect(p._attributes['id']).toBe(10)
  })
})

// ── destroy() — same contract ─────────────────────────────────────────────────

describe('failed destroy: the wrap rolls back → isDestroyed rolls back with it', () => {
  @model('rs_cascade_children')
  class RsCascadeChild extends ApplicationRecord {}
  void RsCascadeChild
  @model('rs_cascade_posts')
  class RsCascadePost extends ApplicationRecord {
    static comments = hasMany('rs_cascade_children', { dependent: 'destroy' } as any)
    @afterDestroy()
    boom() { throw new Error('destroy-hook-boom') }
  }
  const dSchema = {
    rs_cascade_posts: fakeTable(['id']),
    rs_cascade_children: fakeTable(['id', 'rs_cascade_postId']),
  }

  it('an error inside the destroy wrap restores isDestroyed', async () => {
    const findMany = vi.fn(async () => [])
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany }) }),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, dSchema)
    const p = new RsCascadePost({ id: 1 }, false)
    await expect(p.destroy()).rejects.toThrow('destroy-hook-boom')
    expect((p as any).isDestroyed).toBeFalsy()   // the DELETE rolled back
  })
})

// ── optimistic locking: silent self-disable becomes a teaching error ──────────

describe('optimistic locking never silently disables itself', () => {
  @model('tl_docs')
  class TlDoc extends ApplicationRecord {
    static title = Attr.string()
  }
  @model('tl_stamps')
  class TlStamp extends ApplicationRecord {
    static lockingColumn = 'updatedAt'
    static title = Attr.string()
  }
  const lockSchema = {
    tl_docs: fakeTable(['id', 'title', 'lockVersion']),
    tl_stamps: fakeTable(['id', 'title', 'updatedAt']),
  }

  function makeCaptureDb() {
    const sets: any[] = []
    const db: any = {
      query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })),
      update: vi.fn(() => ({ set: vi.fn((s: any) => { sets.push(s); return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1, ...s }]) })) } }) })),
      delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return { db, sets }
  }

  it('a string version (pg bigint/numeric driver value) is a teaching error, not a skipped CAS', async () => {
    const { db } = makeCaptureDb()
    boot(db, lockSchema)
    const doc = new TlDoc({ id: 1, title: 'a', lockVersion: '3' }, false)
    ;(doc as any).title = 'b'
    await expect(doc.save()).rejects.toThrow(/lockVersion.*number/s)
  })

  it('a record loaded WITHOUT its locking column (partial select) is a teaching error', async () => {
    const { db } = makeCaptureDb()
    boot(db, lockSchema)
    const doc = new TlDoc({ id: 1, title: 'a' }, false)   // lockVersion never selected
    ;(doc as any).title = 'b'
    await expect(doc.save()).rejects.toThrow(/lockVersion/)
  })

  it('a non-number lockingColumn override (Date/timestamp) is a teaching error', async () => {
    const { db } = makeCaptureDb()
    boot(db, lockSchema)
    const s = new TlStamp({ id: 1, title: 'a', updatedAt: new Date() }, false)
    ;(s as any).title = 'b'
    await expect(s.save()).rejects.toThrow(/updatedAt.*number/s)
  })

  it('explicitly assigning the locking column still bypasses the CAS (escape hatch)', async () => {
    const { db, sets } = makeCaptureDb()
    boot(db, lockSchema)
    const doc = new TlDoc({ id: 1, title: 'a', lockVersion: '3' }, false)
    ;(doc as any).title = 'b'
    ;(doc as any).lockVersion = 10
    expect(await doc.save()).toBe(true)
    expect(sets[0].lockVersion).toBe(10)
  })
})
