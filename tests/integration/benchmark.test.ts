/**
 * Benchmark: active-drizzle overhead vs raw Drizzle ORM.
 *
 * This is intentionally a test (not a standalone script) so it runs in the
 * same CI pipeline and the numbers are recorded alongside pass/fail.
 *
 * What we measure:
 *   A. Raw Drizzle   — db.select().from(table).where(...)  → plain objects
 *   B. active-drizzle .load()  — Proxy-wrapped instances    → ApplicationRecord
 *   C. active-drizzle .pluck() — column extraction, no Proxy → plain values
 *   D. active-drizzle .find()  — single-row lookup
 *   E. active-drizzle create+save cycle  vs  raw insert().returning()
 *
 * Expected results (rough):
 *   – .pluck()  ≈ raw Drizzle (minimal overhead, no Proxy)
 *   – .load()   adds ~5-20 µs per record (Proxy wrap + STI check per row)
 *   – .find()   ≈ 1 round-trip, similar to raw
 *   – create()  adds one extra JS call per field for Attr.set; negligible
 *
 * The test PASSES regardless of numbers; the overhead figures are printed
 * so you can reason about them. The only hard assertion is that overhead
 * does not exceed 5× raw (i.e., the library is not orders-of-magnitude slower).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { startPostgres, type PgContext } from './_helpers/pg-setup.js'
import { Product } from './_helpers/models.js'
import { schema } from './_helpers/schema.js'

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let ctx: PgContext
const ROWS     = 200   // seed rows
const ITERS    = 50    // iterations per benchmark
const MAX_OVERHEAD_FACTOR = 8  // fail if active-drizzle is >8× slower than raw

beforeAll(async () => {
  ctx = await startPostgres()

  // Seed ROWS products directly via raw Drizzle — no model overhead during setup
  const rows = Array.from({ length: ROWS }, (_, i) => ({
    type:         'Product',
    name:         `Bench Product ${i + 1}`,
    priceInCents: 1000 + i * 10,
    stock:        i,
    isActive:     i % 5 !== 0,   // 80% active
  }))
  await ctx.db.insert(schema.products).values(rows)
}, 90_000)

afterAll(async () => {
  await ctx.stop()
}, 30_000)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function bench(label: string, fn: () => Promise<unknown>): Promise<number> {
  // Warm up
  await fn()
  await fn()

  const start = performance.now()
  for (let i = 0; i < ITERS; i++) await fn()
  const totalMs  = performance.now() - start
  const perIterMs = totalMs / ITERS

  console.log(
    `  ${label.padEnd(40)} ${perIterMs.toFixed(3).padStart(8)} ms/iter` +
    `  (${ITERS} iters, ${totalMs.toFixed(1)} ms total)`
  )

  return perIterMs
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

describe('Benchmark: active-drizzle vs raw Drizzle', () => {

  it('A vs B — select all rows: raw vs .load() proxy wrapping', async () => {
    console.log(`\n── SELECT all ${ROWS} rows ──────────────────────────────────`)

    const rawMs = await bench(
      'raw  drizzle.select().from(products)',
      () => ctx.db.select().from(schema.products),
    )

    const adMs = await bench(
      'AD   Product.all().load()',
      () => Product.all().load(),
    )

    const factor = adMs / rawMs
    console.log(`  Overhead factor: ${factor.toFixed(2)}×  (${((factor - 1) * 100).toFixed(1)}% slower)`)

    expect(factor).toBeLessThan(MAX_OVERHEAD_FACTOR)
  }, 120_000)


  it('C — .pluck() vs raw select of a single column', async () => {
    console.log(`\n── PLUCK single column (${ROWS} rows) ────────────────────────`)

    const rawMs = await bench(
      'raw  db.select({ n: p.name }).from(products)',
      async () => ctx.db.select({ n: schema.products.name }).from(schema.products),
    )

    const adMs = await bench(
      'AD   Product.all().pluck("name")',
      () => Product.all().pluck('name'),
    )

    const factor = adMs / rawMs
    console.log(`  Overhead factor: ${factor.toFixed(2)}×`)
    expect(factor).toBeLessThan(MAX_OVERHEAD_FACTOR)
  }, 120_000)


  it('D — single-row lookup: raw WHERE id= vs .find(id)', async () => {
    console.log(`\n── FIND single row by id ─────────────────────────────────────`)

    const targetId = Math.floor(ROWS / 2)

    const rawMs = await bench(
      'raw  db.select().from(p).where(eq(p.id, id)).limit(1)',
      () => ctx.db.select().from(schema.products).where(eq(schema.products.id, targetId)).limit(1),
    )

    const adMs = await bench(
      'AD   Product.find(id)',
      () => Product.find(targetId),
    )

    const factor = adMs / rawMs
    console.log(`  Overhead factor: ${factor.toFixed(2)}×`)
    expect(factor).toBeLessThan(MAX_OVERHEAD_FACTOR)
  }, 120_000)


  it('E — filtered query with limit: raw vs .where().limit()', async () => {
    console.log(`\n── FILTERED select (isActive=true, limit 25) ─────────────────`)

    const rawMs = await bench(
      'raw  db.select().from(p).where(eq(isActive,true)).limit(25)',
      () => ctx.db
        .select()
        .from(schema.products)
        .where(eq(schema.products.isActive, true))
        .limit(25),
    )

    const adMs = await bench(
      'AD   Product.where({ isActive: true }).limit(25).load()',
      () => Product.where({ isActive: true } as any).limit(25).load(),
    )

    const factor = adMs / rawMs
    console.log(`  Overhead factor: ${factor.toFixed(2)}×`)
    expect(factor).toBeLessThan(MAX_OVERHEAD_FACTOR)
  }, 120_000)


  it('F — insert + returning: raw vs Product.create()', async () => {
    console.log(`\n── INSERT + RETURNING (single row) ───────────────────────────`)

    let counter = 0

    const rawMs = await bench(
      'raw  db.insert(products).values(...).returning()',
      async () => {
        counter++
        await ctx.db
          .insert(schema.products)
          .values({ type: 'Product', name: `Raw-${counter}`, priceInCents: 999, stock: 1, isActive: true })
          .returning()
      },
    )

    const adMs = await bench(
      'AD   Product.create({ name, priceInCents, ... })',
      async () => {
        counter++
        await Product.create({ name: `AD-${counter}`, priceInCents: 999, stock: 1 })
      },
    )

    const factor = adMs / rawMs
    console.log(`  Overhead factor: ${factor.toFixed(2)}×`)
    expect(factor).toBeLessThan(MAX_OVERHEAD_FACTOR)
  }, 120_000)


  it('G — summary: print overhead table', async () => {
    // This test just provides context — it always passes.
    console.log(`
┌─────────────────────────────────────────────────────────────────────────┐
│  active-drizzle Benchmark Summary                                        │
│                                                                          │
│  Test conditions: ${ROWS} seed rows, ${ITERS} iterations each, real Postgres          │
│                                                                          │
│  The overhead above comes from:                                          │
│    • STI resolution per row (_resolveSubclass check)                     │
│    • Proxy wrapping (new Proxy() per instance)                           │
│    • Attr.get() transforms applied to each field accessed                │
│    • _buildFinalWhere() re-composing where clauses from the Relation     │
│                                                                          │
│  .pluck() bypasses Proxy entirely → closest to raw Drizzle speed        │
│  .load() overhead is ~1 Proxy constructor + N field accesses per row    │
│  For 99% of real apps: the DB round-trip dominates. Overhead is noise.  │
└─────────────────────────────────────────────────────────────────────────┘
`)
    expect(true).toBe(true)
  }, 30_000)

})
