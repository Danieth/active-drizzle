/**
 * A1 lineage tokens — REAL-DRIVER property test for the per-lineage strictly
 * increasing version token (DESIGN-transport-proof.md axiom A1, obligations
 * O2/O14, WS0 acceptance).
 *
 * Against actual node-postgres on a testcontainers Postgres 16:
 *  1. serial-pk model with `lock_version integer NOT NULL DEFAULT 0`:
 *     create adopts 0 from the DB DEFAULT (no runtime insert code sets it),
 *     each update bumps exactly once via save()'s CAS, a stale copy raises
 *     StaleObjectError, and a destroy→create never resurrects the destroyed
 *     pk (the sequence marches on) — WITH hard delete + serial there is no
 *     cross-incarnation pair to compare, which is exactly why A1 holds
 *     automatically. This test PINS that framework default. (Escape hatch
 *     deliberately out of contract: explicit-pk inserts / sequence resets.)
 *  2. soft-delete natural-key model: destroy is `update({deletedAt})` riding
 *     the SAME CAS, so create→destroy→re-activate on ONE pk carries one
 *     strictly increasing token chain — the O14 companion that makes
 *     natural keys admissible at all.
 *  3. relation.updateAll() bumps the token in the same statement even when
 *     the updates map omits it (the one write path that bypasses the CAS).
 *  4. destroy() rides the CAS too (Rails lock_version parity): a stale copy
 *     raises StaleObjectError instead of silently hard-deleting a row whose
 *     version advanced; a fresh copy deletes normally.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, StaleObjectError } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { include } from '../../src/concerns/include.js'
import { SoftDeletable } from '../../src/concerns/index.js'

// ── schema ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/naming-convention
const lineage_items = pgTable('lineage_items', {
  id:          serial('id').primaryKey(),
  name:        text('name'),
  lockVersion: integer('lock_version').notNull().default(0),
})

// eslint-disable-next-line @typescript-eslint/naming-convention
const lineage_docs = pgTable('lineage_docs', {
  slug:        text('slug').primaryKey(),
  title:       text('title'),
  lockVersion: integer('lock_version').notNull().default(0),
  deletedAt:   timestamp('deleted_at'),
})

const schema = { lineage_items, lineage_docs }

// ── models ───────────────────────────────────────────────────────────────────

@model('lineage_items')
class LineageItem extends ApplicationRecord {}

@model('lineage_docs')
@include(SoftDeletable)
class LineageDoc extends ApplicationRecord {
  static primaryKey = 'slug'
}

// ── container lifecycle ──────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: pg.Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('lineage').withUsername('test').withPassword('test')
    .start()

  pool = new pg.Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE lineage_items (
      id serial PRIMARY KEY,
      name text,
      lock_version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE lineage_docs (
      slug text PRIMARY KEY,
      title text,
      lock_version integer NOT NULL DEFAULT 0,
      deleted_at timestamp
    );
  `)

  const db = drizzle({ client: pool, schema })
  boot(db as any, schema)
})

afterAll(async () => {
  await pool?.end()
  await container?.stop()
})

beforeEach(async () => {
  // Deliberately NO `RESTART IDENTITY` — the serial sequence marching on is
  // the very property under test (a destroyed pk is never re-issued).
  await pool.query(`TRUNCATE lineage_items, lineage_docs`)
})

// ── 1. serial pk: DB-default init, CAS bump, never-reused lineage ────────────

describe('serial-pk lockVersion lineage (A1 automatic under the framework default)', () => {
  it('create adopts lockVersion 0 from the DB DEFAULT; each update bumps exactly once', async () => {
    const item: any = await (LineageItem as any).create({ name: 'v0' })
    expect(item.lockVersion).toBe(0)          // .returning() adopted the DEFAULT — no insert code set it

    await item.update({ name: 'v1' })
    expect(item.lockVersion).toBe(1)
    await item.update({ name: 'v2' })
    expect(item.lockVersion).toBe(2)

    const { rows } = await pool.query(`SELECT lock_version FROM lineage_items WHERE id = $1`, [item.id])
    expect(rows[0].lock_version).toBe(2)      // the bump is IN the row, not just in memory
  })

  it('a stale copy raises StaleObjectError instead of silently winning', async () => {
    const created: any = await (LineageItem as any).create({ name: 'contended' })
    const copyA: any = await (LineageItem as any).find(created.id)
    const copyB: any = await (LineageItem as any).find(created.id)

    await copyA.update({ name: 'A won' })                       // bumps 0 → 1
    copyB.name = 'B stale'
    await expect(copyB.save()).rejects.toThrow(StaleObjectError) // WHERE lock_version = 0 matches zero rows

    const { rows } = await pool.query(`SELECT name, lock_version FROM lineage_items WHERE id = $1`, [created.id])
    expect(rows[0]).toEqual({ name: 'A won', lock_version: 1 })
  })

  it('destroy→create never resurrects the destroyed pk — the sequence is strictly increasing', async () => {
    const first: any = await (LineageItem as any).create({ name: 'incarnation-1' })
    await first.update({ name: 'bumped' })
    const firstId = first.id
    await first.destroy()                                        // hard delete — the lineage ENDS

    const second: any = await (LineageItem as any).create({ name: 'incarnation-2' })
    expect(second.id).toBeGreaterThan(firstId)  // no cross-incarnation token pair can ever exist
    expect(second.lockVersion).toBe(0)          // a NEW lineage legitimately starts at 0
  })
})

// ── 2. soft-delete natural key: one token chain across destroy→re-activate ──

describe('soft-delete natural-key lineage (the O14 companion)', () => {
  it('create→destroy(soft)→restore on the SAME pk strictly increases the token at every commit', async () => {
    const doc: any = await (LineageDoc as any).create({ slug: 'x', title: 'alive' })
    const v0 = doc.lockVersion
    expect(v0).toBe(0)

    await doc.destroy()                       // SoftDeletable override: update({deletedAt}) — rides the CAS
    const v1 = doc.lockVersion
    expect(v1).toBeGreaterThan(v0)
    const gone = await pool.query(`SELECT deleted_at, lock_version FROM lineage_docs WHERE slug = 'x'`)
    expect(gone.rows[0].deleted_at).not.toBeNull()
    expect(gone.rows[0].lock_version).toBe(v1)

    await doc.restore()                       // un-delete — SAME pk, SAME chain
    const v2 = doc.lockVersion
    expect(v2).toBeGreaterThan(v1)
    const back = await pool.query(`SELECT deleted_at, lock_version FROM lineage_docs WHERE slug = 'x'`)
    expect(back.rows[0].deleted_at).toBeNull()
    expect(back.rows[0].lock_version).toBe(v2)
  })

  it('a client holding the pre-destroy token can NOT write over the re-activated row', async () => {
    const doc: any = await (LineageDoc as any).create({ slug: 'y', title: 'alive' })
    const stale: any = await (LineageDoc as any).find('y')       // holds lockVersion 0

    await doc.destroy()
    await doc.restore()                                          // token now 2 on the same pk

    stale.title = 'from before the destroy'
    await expect(stale.save()).rejects.toThrow(StaleObjectError)
  })
})

// ── 3. updateAll bumps the token without being asked ─────────────────────────

describe('relation.updateAll() auto-bumps the lock token', () => {
  it('the token advances in the same statement even though the updates map omits it', async () => {
    const item: any = await (LineageItem as any).create({ name: 'bulk-target' })
    await item.update({ name: 'v1' })         // token at 1

    const count = await (LineageItem as any).where({ id: item.id }).updateAll({ name: 'bulk' })
    expect(count).toBe(1)

    const { rows } = await pool.query(`SELECT name, lock_version FROM lineage_items WHERE id = $1`, [item.id])
    expect(rows[0]).toEqual({ name: 'bulk', lock_version: 2 })

    // and the in-memory copy from BEFORE the bulk write is now stale — the CAS still protects it
    item.name = 'stale-after-bulk'
    await expect(item.save()).rejects.toThrow(StaleObjectError)
  })

  it('an explicit lock value in the updates map wins over the auto-bump', async () => {
    const item: any = await (LineageItem as any).create({ name: 'explicit' })
    await (LineageItem as any).where({ id: item.id }).updateAll({ name: 'pinned', lockVersion: 41 })
    const { rows } = await pool.query(`SELECT lock_version FROM lineage_items WHERE id = $1`, [item.id])
    expect(rows[0].lock_version).toBe(41)
  })
})

// ── 4. destroy() rides the CAS (Rails lock_version parity) ───────────────────

describe('destroy() vs the token — a stale copy cannot silently hard-delete', () => {
  it('a stale copy raises StaleObjectError from destroy(); the advanced row survives', async () => {
    const created: any = await (LineageItem as any).create({ name: 'contended-delete' })
    const copyA: any = await (LineageItem as any).find(created.id)
    const copyB: any = await (LineageItem as any).find(created.id)

    await copyA.update({ name: 'A moved on' })                     // token 0 → 1
    await expect(copyB.destroy()).rejects.toThrow(StaleObjectError) // DELETE WHERE lock_version = 0 → zero rows

    const { rows } = await pool.query(`SELECT name, lock_version FROM lineage_items WHERE id = $1`, [created.id])
    expect(rows[0], 'the row the stale writer tried to delete must survive').toEqual({ name: 'A moved on', lock_version: 1 })
  })

  it('a fresh copy destroys normally — the CAS predicate matches', async () => {
    const item: any = await (LineageItem as any).create({ name: 'doomed' })
    await item.update({ name: 'bumped' })
    expect(await item.destroy()).toBe(true)
    const { rows } = await pool.query(`SELECT 1 FROM lineage_items WHERE id = $1`, [item.id])
    expect(rows).toHaveLength(0)
  })
})
