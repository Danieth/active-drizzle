/**
 * WS3 write-log substrate — REAL-DRIVER integration test (transport WS3,
 * obligation O10 server side; conventions of lineage-tokens.test.ts).
 *
 * Against actual node-postgres on a testcontainers Postgres 16:
 *  1. DENSITY: log tokens are exactly 0..V per lineage — create writes the
 *     lifecycle=1 row at the DB-default token 0, every save CAS bump writes
 *     its row, updateAll writes one row per matched lineage, counter-cache
 *     bumps write the parent's row. Any missing token is a GAP the
 *     validation predicate degrades on (never a wrong 304) — density is what
 *     makes the gap CHECKABLE.
 *  2. BITMAP correctness per write path (declaration-order numbering).
 *  3. LIFECYCLE rows: create=1, hard destroy=2 at D=loaded+1, soft
 *     destroy=2, soft restore (re-creation)=3 — clause (ii)'s evidence.
 *  4. TOMBSTONE survival: after a hard DELETE the lifecycle=2 row is the
 *     only durable carrier of D, exempt from pruning forever.
 *  5. PRUNE-then-GAP: aging out lifecycle=0 rows leaves an interval the
 *     density check detects.
 *  6. fieldsRev reconciliation: numbering drift deletes lifecycle=0 rows
 *     (bitmaps must never be misread), keeps lifecycle rows, updates meta.
 *  7. ATOMICITY (verify persistence, not 200s): if the log INSERT cannot
 *     commit, the data write rolls back with it — log-row-exists ⟺
 *     commit-happened is a Postgres fact, not a hope.
 *  8. MEMBERSHIP TAGS: lifecycle writes bump registered doors' counters
 *     in-commit; plain updates do not (the conservative v1 rule).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { belongsTo, hasMany } from '../../src/runtime/markers.js'
import { include } from '../../src/concerns/include.js'
import { SoftDeletable } from '../../src/concerns/index.js'
import {
  registerLoggedModel, resetWriteLogRegistry, registerMembershipDoor,
  fieldNumberingFor, readWriteLogInterval, latestDestroyToken,
  reconcileWriteLogFieldsRev, pruneWriteLog, currentMembershipTag,
  bitmapIntersects, packChangedBitmap, LIFECYCLE, WRITE_LOG_SCHEMA_SQL,
} from '../../src/runtime/write-log.js'

// ── schema ───────────────────────────────────────────────────────────────────

const wl_items = pgTable('wl_items', {
  id:          serial('id').primaryKey(),
  name:        text('name'),
  stage:       integer('stage').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})

const wl_docs = pgTable('wl_docs', {
  slug:        text('slug').primaryKey(),
  title:       text('title'),
  lockVersion: integer('lock_version').notNull().default(0),
  deletedAt:   timestamp('deleted_at'),
})

const wl_parents = pgTable('wl_parents', {
  id:          serial('id').primaryKey(),
  name:        text('name'),
  kidsCount:   integer('kids_count').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})

const wl_kids = pgTable('wl_kids', {
  id:          serial('id').primaryKey(),
  wlParentId:  integer('wl_parent_id'),
  label:       text('label'),
})

const schema = { wl_items, wl_docs, wl_parents, wl_kids }

// ── models ───────────────────────────────────────────────────────────────────

@model('wl_items')
class WlItem extends ApplicationRecord {}

@model('wl_docs')
@include(SoftDeletable)
class WlDoc extends ApplicationRecord {
  static primaryKey = 'slug'
}

@model('wl_parents')
class WlParent extends ApplicationRecord {
  static kids = hasMany('wl_kids', { counterCache: 'kidsCount', foreignKey: 'wlParentId' })
}

@model('wl_kids')
class WlKid extends ApplicationRecord {
  static wlParent = belongsTo('wl_parents', { foreignKey: 'wlParentId' })
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Decode one log row's bitmap into the set of field names it marks. */
function changedFieldsOf(bitmap: Buffer, tableName: string): string[] {
  const fields = fieldNumberingFor(tableName)
  return fields.filter((_, i) => {
    const byte = bitmap[i >> 3]
    return byte !== undefined && (byte & (1 << (i & 7))) !== 0
  })
}

async function logRows(tableName: string, pk: any): Promise<Array<{ token: number; lifecycle: number; changed: Buffer }>> {
  const { rows } = await pool.query(
    `SELECT token, lifecycle, changed FROM record_write_log
     WHERE model = $1 AND pk = $2 ORDER BY token ASC`, [tableName, String(pk)])
  return rows.map((r: any) => ({ token: Number(r.token), lifecycle: Number(r.lifecycle), changed: r.changed }))
}

// ── container lifecycle ──────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: pg.Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('writelog').withUsername('test').withPassword('test')
    .start()

  pool = new pg.Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE wl_items (
      id serial PRIMARY KEY,
      name text,
      stage integer NOT NULL DEFAULT 0,
      lock_version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE wl_docs (
      slug text PRIMARY KEY,
      title text,
      lock_version integer NOT NULL DEFAULT 0,
      deleted_at timestamp
    );
    CREATE TABLE wl_parents (
      id serial PRIMARY KEY,
      name text,
      kids_count integer NOT NULL DEFAULT 0,
      lock_version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE wl_kids (
      id serial PRIMARY KEY,
      wl_parent_id integer,
      label text
    );
    ${WRITE_LOG_SCHEMA_SQL}
  `)

  const db = drizzle({ client: pool, schema })
  boot(db as any, schema)

  resetWriteLogRegistry()
  registerLoggedModel(WlItem)
  registerLoggedModel(WlDoc)
  registerLoggedModel(WlParent)
  registerLoggedModel(WlKid)          // no lock column → must be silently SKIPPED
  registerMembershipDoor('wl_items', '/wl-items')
}, 120_000)

afterAll(async () => {
  resetWriteLogRegistry()
  await pool?.end()
  await container?.stop()
})

// ── 1+2+3. density, bitmaps, lifecycle per write path ────────────────────────

describe('save() write points (in-transaction, dense per lineage)', () => {
  it('create logs lifecycle=1 at token 0; each update logs its CAS token with the exact changed bitmap', async () => {
    const item: any = await (WlItem as any).create({ name: 'v0' })
    await item.update({ name: 'v1' })
    await item.update({ stage: 3 })

    const rows = await logRows('wl_items', item.id)
    expect(rows.map(r => r.token)).toEqual([0, 1, 2])                 // DENSE: exactly 0..V
    expect(rows.map(r => r.lifecycle)).toEqual([LIFECYCLE.create, 0, 0])
    // Declaration-order numbering: bitmap marks exactly what each commit changed
    expect(changedFieldsOf(rows[1]!.changed, 'wl_items')).toEqual(['name'])
    expect(changedFieldsOf(rows[2]!.changed, 'wl_items')).toEqual(['stage'])
    // The create bitmap is the full set (every field born at token 0)
    expect(changedFieldsOf(rows[0]!.changed, 'wl_items')).toEqual(fieldNumberingFor('wl_items'))

    // readWriteLogInterval sees the same evidence the validate handler will
    const interval = await readWriteLogInterval('wl_items', item.id, 0, 2)
    expect(interval.map(r => r.token)).toEqual([1, 2])
    expect(bitmapIntersects(interval[0]!.changed, [fieldNumberingFor('wl_items').indexOf('name')])).toBe(true)
    expect(bitmapIntersects(interval[0]!.changed, [fieldNumberingFor('wl_items').indexOf('stage')])).toBe(false)
  })

  it('a model without a lock column never logs (registration is a no-op)', async () => {
    const kid: any = await (WlKid as any).create({ label: 'untracked' })
    const { rows } = await pool.query(
      `SELECT 1 FROM record_write_log WHERE model = 'wl_kids' AND pk = $1`, [String(kid.id)])
    expect(rows).toHaveLength(0)
  })
})

describe('insertAll write point (bulk creates are in-contract)', () => {
  it('logs lifecycle=1 at each birth token, full bitmap, and bumps the door tag ONCE per call', async () => {
    const tagBefore = await currentMembershipTag('/wl-items')
    const count = await (WlItem as any).insertAll([{ name: 'bulk-ins-1' }, { name: 'bulk-ins-2', stage: 2 }])
    expect(count).toBe(2)

    const { rows: items } = await pool.query(
      `SELECT id FROM wl_items WHERE name IN ('bulk-ins-1','bulk-ins-2') ORDER BY id`)
    expect(items).toHaveLength(2)
    for (const item of items) {
      const rows = await logRows('wl_items', item.id)
      expect(rows.map(r => ({ token: r.token, lifecycle: r.lifecycle })))
        .toEqual([{ token: 0, lifecycle: LIFECYCLE.create }])
      expect(changedFieldsOf(rows[0]!.changed, 'wl_items')).toEqual(fieldNumberingFor('wl_items'))
    }
    // ONE conservative bump for the whole bulk create, not one per row
    expect(await currentMembershipTag('/wl-items')).toBe(tagBefore + 1)
  })

  it('atomicity: when the log INSERT cannot commit, the bulk INSERT rolls back with it', async () => {
    await pool.query(`ALTER TABLE record_write_log RENAME TO record_write_log_hidden`)
    try {
      await expect((WlItem as any).insertAll([{ name: 'phantom-bulk' }]))
        .rejects.toThrow(/transport tables do not exist/)
      const { rows } = await pool.query(`SELECT 1 FROM wl_items WHERE name = 'phantom-bulk'`)
      expect(rows).toHaveLength(0)
    } finally {
      await pool.query(`ALTER TABLE record_write_log_hidden RENAME TO record_write_log`)
    }
  })
})

describe('deleteAll on a logged model (permanent gone(D) loss ⇒ teaching refusal)', () => {
  it('refuses with destroyAll named; untracked models keep the raw bulk DELETE', async () => {
    const item: any = await (WlItem as any).create({ name: 'undeletable-in-bulk' })
    await expect((WlItem as any).where({ id: item.id }).deleteAll())
      .rejects.toThrow(/write-logged.*destroyAll/s)
    const { rows } = await pool.query(`SELECT 1 FROM wl_items WHERE id = $1`, [item.id])
    expect(rows).toHaveLength(1)                                    // nothing was deleted

    const kid: any = await (WlKid as any).create({ label: 'bulk-deletable' })
    expect(await (WlKid as any).where({ id: kid.id }).deleteAll()).toBe(1)
  })
})

describe('updateAll write point (bulk RETURNING → one row per lineage)', () => {
  it('logs each matched lineage at its bumped token with the statically-known bitmap', async () => {
    const a: any = await (WlItem as any).create({ name: 'bulk-a' })
    const b: any = await (WlItem as any).create({ name: 'bulk-b' })
    await a.update({ name: 'bulk-a2' })                               // a at token 1

    const count = await (WlItem as any).where({ id: [a.id, b.id] }).updateAll({ stage: 9 })
    expect(count).toBe(2)

    const aRows = await logRows('wl_items', a.id)
    const bRows = await logRows('wl_items', b.id)
    expect(aRows.map(r => r.token)).toEqual([0, 1, 2])                // density holds through bulk
    expect(bRows.map(r => r.token)).toEqual([0, 1])
    const aBulk = aRows[2]!
    expect(aBulk.lifecycle).toBe(LIFECYCLE.none)
    // bitmap = the SET keys (stage + the auto-bumped lock column)
    expect(changedFieldsOf(aBulk.changed, 'wl_items').sort()).toEqual(['lockVersion', 'stage'])
  })

  it('bulk SOFT-delete logs lifecycle=2 and bulk restore logs lifecycle=3 — latestDestroyToken stays truthful (T4)', async () => {
    await (WlDoc as any).create({ slug: 'bulk-soft', title: 'alive' })          // token 0

    // Bulk soft-destroy: the NEW value is non-null ⇒ destroy
    expect(await (WlDoc as any).where({ slug: 'bulk-soft' }).updateAll({ deletedAt: new Date() })).toBe(1)
    // Bulk restore: the row is hidden by the default scope — go unscoped
    expect(await (WlDoc as any).unscoped().where({ slug: 'bulk-soft' }).updateAll({ deletedAt: null })).toBe(1)

    const rows = await logRows('wl_docs', 'bulk-soft')
    expect(rows.map(r => ({ token: r.token, lifecycle: r.lifecycle }))).toEqual([
      { token: 0, lifecycle: LIFECYCLE.create },
      { token: 1, lifecycle: LIFECYCLE.destroy },                   // NOT undelete — inversion pinned
      { token: 2, lifecycle: LIFECYCLE.undelete },                  // NOT destroy — a bulk restore
    ])                                                              // logged as 2 would fabricate D
    // gone(D)'s source: D must be the DESTROY token, never the restore's
    expect(await latestDestroyToken('wl_docs', 'bulk-soft')).toBe(1)
    // and the softCol property→column-key match held (deletedAt in the bitmap)
    expect(changedFieldsOf(rows[1]!.changed, 'wl_docs')).toContain('deletedAt')
  })

  it('atomicity: when the bulk log rows cannot commit, the bulk UPDATE rolls back with them', async () => {
    const a: any = await (WlItem as any).create({ name: 'atomic-bulk' })
    await pool.query(`ALTER TABLE record_write_log RENAME TO record_write_log_hidden`)
    try {
      await expect((WlItem as any).where({ id: a.id }).updateAll({ stage: 7 }))
        .rejects.toThrow(/transport tables do not exist/)
      // THE assertion: neither the data row nor its token moved
      const { rows } = await pool.query(`SELECT stage, lock_version FROM wl_items WHERE id = $1`, [a.id])
      expect(rows[0]).toEqual({ stage: 0, lock_version: 0 })
    } finally {
      await pool.query(`ALTER TABLE record_write_log_hidden RENAME TO record_write_log`)
    }
  })
})

describe('counter-cache write point (the parent lineage logs its bump)', () => {
  it('creating/destroying a child logs the parent commit with bitmap = {counter column}', async () => {
    const parent: any = await (WlParent as any).create({ name: 'p' })
    const kid: any = await (WlKid as any).create({ wlParentId: parent.id, label: 'k' })

    let rows = await logRows('wl_parents', parent.id)
    expect(rows.map(r => r.token)).toEqual([0, 1])                    // create + counter bump
    expect(changedFieldsOf(rows[1]!.changed, 'wl_parents')).toEqual(['kidsCount'])
    expect(rows[1]!.lifecycle).toBe(LIFECYCLE.none)

    await kid.destroy()
    rows = await logRows('wl_parents', parent.id)
    expect(rows.map(r => r.token)).toEqual([0, 1, 2])                 // decrement logs too
    expect(changedFieldsOf(rows[2]!.changed, 'wl_parents')).toEqual(['kidsCount'])

    // parity with the actual row (verify persistence, not memory)
    const { rows: dbRows } = await pool.query(`SELECT lock_version, kids_count FROM wl_parents WHERE id = $1`, [parent.id])
    expect(dbRows[0]).toEqual({ lock_version: 2, kids_count: 0 })
  })
})

describe('hard destroy: the tombstone (gone(D)’s only durable carrier)', () => {
  it('logs lifecycle=2 at D = loaded+1 and the row survives the DELETE', async () => {
    const item: any = await (WlItem as any).create({ name: 'doomed' })
    await item.update({ name: 'bumped' })                             // token 1
    await item.destroy()

    const rows = await logRows('wl_items', item.id)
    expect(rows.map(r => ({ token: r.token, lifecycle: r.lifecycle }))).toEqual([
      { token: 0, lifecycle: LIFECYCLE.create },
      { token: 1, lifecycle: LIFECYCLE.none },
      { token: 2, lifecycle: LIFECYCLE.destroy },                     // D = loaded(1) + 1
    ])
    expect(await latestDestroyToken('wl_items', item.id)).toBe(2)

    const { rows: gone } = await pool.query(`SELECT 1 FROM wl_items WHERE id = $1`, [item.id])
    expect(gone).toHaveLength(0)
  })
})

describe('soft-delete lineage (SoftDeletable rides save(): lifecycle 2 then 3)', () => {
  it('destroy→restore on ONE pk logs destroy=2 and undelete=3 in the same dense chain', async () => {
    const doc: any = await (WlDoc as any).create({ slug: 'x', title: 'alive' })
    await doc.destroy()                                               // update({deletedAt}) — token 1
    await doc.restore()                                               // token 2

    const rows = await logRows('wl_docs', 'x')
    expect(rows.map(r => ({ token: r.token, lifecycle: r.lifecycle }))).toEqual([
      { token: 0, lifecycle: LIFECYCLE.create },
      { token: 1, lifecycle: LIFECYCLE.destroy },
      { token: 2, lifecycle: LIFECYCLE.undelete },
    ])
    expect(changedFieldsOf(rows[1]!.changed, 'wl_docs')).toEqual(['deletedAt'])
    expect(await latestDestroyToken('wl_docs', 'x')).toBe(1)
  })
})

// ── 4+5. retention: lifecycle rows are forever; pruning creates DETECTABLE gaps

describe('retention (age-bounds everything but the destroy tombstone)', () => {
  it('prune removes aged non-tombstone rows, keeps lifecycle=2 forever, and the gap is detectable', async () => {
    const item: any = await (WlItem as any).create({ name: 'aging' })
    await item.update({ name: 'aging-1' })
    await item.update({ name: 'aging-2' })

    // Age ONLY this lineage's update rows past the window
    await pool.query(
      `UPDATE record_write_log SET committed_at = now() - interval '10 days'
       WHERE model = 'wl_items' AND pk = $1 AND lifecycle = 0 AND token = 1`, [String(item.id)])
    const removed = await pruneWriteLog({ maxAgeMs: 72 * 3600 * 1000 })
    expect(removed).toBeGreaterThanOrEqual(1)

    const rows = await logRows('wl_items', item.id)
    expect(rows.map(r => r.token)).toEqual([0, 2])                    // token 1 pruned
    // The density check the validate handler runs: (0, 2] must carry 2 rows, has 1 → GAP ⇒ slice
    const interval = await readWriteLogInterval('wl_items', item.id, 0, 2)
    expect(interval.length).toBeLessThan(2)

    // Tombstones never age out — but create(1)/undelete(3) rows DO (only
    // lifecycle=2 is load-bearing: creates are outside every interval since
    // W ≥ 0, and a pruned undelete degrades to the slice via the gap rule;
    // an immortal create row would also make pk-reuse collide forever):
    // backdate a whole destroyed lineage and prune it all
    const doomed: any = await (WlItem as any).create({ name: 'tombstone-keeper' })
    await doomed.destroy()
    await pool.query(
      `UPDATE record_write_log SET committed_at = now() - interval '1 year'
       WHERE model = 'wl_items' AND pk = $1`, [String(doomed.id)])
    await pruneWriteLog({ maxAgeMs: 1 })
    expect(await latestDestroyToken('wl_items', doomed.id)).toBe(1)
    const survivors = await logRows('wl_items', doomed.id)
    expect(survivors.map(r => r.lifecycle)).toEqual([LIFECYCLE.destroy])   // ONLY the tombstone
  })
})

// ── 6. fieldsRev reconciliation ──────────────────────────────────────────────

describe('fieldsRev reconciliation (numbering drift ⇒ delete lifecycle=0 rows, never misread)', () => {
  it('first reconcile stamps meta; a mismatched hash truncates update rows and keeps lifecycle rows', async () => {
    const item: any = await (WlItem as any).create({ name: 'drift' })
    await item.update({ name: 'drift-1' })

    await reconcileWriteLogFieldsRev()
    const { rows: meta } = await pool.query(`SELECT fields_hash FROM record_write_log_meta WHERE model = 'wl_items'`)
    expect(meta).toHaveLength(1)
    const goodHash = meta[0].fields_hash

    // idempotent: same hash keeps everything
    await reconcileWriteLogFieldsRev()
    expect((await logRows('wl_items', item.id)).length).toBe(2)

    // simulate a deploy that renumbered: stored hash differs
    await pool.query(`UPDATE record_write_log_meta SET fields_hash = 'stale-numbering' WHERE model = 'wl_items'`)
    await reconcileWriteLogFieldsRev()

    const rows = await logRows('wl_items', item.id)
    expect(rows.map(r => r.lifecycle)).toEqual([LIFECYCLE.create])    // update row gone, create kept
    const { rows: meta2 } = await pool.query(`SELECT fields_hash FROM record_write_log_meta WHERE model = 'wl_items'`)
    expect(meta2[0].fields_hash).toBe(goodHash)

    // and the truncation is exactly the gap rule: (0, 1] now has 0 rows ⇒ conservative slice
    expect(await readWriteLogInterval('wl_items', item.id, 0, 1)).toHaveLength(0)
  })
})

// ── 7. atomicity: log-row-exists ⟺ commit-happened ──────────────────────────

describe('in-transaction atomicity (verify persistence, not 200s)', () => {
  it('when the log INSERT cannot commit, the data write rolls back with it (teaching error)', async () => {
    await pool.query(`ALTER TABLE record_write_log RENAME TO record_write_log_hidden`)
    try {
      const item: any = new (WlItem as any)({ name: 'phantom' })
      await expect(item.save()).rejects.toThrow(/transport tables do not exist/)
      // THE assertion: the INSERT rolled back with the failed log write —
      // no committed data row may exist without its log row.
      const { rows } = await pool.query(`SELECT 1 FROM wl_items WHERE name = 'phantom'`)
      expect(rows).toHaveLength(0)
    } finally {
      await pool.query(`ALTER TABLE record_write_log_hidden RENAME TO record_write_log`)
    }
  })

  it('destroy: when the tombstone cannot commit, the hard DELETE rolls back with it (gone(D) never orphaned)', async () => {
    // A cascades-free logged model: without _destroyNeedsTransaction forcing
    // the wrap, the DELETE and the lifecycle=2 INSERT would be two separate
    // autocommits — and this failure between them would lose gone(D) forever.
    const item: any = await (WlItem as any).create({ name: 'atomic-destroy' })
    await pool.query(`ALTER TABLE record_write_log RENAME TO record_write_log_hidden`)
    try {
      await expect(item.destroy()).rejects.toThrow(/transport tables do not exist/)
      // THE assertion: the row survived — DELETE and tombstone are atomic
      const { rows } = await pool.query(`SELECT 1 FROM wl_items WHERE id = $1`, [item.id])
      expect(rows).toHaveLength(1)
    } finally {
      await pool.query(`ALTER TABLE record_write_log_hidden RENAME TO record_write_log`)
    }
    // and the lineage is still destroyable once the tables are back
    expect(await item.destroy()).toBe(true)
    expect(await latestDestroyToken('wl_items', item.id)).toBe(1)
  })
})

// ── conservative bitmap fill (the unknown-changed-key rule) ──────────────────

describe('packChangedBitmap conservative path', () => {
  it('an out-of-numbering changed key stales EVERY projection (full fill, never a silent drop)', () => {
    const filled = packChangedBitmap(['a', 'b', 'c'], ['not-a-column'])
    expect([...filled].every(byte => byte === 0xff)).toBe(true)
    // and the normal path marks exactly the named columns
    const normal = packChangedBitmap(['a', 'b', 'c'], ['b'])
    expect(bitmapIntersects(normal, [1])).toBe(true)
    expect(bitmapIntersects(normal, [0])).toBe(false)
    expect(bitmapIntersects(normal, [2])).toBe(false)
  })
})

// ── 8. membership tags (the in-commit conservative counter) ──────────────────

describe('membership tags (T8 counter option — bumped in-commit on lifecycle writes)', () => {
  it('create and destroy bump the registered door; plain updates do not; rollback never bumps', async () => {
    const before = await currentMembershipTag('/wl-items')

    const item: any = await (WlItem as any).create({ name: 'member' })
    expect(await currentMembershipTag('/wl-items')).toBe(before + 1)

    await item.update({ name: 'renamed' })                            // value write: NO bump (v1 rule)
    expect(await currentMembershipTag('/wl-items')).toBe(before + 1)

    await item.destroy()
    expect(await currentMembershipTag('/wl-items')).toBe(before + 2)

    // the counter is transactional with the write — a rolled-back create must not bump
    // (a sequence would survive rollback and break tag-equal ⇒ same-list)
    await pool.query(`ALTER TABLE wl_items RENAME COLUMN name TO name_hidden`)
    try {
      const doomed: any = new (WlItem as any)({ name: 'never' })
      await expect(doomed.save()).resolves.toBe(false)                // translated DB error
    } finally {
      await pool.query(`ALTER TABLE wl_items RENAME COLUMN name_hidden TO name`)
    }
    expect(await currentMembershipTag('/wl-items')).toBe(before + 2)
  })
})
