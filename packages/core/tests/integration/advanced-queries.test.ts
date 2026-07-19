/**
 * Integration: the advanced query system (group/having, grouped aggregates,
 * DISTINCT ON, window functions, keyset pagination, set operations, toSQL)
 * against a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { desc, sql } from 'drizzle-orm'
import { startPostgres, type PgContext } from './_helpers/pg-setup.js'
import { Order, Product } from './_helpers/models.js'
import { schema } from './_helpers/schema.js'

let ctx: PgContext
beforeAll(async () => { ctx = await startPostgres() }, 60_000)
afterAll(async () => { await ctx.stop() }, 30_000)

beforeEach(async () => {
  await ctx.reset()
  // 5 orders across 3 users + statuses (pending=0, confirmed=1, shipped=2)
  await ctx.db.insert(schema.orders).values([
    { userId: 1, status: 0, totalInCents: 1000 },
    { userId: 1, status: 1, totalInCents: 2000 },
    { userId: 2, status: 0, totalInCents: 500 },
    { userId: 2, status: 0, totalInCents: 700 },
    { userId: 3, status: 2, totalInCents: 3000 },
  ])
  // 3 products across 2 types for window ranking
  await ctx.db.insert(schema.products).values([
    { type: 'Product',        name: 'A', priceInCents: 100, stock: 1, isActive: true },
    { type: 'Product',        name: 'B', priceInCents: 300, stock: 1, isActive: true },
    { type: 'DigitalProduct', name: 'C', priceInCents: 200, stock: 1, isActive: true },
  ])
})

describe('grouped aggregation (Rails-style)', () => {
  it('group(status).count() → { label → count }, with enum labels', async () => {
    const r = await Order.all().group('status').count() as unknown as Record<string, number>
    expect(r).toEqual({ pending: 3, confirmed: 1, shipped: 1 })
  })

  it('group(userId).sum(total) → { userId → sum(cents) }', async () => {
    const r = await Order.all().group('userId').sum('total') as unknown as Record<string, number>
    expect(r).toEqual({ '1': 3000, '2': 1200, '3': 3000 })
  })

  it('having() filters groups', async () => {
    const r = await Order.all().group('userId').having(sql`count(*) > 1`).count() as unknown as Record<string, number>
    expect(r).toEqual({ '1': 2, '2': 2 })   // user 3 has only one order → excluded
  })

  it('scalar aggregate still works ungrouped', async () => {
    expect(await Order.all().count()).toBe(5)
    expect(await Order.all().sum('total')).toBe(7200)
  })
})

describe('DISTINCT ON — one row per group', () => {
  it('highest-total order per user', async () => {
    const rows = await Order.all()
      .distinct('userId')
      .order('userId').order('totalInCents', 'desc')
      .load()
    expect(rows.map(o => o._attributes.totalInCents)).toEqual([2000, 700, 3000])
  })
})

describe('window functions', () => {
  it('rank products by price within their type', async () => {
    const rows = await Product.all().select((t, fn) => ({
      name: t.name,
      rank: fn.rank().over({ partitionBy: t.type, orderBy: desc(t.priceInCents) }),
    }))
    const byName = Object.fromEntries(rows.map((r: any) => [r.name, Number(r.rank)]))
    expect(byName).toEqual({ B: 1, A: 2, C: 1 })  // Product: B>A; DigitalProduct: C alone
  })
})

describe('keyset / cursor pagination', () => {
  it('seek(after) pages forward with no OFFSET', async () => {
    const page1 = await Order.all().seek(['id']).limit(2).load()
    const page2 = await Order.all().seek(['id'], { after: { id: page1.at(-1)!._attributes.id } }).limit(2).load()
    const ids1 = page1.map(o => o._attributes.id)
    const ids2 = page2.map(o => o._attributes.id)
    expect(ids1).toHaveLength(2)
    expect(ids2).toHaveLength(2)
    expect(Math.min(...ids2)).toBeGreaterThan(Math.max(...ids1))  // strictly after
  })
})

describe('set operations', () => {
  it('union of two relations → model instances', async () => {
    const rows = await Order.where({ userId: 1 }).union(Order.where({ userId: 3 }))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBeInstanceOf(Order)
  })
})

describe('coalesced aggregates — many metrics, one round-trip', () => {
  it('aggregate() runs count + sum + average in a single query', async () => {
    const r = await Order.all().aggregate(a => ({
      orders:  a.count(),
      revenue: a.sum('total'),
      avg:     a.average('total'),
    })) as { orders: number; revenue: number; avg: number }
    expect(r.orders).toBe(5)
    expect(r.revenue).toBe(7200)
    expect(r.avg).toBe(1440)   // 7200 / 5
  })

  it('aggregate() composes with group() → { groupKey → { metrics } }', async () => {
    const r = await Order.all().group('status').aggregate(a => ({
      n:   a.count(),
      rev: a.sum('total'),
    })) as Record<string, { n: number; rev: number }>
    expect(r).toEqual({
      pending:   { n: 3, rev: 2200 },
      confirmed: { n: 1, rev: 2000 },
      shipped:   { n: 1, rev: 3000 },
    })
  })
})

describe('async — Node overlaps natively (no thread pool)', () => {
  it('loadAsync() dispatches eagerly; awaiting collects', async () => {
    const rel = Order.where({ userId: 1 }).loadAsync()   // query in flight now
    const rows = await rel
    expect(rows).toHaveLength(2)
  })

  it('independent queries overlap via Promise.all (every method is eager)', async () => {
    const orders   = Order.all().count()        // dispatched
    const products = Product.all().count()      // dispatched, concurrently
    const names    = Product.all().pluck('name')// "async pluck" — already in flight
    const [o, p, n] = await Promise.all([orders, products, names])
    expect(o).toBe(5)
    expect(p).toBe(3)
    expect(new Set(n)).toEqual(new Set(['A', 'B', 'C']))
  })
})

describe('toSQL — inspect without running', () => {
  it('compiles where + distinct without executing', async () => {
    expect(Order.where({ userId: 1 }).toSQL().sql.toLowerCase()).toContain('where')
    expect(Order.all().distinct('userId').toSQL().sql.toLowerCase()).toContain('distinct on')
  })
})
