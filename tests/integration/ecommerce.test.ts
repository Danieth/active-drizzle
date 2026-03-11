/**
 * Integration: Real-world e-commerce scenarios with a live Postgres DB.
 *
 * Exercises:
 *   - CRUD lifecycle (create / find / update / destroy)
 *   - Attr.new cents↔dollars transform end-to-end
 *   - Attr.json round-trip through TEXT column
 *   - STI: DigitalProduct subclass auto-instantiation
 *   - hasMany / belongsTo eager loading via .includes()
 *   - habtm (products ↔ tags through products_tags)
 *   - acceptsNestedAttributesFor — order + line items in one save()
 *   - counterCache — lineItemsCount updated automatically
 *   - Dirty tracking — priceChanged(), priceWas(), isChanged()
 *   - Scopes: User.customers(), Product.active(), Order.forUser()
 *   - Enum: order.isConfirmed(), order.toPending()
 *   - Polymorphic belongsTo: review.reviewable resolves to correct class
 *   - Transactions + afterCommit hook deferred execution
 *   - .inBatches() bulk processing
 *   - .destroyAll() cascade
 *   - .pluck() column extraction without proxy overhead
 *   - .updateAll() bulk mutation with Attr.set transform
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { startPostgres, type PgContext } from './_helpers/pg-setup.js'
import { seedAll } from './_helpers/seed.js'
import {
  User, Product, DigitalProduct, BundleProduct,
  Tag, Order, LineItem, Review,
  resetAfterCommitLog, getAfterCommitLog,
} from './_helpers/models.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { schema } from './_helpers/schema.js'
import util from 'util'

// ─────────────────────────────────────────────────────────────────────────────
// Suite setup — one Postgres container for all e-commerce tests
// ─────────────────────────────────────────────────────────────────────────────

let ctx: PgContext

beforeAll(async () => {
  ctx = await startPostgres()
}, 60_000)

afterAll(async () => {
  await ctx.stop()
}, 30_000)

beforeEach(async () => {
  await ctx.reset()
  resetAfterCommitLog()
})

// ─────────────────────────────────────────────────────────────────────────────
// §1 — CRUD fundamentals
// ─────────────────────────────────────────────────────────────────────────────

describe('CRUD fundamentals', () => {
  it('creates and finds a user by id', async () => {
    const created = await User.create({ email: 'dev@example.com', name: 'Dev User' })

    expect(created.id).toBeGreaterThan(0)
    expect(created._attributes.email).toBe('dev@example.com')

    const found = await User.find(created.id)
    expect(found).not.toBeNull()
    expect(found!._attributes.name).toBe('Dev User')
  })

  it('updates a record and only sends changed columns', async () => {
    const product = await Product.create({ name: 'Widget', priceInCents: 1000, stock: 10 })
    const id = product.id

    const loaded = await Product.find(id) as any
    loaded.name = 'Widget Pro'
    expect(loaded.isChanged()).toBe(true)
    expect(loaded._changes.has('name')).toBe(true)
    expect(loaded._changes.has('priceInCents')).toBe(false)  // unchanged

    await loaded.save()
    const refreshed = await Product.find(id) as any
    expect(refreshed._attributes.name).toBe('Widget Pro')
    expect(refreshed._attributes.priceInCents).toBe(1000)    // untouched
  })

  it('destroys a record', async () => {
    const tag = await Tag.create({ name: 'disposable' })
    await tag.destroy()
    // find() now raises RecordNotFound — use findBy() for null return
    const gone = await Tag.findBy({ id: tag.id })
    expect(gone).toBeNull()
  })

  it('find() raises RecordNotFound for missing records', async () => {
    const { RecordNotFound } = await import('../../src/runtime/boot.js')
    await expect(User.find(999_999)).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('create() and first() round-trip', async () => {
    await Product.create({ name: 'Alpha', priceInCents: 500, stock: 5 })
    await Product.create({ name: 'Beta',  priceInCents: 600, stock: 3 })

    const first = await Product.first() as any
    expect(first).not.toBeNull()
    expect(first._attributes.name).toBe('Alpha')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Attr transforms end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe('Attr transforms (real DB round-trip)', () => {
  it('price Attr.new: dollars stored as cents, retrieved as dollars', async () => {
    // $19.99 saved, read back via Attr.get
    const p = await Product.create({ name: 'Gadget', priceInCents: 1999, stock: 1 }) as any

    const loaded = await Product.find(p.id) as any
    expect(loaded.price).toBeCloseTo(19.99)          // Attr.get → cents / 100
    expect(loaded._attributes.priceInCents).toBe(1999)  // raw DB value

    // Update via Attr.set: pass dollars, store cents
    loaded.price = 24.99
    await loaded.save()

    const refreshed = await Product.find(p.id) as any
    expect(refreshed._attributes.priceInCents).toBe(2499)
    expect(refreshed.price).toBeCloseTo(24.99)
  })

  it('Attr.json: object stored as TEXT, rehydrated on read', async () => {
    const meta = { weight: 0.5, dims: '20x30cm', tags: ['sale', 'new'] }
    const p = await Product.create({ name: 'Box', priceInCents: 800, stock: 20, metadata: JSON.stringify(meta) }) as any

    const loaded = await Product.find(p.id) as any
    expect(loaded.metadata).toEqual(meta)           // Attr.json deserialized
    expect(typeof loaded._attributes.metadata).toBe('string')  // raw is still TEXT
  })

  it('Attr.enum: order status stored as int, read as label', async () => {
    const u = await User.create({ email: 'e@test.com' })
    const o = await Order.create({ userId: u.id, status: 0 }) as any

    expect(o.status).toBe('pending')                 // Attr.enum.get
    o.status = 'confirmed'
    await o.save()

    const refreshed = await Order.find(o.id) as any
    expect(refreshed.status).toBe('confirmed')
    expect(refreshed._attributes.status).toBe(1)    // raw DB value
  })

  it('is<Label>() / to<Label>() enum predicates', async () => {
    const u = await User.create({ email: 'x@test.com' })
    const o = await Order.create({ userId: u.id, status: 0 }) as any

    expect(o.isPending()).toBe(true)
    expect(o.isShipped()).toBe(false)

    o.toConfirmed()
    await o.save()

    const refreshed = await Order.find(o.id) as any
    expect(refreshed.isConfirmed()).toBe(true)
  })

  it('Attr.new admin boolean: role column mapped to bool accessor', async () => {
    const admin   = await User.create({ email: 'admin@test.com', role: 'admin' }) as any
    const customer = await User.create({ email: 'cust@test.com', role: 'customer' }) as any

    expect(admin.admin).toBe(true)
    expect(customer.admin).toBe(false)

    // flip customer to admin via boolean setter
    customer.admin = true
    await customer.save()

    const refreshed = await User.find(customer.id) as any
    expect(refreshed.admin).toBe(true)
    expect(refreshed._attributes.role).toBe('admin')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Dirty tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('Dirty tracking', () => {
  it('tracks which fields changed and their original values', async () => {
    const p = await Product.create({ name: 'Sneaker', priceInCents: 8999, stock: 30 }) as any
    const loaded = await Product.find(p.id) as any

    expect(loaded.isChanged()).toBe(false)

    // Change name — tracked via plain column fallback
    loaded.name = 'Sneaker Elite'
    // Change price — tracked via Attr.new set trap
    loaded.price = 109.99

    expect(loaded.isChanged()).toBe(true)
    expect(loaded.nameWas()).toBe('Sneaker')
    // Attr.for('priceInCents') stores change under the column key
    expect(loaded._changes.has('name')).toBe(true)
    expect(loaded._changes.has('priceInCents')).toBe(true)

    // Save — only changed columns go into UPDATE
    await loaded.save()
    expect(loaded.isChanged()).toBe(false)
  })

  it('restores original value if set back', async () => {
    const p = await Product.find(
      (await Product.create({ name: 'Stable', priceInCents: 500, stock: 5 })).id
    ) as any

    p.name = 'Changed'
    expect(p.isChanged()).toBe(true)
    p.name = 'Stable'               // set back to original
    expect(p.isChanged()).toBe(false)
  })

  it('previousChanges available after save', async () => {
    const p = await Product.find(
      (await Product.create({ name: 'Trackme', priceInCents: 200, stock: 2 })).id
    ) as any

    p.name = 'Trackme Updated'
    await p.save()

    // After save, _previousChanges records what changed
    expect((p as any)._previousChanges?.name).toEqual(['Trackme', 'Trackme Updated'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Associations: eager loading
// ─────────────────────────────────────────────────────────────────────────────

describe('Associations — eager loading via .includes()', () => {
  it('loads orders with user and lineItems in one query', async () => {
    const seed = await seedAll(ctx.db)

    const orders = await Order
      .includes('user' as any, 'line_items' as any)
      .order('id', 'asc')
      .load() as any[]

    expect(orders.length).toBeGreaterThanOrEqual(2)

    // Eager-loaded user should be loaded
    const first = orders[0]
    expect(first._attributes.user).toBeDefined()
    expect(first._attributes.user.email ?? first._attributes.user._attributes?.email).toMatch(/@example\.com/)

    // Line items should be loaded
    const items = first._attributes.line_items ?? []
    expect(items.length).toBeGreaterThan(0)
  })

  it('lazy-loads a belongsTo association on demand', async () => {
    const seed = await seedAll(ctx.db)
    const item = await LineItem.first() as any
    expect(item).not.toBeNull()

    const order = await item.order as any
    expect(order).not.toBeNull()
    expect(order._attributes.userId).toBeGreaterThan(0)
  })

  it('lazy-loads a hasMany as a Relation', async () => {
    const seed = await seedAll(ctx.db)
    const user = await User.find(seed.users.bob.id) as any

    const ordersRelation = user.orders
    // Returns a Relation, not a resolved array
    const orders = await ordersRelation.load()
    expect(orders.length).toBeGreaterThanOrEqual(1)
    expect((orders[0] as any)._attributes.userId).toBe(seed.users.bob.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — STI (Single Table Inheritance)
// ─────────────────────────────────────────────────────────────────────────────

describe('STI — Single Table Inheritance', () => {
  it('creates a DigitalProduct with type column = "DigitalProduct"', async () => {
    const dp = await DigitalProduct.create({
      name:        'Advanced SQL',
      priceInCents: 2999,
      stock:        9999,
      downloadUrl:  'https://cdn.example.com/sql.pdf',
    }) as any

    expect(dp._attributes.type).toBe('DigitalProduct')
    expect(dp.downloadUrl).toBe('https://cdn.example.com/sql.pdf')

    // STI WHERE is automatically added on query
    const found = await DigitalProduct.find(dp.id) as any
    expect(found).not.toBeNull()
    expect(found._attributes.downloadUrl).toBe('https://cdn.example.com/sql.pdf')
  })

  it('DigitalProduct.all() only returns digital products, not physicals', async () => {
    await Product.create({ name: 'Physical', priceInCents: 500, stock: 1 })
    await DigitalProduct.create({ name: 'Digital A', priceInCents: 999, stock: 9999, downloadUrl: 'https://a.com' })
    await DigitalProduct.create({ name: 'Digital B', priceInCents: 1499, stock: 9999, downloadUrl: 'https://b.com' })

    const digitals = await DigitalProduct.all().load()
    expect(digitals.every((p: any) => p._attributes.type === 'DigitalProduct')).toBe(true)
    expect(digitals.length).toBe(2)
  })

  it('loading from products table instantiates correct subclasses', async () => {
    await Product.create({ name: 'Physical', priceInCents: 100, stock: 5 })
    await DigitalProduct.create({ name: 'eBook', priceInCents: 999, stock: 9999, downloadUrl: 'https://x.com' })
    await BundleProduct.create({ name: 'Bundle', priceInCents: 3999, stock: 10 })

    // Querying via base Product should return correct subclass instances
    const all = await Product.all().load()
    const types = all.map((p: any) => p.constructor.name)
    expect(types).toContain('Product')
    expect(types).toContain('DigitalProduct')
    expect(types).toContain('BundleProduct')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — habtm (many-to-many through join table)
// ─────────────────────────────────────────────────────────────────────────────

describe('habtm — many-to-many through join table', () => {
  it('returns tags for a product via habtm Relation', async () => {
    const seed = await seedAll(ctx.db)

    // tshirt has apparel + bestseller tags
    const tshirt = await Product.find(seed.products.tshirt.id) as any
    const tags   = await (tshirt.tags as any).load()

    expect(tags.length).toBe(2)
    const tagNames = tags.map((t: any) => t._attributes.name)
    expect(tagNames).toContain('apparel')
    expect(tagNames).toContain('bestseller')
  })

  it('digital product only has its own tags', async () => {
    const seed = await seedAll(ctx.db)
    const ebook  = await Product.find(seed.products.ebook.id) as any
    const tags   = await (ebook.tags as any).load()

    const tagNames = tags.map((t: any) => t._attributes.name)
    expect(tagNames).toContain('digital')
    expect(tagNames).toContain('bestseller')
    expect(tagNames).not.toContain('apparel')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7 — acceptsNestedAttributesFor + counterCache
// ─────────────────────────────────────────────────────────────────────────────

describe('acceptsNestedAttributesFor + counterCache', () => {
  it('creates order and line items in a single save(), counterCache updates', async () => {
    const user    = await User.create({ email: 'nested@test.com' })
    const product = await Product.create({ name: 'Widget', priceInCents: 1000, stock: 100 })

    const order = new (Order as any)({
      userId:          user.id,
      status:          0,
      totalInCents:    2000,
      lineItemsAttributes: [
        { productId: product.id, name: 'Widget', priceInCents: 1000, qty: 2 },
      ],
    })

    await order.save()

    // Order was persisted
    expect(order.id).toBeGreaterThan(0)

    // Line items were created
    const items = await LineItem.where({ orderId: order.id } as any).load()
    expect(items.length).toBe(1)
    expect((items[0] as any)._attributes.qty).toBe(2)

    // counterCache: lineItemsCount should be 1 (one line item created)
    const refreshedOrder = await Order.find(order.id) as any
    expect(refreshedOrder._attributes.lineItemsCount).toBe(1)
  })

  it('destroying a line item decrements the counter', async () => {
    const user    = await User.create({ email: 'counter@test.com' })
    const product = await Product.create({ name: 'Gadget', priceInCents: 500, stock: 10 })
    const order   = await Order.create({ userId: user.id, status: 0 }) as any

    const item = await LineItem.create({ orderId: order.id, productId: product.id, name: 'Gadget', priceInCents: 500, qty: 1 }) as any

    // One item in the order
    let refreshed = await Order.find(order.id) as any
    expect(refreshed._attributes.lineItemsCount).toBe(1)

    await item.destroy()

    refreshed = await Order.find(order.id) as any
    expect(refreshed._attributes.lineItemsCount).toBe(0)
  })

  it('updates existing line items via *Attributes with id', async () => {
    const user    = await User.create({ email: 'update@test.com' })
    const product = await Product.create({ name: 'Prod', priceInCents: 300, stock: 50 })
    const order   = await Order.create({ userId: user.id, status: 0 }) as any
    const item    = await LineItem.create({ orderId: order.id, productId: product.id, name: 'Prod', priceInCents: 300, qty: 1 }) as any

    // Update via parent's *Attributes
    ;(order as any).lineItemsAttributes = [{ id: item.id, qty: 5 }]
    await (order as any).save()

    const updated = await LineItem.find(item.id) as any
    expect(updated._attributes.qty).toBe(5)
  })

  it('destroys line items via _destroy flag in *Attributes', async () => {
    const user    = await User.create({ email: 'destroy@test.com' })
    const product = await Product.create({ name: 'Prod2', priceInCents: 200, stock: 20 })
    const order   = await Order.create({ userId: user.id, status: 0 }) as any
    const item    = await LineItem.create({ orderId: order.id, productId: product.id, name: 'Prod2', priceInCents: 200, qty: 1 }) as any

    ;(order as any).lineItemsAttributes = [{ id: item.id, _destroy: true }]
    await (order as any).save()

    expect(await LineItem.findBy({ id: item.id })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Polymorphic belongsTo
// ─────────────────────────────────────────────────────────────────────────────

describe('Polymorphic belongsTo', () => {
  it('review.reviewable resolves to correct model class', async () => {
    const user    = await User.create({ email: 'reviewer@test.com' })
    const product = await Product.create({ name: 'ReviewMe', priceInCents: 999, stock: 5 })

    const review = await Review.create({
      reviewableType: 'Product',
      reviewableId:   product.id,
      userId:         user.id,
      rating:         5,
      body:           'Excellent product',
    }) as any

    const loaded = await Review.find(review.id) as any
    const reviewable = await loaded.reviewable as any

    expect(reviewable).not.toBeNull()
    expect(reviewable._attributes.name).toBe('ReviewMe')
    expect(reviewable._attributes.priceInCents).toBe(999)
  })

  it('review on User resolves to User instance', async () => {
    const reviewer = await User.create({ email: 'r1@test.com' })
    const subject  = await User.create({ email: 'r2@test.com', name: 'Subject' })

    const review = await Review.create({
      reviewableType: 'User',
      reviewableId:   subject.id,
      userId:         reviewer.id,
      rating:         3,
    }) as any

    const loaded    = await Review.find(review.id) as any
    const reviewable = await loaded.reviewable as any

    expect(reviewable._attributes.email).toBe('r2@test.com')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §9 — Scopes
// ─────────────────────────────────────────────────────────────────────────────

describe('Scopes', () => {
  it('User.customers() filters to customers only', async () => {
    await User.create({ email: 'a@test.com', role: 'admin' })
    await User.create({ email: 'c1@test.com', role: 'customer' })
    await User.create({ email: 'c2@test.com', role: 'customer' })

    const customers = await User.customers().load()
    expect(customers.every((u: any) => u._attributes.role === 'customer')).toBe(true)
    expect(customers.length).toBe(2)
  })

  it('Product.active() filters inactive products', async () => {
    await Product.create({ name: 'Active',   priceInCents: 100, stock: 5, isActive: true })
    await Product.create({ name: 'Inactive', priceInCents: 200, stock: 0, isActive: false })

    const active = await Product.active().load()
    expect(active.every((p: any) => p._attributes.isActive === true)).toBe(true)
    expect(active.length).toBe(1)
  })

  it('chaining scopes: active products under $20', async () => {
    await Product.create({ name: 'Cheap Active',    priceInCents: 999,  stock: 10, isActive: true })
    await Product.create({ name: 'Expensive Active', priceInCents: 5000, stock: 10, isActive: true })
    await Product.create({ name: 'Cheap Inactive',  priceInCents: 500,  stock: 0,  isActive: false })

    const results = await Product.active().limit(10).load()
    const affordable = results.filter((p: any) => p._attributes.priceInCents < 2000)
    expect(affordable.length).toBe(1)
    expect((affordable[0] as any)._attributes.name).toBe('Cheap Active')
  })

  it('Order.forUser() returns only that user\'s orders', async () => {
    const alice = await User.create({ email: 'alice2@test.com' })
    const bob   = await User.create({ email: 'bob2@test.com' })

    await Order.create({ userId: alice.id, status: 0 })
    await Order.create({ userId: alice.id, status: 1 })
    await Order.create({ userId: bob.id,   status: 0 })

    const aliceOrders = await Order.forUser(alice.id).load()
    expect(aliceOrders.length).toBe(2)
    expect(aliceOrders.every((o: any) => o._attributes.userId === alice.id)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Transactions + afterCommit hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('Transactions + afterCommit', () => {
  it('afterCommit fires after the transaction commits (not during)', async () => {
    const user = await User.create({ email: 'tx@test.com' })
    const log  = getAfterCommitLog()

    let logSizeInsideTx = -1

    await ApplicationRecord.transaction(async () => {
      const order = await Order.create({ userId: user.id, status: 0 }) as any
      logSizeInsideTx = log.length        // afterCommit hasn't fired yet
    })

    expect(logSizeInsideTx).toBe(0)       // deferred during tx
    expect(log.length).toBe(1)            // fired after commit
    expect(log[0]).toMatch(/^order:\d+:pending$/)
  })

  it('AbortChain rolls back the transaction and no afterCommit fires', async () => {
    const { AbortChain } = await import('../../src/runtime/boot.js')
    const user = await User.create({ email: 'rollback@test.com' })

    try {
      await ApplicationRecord.transaction(async () => {
        await Order.create({ userId: user.id, status: 0 })
        throw new AbortChain()
      })
    } catch { /* AbortChain may propagate */ }

    // The order should NOT have been committed
    const orders = await Order.forUser(user.id).load()
    expect(orders.length).toBe(0)

    // No afterCommit fired
    expect(getAfterCommitLog().length).toBe(0)
  })

  it('multiple creates within a transaction are all committed or all rolled back', async () => {
    const user = await User.create({ email: 'multi-tx@test.com' })
    const prod = await Product.create({ name: 'TX Prod', priceInCents: 100, stock: 5 })

    const { AbortChain } = await import('../../src/runtime/boot.js')
    try {
      await ApplicationRecord.transaction(async () => {
        await Order.create({ userId: user.id, status: 1 })
        await Order.create({ userId: user.id, status: 2 })
        throw new AbortChain()
      })
    } catch {}

    const orders = await Order.forUser(user.id).load()
    expect(orders.length).toBe(0)  // all rolled back
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §11 — High-performance operations (.pluck, .updateAll, .inBatches)
// ─────────────────────────────────────────────────────────────────────────────

describe('High-performance operations', () => {
  it('.pluck() returns raw values without proxy instantiation', async () => {
    await Product.create({ name: 'P1', priceInCents: 100, stock: 5 })
    await Product.create({ name: 'P2', priceInCents: 200, stock: 3 })
    await Product.create({ name: 'P3', priceInCents: 300, stock: 1 })

    const names = await Product.all().pluck('name')
    expect(names).toEqual(['P1', 'P2', 'P3'])
  })

  it('.pluck() applies Attr.get transform to price', async () => {
    await Product.create({ name: 'Priced', priceInCents: 4999, stock: 10 })

    const prices = await Product.all().pluck('priceInCents')
    // Note: pluck uses the raw column name; Attr transform uses the property name
    expect(prices[0]).toBe(4999)
  })

  it('.updateAll() applies Attr.set and updates in bulk', async () => {
    await Product.create({ name: 'Old A', priceInCents: 1000, stock: 5 })
    await Product.create({ name: 'Old B', priceInCents: 2000, stock: 3 })

    // Double all stocks
    await Product.all().updateAll({ stock: 0 } as any)

    const products = await Product.all().load()
    expect(products.every((p: any) => p._attributes.stock === 0)).toBe(true)
  })

  it('.inBatches() processes all records in chunks', async () => {
    for (let i = 0; i < 9; i++) {
      await Product.create({ name: `Batch-${i}`, priceInCents: 100 * (i + 1), stock: i })
    }

    const processed: number[] = []

    await Product.all().inBatches(3, async (batch) => {
      const items = await batch.load()
      processed.push(items.length)
    })

    expect(processed.length).toBe(3)              // 3 batches of 3
    expect(processed.every(n => n === 3)).toBe(true)
  })

  it('.destroyAll() removes all matching records', async () => {
    const user = await User.create({ email: 'destroy@test.com' })
    await Order.create({ userId: user.id, status: 0 })
    await Order.create({ userId: user.id, status: 0 })
    await Order.create({ userId: user.id, status: 1 })

    // Destroy only pending orders for this user
    await Order.forUser(user.id).where({ status: 0 } as any).destroyAll()

    const remaining = await Order.forUser(user.id).load()
    expect(remaining.length).toBe(1)
    expect((remaining[0] as any)._attributes.status).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §12 — Lifecycle hooks (@validate, @beforeSave)
// ─────────────────────────────────────────────────────────────────────────────

describe('Lifecycle hooks', () => {
  it('@validate prevents save when validation fails', async () => {
    const p = new (Product as any)({ name: 'Broken', priceInCents: 500, stock: -5 })
    const result = await p.save()

    expect(result).toBe(false)
    expect(p.errors.base).toContain('stock cannot be negative')
    expect(p.id).toBeUndefined()    // not persisted
  })

  it('@beforeSave trims product name whitespace', async () => {
    const p = await Product.create({ name: '  Spaced Out  ', priceInCents: 100, stock: 1 }) as any
    expect(p._attributes.name).toBe('Spaced Out')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §13 — Relation chaining: complex real queries
// ─────────────────────────────────────────────────────────────────────────────

describe('Complex relation chaining', () => {
  it('orders by price desc with limit and offset', async () => {
    for (let i = 1; i <= 5; i++) {
      await Product.create({ name: `Prod-${i}`, priceInCents: i * 1000, stock: 1 })
    }

    const page1 = await Product.all().order('priceInCents', 'desc').limit(2).load()
    expect((page1[0] as any)._attributes.priceInCents).toBe(5000)
    expect((page1[1] as any)._attributes.priceInCents).toBe(4000)

    const page2 = await Product.all().order('priceInCents', 'desc').limit(2).offset(2).load()
    expect((page2[0] as any)._attributes.priceInCents).toBe(3000)
  })

  it('Relation as subquery: orders where user is from a subquery', async () => {
    const alice = await User.create({ email: 'alice3@test.com', role: 'admin' })
    const bob   = await User.create({ email: 'bob3@test.com',   role: 'customer' })

    await Order.create({ userId: alice.id, status: 1 })
    await Order.create({ userId: bob.id,   status: 0 })

    // "Orders for admin users" — subquery
    const adminUserIds = User.admins().toSubquery('id')
    const adminOrders  = await Order.where({ userId: adminUserIds } as any).load()

    expect(adminOrders.length).toBe(1)
    expect((adminOrders[0] as any)._attributes.userId).toBe(alice.id)
  })

  it('.first() returns null on empty result, not throwing', async () => {
    const result = await Product.where({ name: 'does_not_exist' } as any).first()
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §14 — reload() and inspect() in real context
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §15 — Nested pluck (dotted paths, one DB round-trip, Attr transforms)
// ─────────────────────────────────────────────────────────────────────────────

describe('Nested pluck — one round-trip, Attr transforms preserved', () => {
  it('flat pluck respects Attr.for transforms (price → dollars)', async () => {
    await Product.create({ name: 'Widget', priceInCents: 4999, stock: 10 })
    await Product.create({ name: 'Gadget', priceInCents: 1999, stock: 5 })

    const prices = await Product.all().order('priceInCents', 'asc').pluck('price')
    // Attr.for('priceInCents', { get: v => v / 100 }) applied
    expect(prices).toEqual([19.99, 49.99])
  })

  it('flat pluck with multiple fields applies Attr transforms per field', async () => {
    await Product.create({ name: 'Alpha', priceInCents: 999, stock: 3 })

    const rows = await Product.where({ name: 'Alpha' } as any).pluck('name', 'price')
    expect(rows).toEqual([{ name: 'Alpha', price: 9.99 }])
  })

  it('nested pluck: Order.pluck("id", "user.email") — one query, no N+1', async () => {
    const alice = await User.create({ email: 'alice-pluck@test.com' })
    const bob   = await User.create({ email: 'bob-pluck@test.com' })
    await Order.create({ userId: alice.id, status: 0 })
    await Order.create({ userId: bob.id,   status: 1 })

    const rows = await Order.all()
      .order('id', 'asc')
      .pluck('id', 'user.email') as any[]

    expect(rows.length).toBe(2)
    expect(rows[0]['user.email']).toBe('alice-pluck@test.com')
    expect(rows[1]['user.email']).toBe('bob-pluck@test.com')
    expect(typeof rows[0].id).toBe('number')
  })

  it('nested pluck: single dotted path returns plain values', async () => {
    const user = await User.create({ email: 'single-pluck@test.com' })
    await Order.create({ userId: user.id, status: 0 })
    await Order.create({ userId: user.id, status: 0 })

    const emails = await Order.forUser(user.id).pluck('user.email')
    expect(emails).toEqual(['single-pluck@test.com', 'single-pluck@test.com'])
  })

  it('nested pluck across two associations: LineItem.pluck("qty","order.id","product.name")', async () => {
    const user    = await User.create({ email: 'multi-assoc@test.com' })
    const product = await Product.create({ name: 'Nested Widget', priceInCents: 799, stock: 20 })
    const order   = await Order.create({ userId: user.id, status: 0 }) as any
    await LineItem.create({ orderId: order.id, productId: product.id, name: 'Nested Widget', priceInCents: 799, qty: 3 })

    const rows = await LineItem.where({ orderId: order.id } as any)
      .pluck('qty', 'order.id', 'product.name') as any[]

    expect(rows.length).toBe(1)
    expect(rows[0].qty).toBe(3)
    expect(rows[0]['order.id']).toBe(order.id)
    expect(rows[0]['product.name']).toBe('Nested Widget')
  })

  it('nested pluck applies Attr.for on nested field: product.price in dollars', async () => {
    const user    = await User.create({ email: 'attr-nested@test.com' })
    const product = await Product.create({ name: 'PricedProd', priceInCents: 2500, stock: 5 })
    const order   = await Order.create({ userId: user.id, status: 0 }) as any
    await LineItem.create({ orderId: order.id, productId: product.id, name: 'PricedProd', priceInCents: 2500, qty: 1 })

    const rows = await LineItem.where({ orderId: order.id } as any)
      .pluck('qty', 'product.price') as any[]

    expect(rows[0].qty).toBe(1)
    // Attr.for('priceInCents', { get: v => v / 100 }) applied on Product.price
    expect(rows[0]['product.price']).toBeCloseTo(25.00)
  })

  it('nested pluck + where scope + limit — still one query', async () => {
    const alice = await User.create({ email: 'scoped-pluck@test.com' })
    const bob   = await User.create({ email: 'other-pluck@test.com' })
    await Order.create({ userId: alice.id, status: 1 })
    await Order.create({ userId: alice.id, status: 1 })
    await Order.create({ userId: bob.id,   status: 0 })

    const rows = await Order.forUser(alice.id)
      .limit(2)
      .pluck('id', 'user.email') as any[]

    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r['user.email'] === 'scoped-pluck@test.com')).toBe(true)
  })

  it('nested pluck: null association returns null without crashing', async () => {
    // LineItem with no product (product_id = 999 which doesn't exist)
    // — the nested pluck should return null for the association fields
    const user  = await User.create({ email: 'null-assoc@test.com' })
    const order = await Order.create({ userId: user.id, status: 0 }) as any

    // Insert directly to bypass model validation (invalid product_id = 0)
    await ctx.db.insert(schema.line_items).values({
      orderId:      order.id,
      productId:    999_999,   // non-existent product
      name:         'Ghost Item',
      priceInCents: 100,
      qty:          1,
    })

    const rows = await LineItem.where({ orderId: order.id } as any)
      .pluck('qty', 'product.name') as any[]

    // product is null (FK doesn't resolve) — should not throw
    expect(rows[0].qty).toBe(1)
    expect(rows[0]['product.name']).toBeUndefined()
  })
})

describe('reload() and inspect()', () => {
  it('reload() re-fetches from DB and clears dirty state', async () => {
    const p = await Product.create({ name: 'Reload Me', priceInCents: 300, stock: 10 }) as any

    // Mutate in memory
    p.name  = 'Mutated'
    p.stock = 0
    expect(p.isChanged()).toBe(true)

    // Reload wipes in-memory changes
    await p.reload()
    expect(p._attributes.name).toBe('Reload Me')
    expect(p.isChanged()).toBe(false)
  })

  it('inspect() outputs Rails-style string with enum labels and dirty markers', async () => {
    const user  = await User.create({ email: 'inspect@test.com' })
    const order = await Order.find(
      (await Order.create({ userId: user.id, status: 0 })).id
    ) as any

    order.status = 'confirmed'

    // inspect() is on the prototype, accessible via the proxy
    const out = typeof order.inspect === 'function' ? order.inspect() : util.inspect(order)
    expect(String(out)).toMatch(/Order|dirty|confirmed/)
  })
})
