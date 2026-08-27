/**
 * REAL-DRIVER transaction semantics — the things mocks lie about.
 *
 * Against actual node-postgres on a testcontainers Postgres 16:
 *  1. A nested transaction() on the same database is a SAVEPOINT on the same
 *     connection — an outer rollback undoes the inner writes. (The old code
 *     called db.transaction() on the root instance, which checks out a SECOND
 *     pool connection and runs an independent top-level transaction.)
 *  2. A nested transaction() on a DIFFERENT database is independent: its
 *     writes survive the outer rollback and its afterCommit callbacks fire at
 *     ITS commit instead of being merged into (and dropped with) the outer.
 *  3. save() of a bindDatabase()-bound model inside a default-db transaction
 *     opens its own atomic wrap on the model's database (the db-blind
 *     "already in a transaction" gate used to skip it → autocommit orphans).
 *  4. withLock() opens its transaction on the model's own database, so
 *     SELECT ... FOR UPDATE actually holds the row lock.
 *  5. inBatches()/findEach() on a composite-PK model visits every row exactly
 *     once (the pk[0]-only cursor silently skipped rows when a batch boundary
 *     landed mid-group).
 *  6. A rolled-back create() leaves the instance unsaved (isNewRecord=true).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, serial, integer, text, primaryKey } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, bindDatabase, transaction } from '../../src/runtime/boot.js'
import { model, afterCommit } from '../../src/runtime/decorators.js'
import { hasMany } from '../../src/runtime/markers.js'

// ── schema: default database ─────────────────────────────────────────────────

const posts = pgTable('posts', {
  id:    serial('id').primaryKey(),
  title: text('title').notNull(),
})

// eslint-disable-next-line @typescript-eslint/naming-convention
const post_notes = pgTable('post_notes', {
  id:     serial('id').primaryKey(),
  postId: integer('post_id'),
  note:   text('note'),
})

const memberships = pgTable('memberships', {
  tenantId: integer('tenant_id').notNull(),
  userId:   integer('user_id').notNull(),
  role:     text('role'),
}, t => [primaryKey({ columns: [t.tenantId, t.userId] })])

const defaultSchema = { posts, post_notes, memberships }

// ── schema: 'analytics' database (second real database, same container) ─────

const events = pgTable('events', {
  id:   serial('id').primaryKey(),
  kind: text('kind').notNull(),
})

// eslint-disable-next-line @typescript-eslint/naming-convention
const event_details = pgTable('event_details', {
  id:      serial('id').primaryKey(),
  eventId: integer('event_id'),
  note:    text('note'),
})

const analyticsSchema = { events, event_details }

// ── models ───────────────────────────────────────────────────────────────────

const postCommits: string[] = []
const eventCommits: string[] = []

@model('post_notes')
class TxPostNote extends ApplicationRecord {}
void TxPostNote

@model('posts')
class TxPost extends ApplicationRecord {
  static notes = hasMany('post_notes', { acceptsNested: true } as any)
  @afterCommit()
  committed() { postCommits.push((this as any).title) }
}

@model('event_details')
class TxEventDetail extends ApplicationRecord {}
void TxEventDetail

@model('events')
class TxEvent extends ApplicationRecord {
  static details = hasMany('event_details', { acceptsNested: true } as any)
  @afterCommit()
  committed() { eventCommits.push((this as any).kind) }
}

@model('memberships')
class TxMembership extends ApplicationRecord {
  static primaryKey = ['tenantId', 'userId']
}

// ── container lifecycle ──────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let apool: pg.Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('txsem').withUsername('test').withPassword('test')
    .start()

  pool = new pg.Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE posts (id serial PRIMARY KEY, title text NOT NULL);
    CREATE TABLE post_notes (id serial PRIMARY KEY, post_id integer, note text);
    CREATE TABLE memberships (
      tenant_id integer NOT NULL,
      user_id integer NOT NULL,
      role text,
      PRIMARY KEY (tenant_id, user_id)
    );
  `)
  await pool.query(`CREATE DATABASE txsem_analytics`)

  apool = new pg.Pool({
    connectionString: container.getConnectionUri().replace('/txsem', '/txsem_analytics'),
    ssl: false,
  })
  await apool.query(`
    CREATE TABLE events (id serial PRIMARY KEY, kind text NOT NULL);
    CREATE TABLE event_details (id serial PRIMARY KEY, event_id integer, note text);
  `)

  const db = drizzle({ client: pool, schema: defaultSchema })
  const adb = drizzle({ client: apool, schema: analyticsSchema })
  boot(db as any, defaultSchema)
  bindDatabase('analytics', adb as any, analyticsSchema)
})

afterAll(async () => {
  await apool?.end()
  await pool?.end()
  await container?.stop()
})

beforeEach(async () => {
  postCommits.length = 0
  eventCommits.length = 0
  await pool.query(`TRUNCATE posts, post_notes, memberships RESTART IDENTITY CASCADE`)
  await apool.query(`TRUNCATE events, event_details RESTART IDENTITY CASCADE`)
})

// ── 1. same-db nesting is a savepoint ────────────────────────────────────────

describe('nested transaction() on the same database is a savepoint', () => {
  it('an outer rollback undoes the inner transaction\'s committed-looking write', async () => {
    await expect(transaction(async () => {
      await transaction(async () => {
        await (TxPost as any).create({ title: 'inner' })
      })
      throw new Error('abort-outer')
    })).rejects.toThrow('abort-outer')

    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM posts WHERE title = 'inner'`)
    expect(rows[0].c).toBe(0)                     // savepoint: gone with the outer
    expect(postCommits).toEqual([])               // afterCommit never fired
  })

  it('an inner rollback alone leaves the outer transaction intact', async () => {
    await transaction(async () => {
      await (TxPost as any).create({ title: 'outer-survives' })
      await transaction(async () => {
        await (TxPost as any).create({ title: 'inner-dies' })
        throw new Error('abort-inner')
      }).catch(() => { /* rolled back to the savepoint */ })
    })

    const { rows } = await pool.query(`SELECT title FROM posts ORDER BY id`)
    expect(rows.map(r => r.title)).toEqual(['outer-survives'])
    expect(postCommits).toEqual(['outer-survives'])
  })

  it('a nested transaction can write a row the outer transaction has locked (no self-deadlock)', async () => {
    await pool.query(`INSERT INTO posts (title) VALUES ('locked')`)
    await transaction(async () => {
      const post = await (TxPost as any).where({ title: 'locked' }).first()
      await post.update({ title: 'locked-updated' })      // outer tx now holds the row lock
      await transaction(async () => {
        await post.update({ title: 'locked-updated-again' })  // same connection — must not hang
      })
    })
    const { rows } = await pool.query(`SELECT title FROM posts`)
    expect(rows[0].title).toBe('locked-updated-again')
  }, 20_000)
})

// ── 2. cross-db nesting is independent ───────────────────────────────────────

describe('nested transaction() on a DIFFERENT database is independent', () => {
  it('its write survives the outer rollback and its afterCommit fires at ITS commit', async () => {
    await expect(transaction(async () => {
      await transaction(async () => {
        await (TxEvent as any).create({ kind: 'durable' })
      }, { database: 'analytics' })
      throw new Error('abort-outer')
    })).rejects.toThrow('abort-outer')

    const { rows } = await apool.query(`SELECT count(*)::int AS c FROM events WHERE kind = 'durable'`)
    expect(rows[0].c).toBe(1)                     // committed independently
    expect(eventCommits).toEqual(['durable'])     // not merged into (and dropped with) the outer
  })
})

// ── 3. bound-model save inside a default-db transaction ──────────────────────

describe('save() of a bound model inside a default-db transaction', () => {
  it('a failing nested write rolls back the parent INSERT on the bound database', async () => {
    let saved: boolean | undefined
    let ev: any
    await transaction(async () => {
      ev = new (TxEvent as any)({ kind: 'boom', detailsAttributes: [{ id: 999999, note: 'forged' }] })
      saved = await ev.save()
    })

    expect(saved).toBe(false)
    expect(ev.isNewRecord).toBe(true)             // instance reflects DB reality
    const { rows } = await apool.query(`SELECT count(*)::int AS c FROM events WHERE kind = 'boom'`)
    expect(rows[0].c).toBe(0)                     // no durable orphan on analytics
  })

  it('a successful bound-model save fires afterCommit at ITS OWN commit, not the foreign tx\'s', async () => {
    await expect(transaction(async () => {
      await (TxEvent as any).create({ kind: 'independent' })
      throw new Error('abort-outer')
    })).rejects.toThrow('abort-outer')

    const { rows } = await apool.query(`SELECT count(*)::int AS c FROM events WHERE kind = 'independent'`)
    expect(rows[0].c).toBe(1)                     // durable — the default rollback can't undo it
    expect(eventCommits).toEqual(['independent']) // so its afterCommit must have fired
  })
})

// ── 4. withLock() on a bound model ───────────────────────────────────────────

describe('withLock() locks on the model\'s own database', () => {
  it('the row is lock-unavailable from another analytics connection during the callback', async () => {
    await apool.query(`INSERT INTO events (kind) VALUES ('lockme')`)

    await (TxEvent as any).where({ kind: 'lockme' }).withLock(async (locked: any) => {
      const ev = await locked.first()
      expect(ev).not.toBeNull()
      // From a SEPARATE connection: NOWAIT must fail — the lock is really held
      await expect(
        apool.query(`SELECT id FROM events WHERE kind = 'lockme' FOR UPDATE NOWAIT`)
      ).rejects.toMatchObject({ code: '55P03' })
    })

    // released after the callback's transaction commits
    const { rows } = await apool.query(`SELECT id FROM events WHERE kind = 'lockme' FOR UPDATE NOWAIT`)
    expect(rows.length).toBe(1)
  })
})

// ── 5. composite-PK batching ─────────────────────────────────────────────────

describe('inBatches()/findEach() on a composite-PK model', () => {
  beforeEach(async () => {
    // 150 rows for tenant 1, 100 for tenant 2 — the batch boundary at 100
    // lands mid-way through tenant 1's rows
    await pool.query(`
      INSERT INTO memberships (tenant_id, user_id)
      SELECT 1, gs FROM generate_series(1, 150) gs
      UNION ALL
      SELECT 2, gs FROM generate_series(1, 100) gs
    `)
  })

  it('findEach visits every row exactly once', async () => {
    const seen: string[] = []
    await (TxMembership as any).all().findEach(100, async (m: any) => {
      seen.push(`${m.tenantId}-${m.userId}`)
    })
    expect(seen.length).toBe(250)
    expect(new Set(seen).size).toBe(250)
  })

  it('each batch is scoped to EXACTLY its chunk\'s rows', async () => {
    const batchCounts: number[] = []
    await (TxMembership as any).all().inBatches(100, async (batch: any) => {
      batchCounts.push(await batch.count())
      await batch.updateAll({ role: 'seen' })
    })
    expect(batchCounts).toEqual([100, 100, 50])
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM memberships WHERE role = 'seen'`)
    expect(rows[0].c).toBe(250)
  })
})

// ── 6. rolled-back create() on the default database ──────────────────────────

describe('a rolled-back create() leaves the instance unsaved', () => {
  it('forged nested child: no row, isNewRecord true, errors populated', async () => {
    const post = await (TxPost as any).create({
      title: 'phantom',
      notesAttributes: [{ id: 999999, note: 'forged' }],
    })

    expect(post.isNewRecord).toBe(true)
    expect(post.errors.all()).toHaveProperty('notes')
    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM posts WHERE title = 'phantom'`)
    expect(rows[0].c).toBe(0)
    expect(postCommits).toEqual([])
  })

  it('an ambient same-db transaction is aborted rather than left to commit the orphan', async () => {
    await expect(transaction(async () => {
      await new (TxPost as any)({ title: 'orphan', notesAttributes: [{ id: 999999, note: 'x' }] }).save()
    })).rejects.toThrow(/not part of this record's/)

    const { rows } = await pool.query(`SELECT count(*)::int AS c FROM posts WHERE title = 'orphan'`)
    expect(rows[0].c).toBe(0)
  })
})
