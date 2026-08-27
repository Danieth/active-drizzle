/**
 * Commit-event tap — transport WS4's emission source, against real PG
 * (conventions of write-log.test.ts; the tap rides the SAME call sites).
 *
 * Pins:
 *  1. AFTER COMMIT ONLY: events fire via the afterCommitQueue — never while
 *     the transaction is open, and NEVER for a rolled-back write.
 *  2. Single-record save/destroy events carry a SNAPSHOT record (the tier-0
 *     short-circuit, frozen at the write point — A2: post-save mutation of
 *     the live instance must never leak into a coalesced frame); ops map
 *     lifecycle exactly (create/update/destroy and the SoftDeletable
 *     destroy/undelete pair).
 *  3. Bulk paths (insertAll / updateAll) emit ids-only events — no record.
 *  4. changedKeys are the write-log's keys (column space).
 *  5. A THROWING publisher is best-effort: reported, never propagated into
 *     the committing request.
 *  6. Unlogged models emit nothing (the tap piggybacks the write-log sites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
import pg from 'pg'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, transaction } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { include } from '../../src/concerns/include.js'
import { SoftDeletable } from '../../src/concerns/index.js'
import {
  registerLoggedModel, resetWriteLogRegistry, WRITE_LOG_SCHEMA_SQL,
} from '../../src/runtime/write-log.js'
import {
  registerCommitPublisher, resetCommitPublishers, type CommitEvent,
} from '../../src/runtime/transport-events.js'

const te_items = pgTable('te_items', {
  id:          serial('id').primaryKey(),
  name:        text('name'),
  stage:       integer('stage').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})

const te_docs = pgTable('te_docs', {
  id:          serial('id').primaryKey(),
  title:       text('title'),
  lockVersion: integer('lock_version').notNull().default(0),
  deletedAt:   timestamp('deleted_at'),
})

const te_plain = pgTable('te_plain', {
  id:   serial('id').primaryKey(),
  name: text('name'),
})

const schema = { te_items, te_docs, te_plain }

@model('te_items')
class TeItem extends ApplicationRecord {}

@model('te_docs')
@include(SoftDeletable)
class TeDoc extends ApplicationRecord {}

@model('te_plain')
class TePlain extends ApplicationRecord {}

let container: StartedPostgreSqlContainer
let pool: pg.Pool
let events: CommitEvent[] = []

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('transportevents').withUsername('test').withPassword('test')
    .start()
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE te_items (
      id serial PRIMARY KEY,
      name text,
      stage integer NOT NULL DEFAULT 0,
      lock_version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE te_docs (
      id serial PRIMARY KEY,
      title text,
      lock_version integer NOT NULL DEFAULT 0,
      deleted_at timestamp
    );
    CREATE TABLE te_plain (id serial PRIMARY KEY, name text);
    ${WRITE_LOG_SCHEMA_SQL}
  `)
  boot(drizzle({ client: pool, schema }) as any, schema)
  resetWriteLogRegistry()
  registerLoggedModel(TeItem)
  registerLoggedModel(TeDoc)
}, 120_000)

afterAll(async () => {
  resetCommitPublishers()
  resetWriteLogRegistry()
  await pool?.end()
  await container?.stop()
})

beforeEach(() => {
  resetCommitPublishers()
  events = []
  registerCommitPublisher(evts => { events.push(...evts) })
})

/** Bulk-path delivery outside a wrap rides a microtask — let it drain. */
const microtasks = () => new Promise<void>(r => setTimeout(r, 0))

describe('single-record save/destroy (live record — the tier-0 short-circuit)', () => {
  it('create → update → destroy emit the exact op/token/changedKeys, record attached', async () => {
    const item: any = await (TeItem as any).create({ name: 'v0' })
    await item.update({ name: 'v1', stage: 2 })
    const pk = item.id
    await item.destroy()

    expect(events.map(e => [e.op, e.token])).toEqual([['create', 0], ['update', 1], ['destroy', 2]])
    for (const e of events) {
      expect(e.table).toBe('te_items')
      expect(String(e.pk)).toBe(String(pk))
      expect(e.record).toBeDefined()             // a snapshot instance rides along
    }
    expect(events[1]!.changedKeys.sort()).toEqual(['name', 'stage'])
    expect(events[2]!.changedKeys).toEqual([])
  })

  it('the record is a SNAPSHOT frozen at the write point — post-save mutation cannot leak (A2)', async () => {
    const item: any = await (TeItem as any).create({ name: 'committed' })
    const ev = events.find(e => e.op === 'create')!
    expect(ev.record).toBeDefined()
    expect(ev.record).not.toBe(item)             // never the live, still-mutable instance

    // The A2 hazard: the gateway holds the event across its coalescing
    // window while app code keeps mutating the live record (or starts a
    // second save). The frame's values must stay the committed state at
    // the event's token.
    item.name = 'dirty-after-commit'             // in-memory mutation, uncommitted
    expect(ev.record.name).toBe('committed')

    await item.update({ name: 'second' })        // a real second commit
    expect(ev.record.name).toBe('committed')     // event 1 still pairs value@token honestly
    const ev2 = events.find(e => e.op === 'update')!
    expect(ev2.record.name).toBe('second')
    expect(ev2.token).toBe(1)
  })

  it('SoftDeletable destroy/restore emit destroy then undelete (lifecycle mapping)', async () => {
    const doc: any = await (TeDoc as any).create({ title: 'd' })
    events = []
    await doc.destroy()                          // soft: update({deletedAt})
    await doc.update({ deletedAt: null })        // restore
    expect(events.map(e => e.op)).toEqual(['destroy', 'undelete'])
    expect(events.every(e => e.table === 'te_docs')).toBe(true)
  })
})

describe('after commit only — never in-tx, never on rollback', () => {
  it('events are invisible INSIDE the transaction and delivered after its commit', async () => {
    let seenInside = -1
    await transaction(async () => {
      const item: any = await (TeItem as any).create({ name: 'tx' })
      await item.update({ stage: 5 })
      seenInside = events.length
    })
    expect(seenInside).toBe(0)                   // nothing leaked pre-commit
    expect(events.map(e => e.op)).toEqual(['create', 'update'])
  })

  it('a rolled-back transaction emits NOTHING', async () => {
    await expect(transaction(async () => {
      const item: any = await (TeItem as any).create({ name: 'doomed' })
      await item.update({ stage: 9 })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await microtasks()
    expect(events).toEqual([])
  })
})

describe('bulk paths (ids-only — the SIGNAL lane)', () => {
  it('insertAll emits one create event per row, record ABSENT', async () => {
    await (TeItem as any).insertAll([{ name: 'a' }, { name: 'b' }])
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.op).toBe('create')
      expect(e.token).toBe(0)
      expect(e.record).toBeUndefined()
    }
  })

  it('updateAll emits ids-only update events with the SET keys; soft-delete updateAll classifies destroy', async () => {
    const a: any = await (TeItem as any).create({ name: 'ua1' })
    const b: any = await (TeItem as any).create({ name: 'ua2' })
    events = []
    await (TeItem as any).where({ id: [a.id, b.id] }).updateAll({ stage: 7 })
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.op).toBe('update')
      expect(e.record).toBeUndefined()
      expect(e.changedKeys).toContain('stage')
      expect(e.changedKeys).toContain('lockVersion')   // the auto-bump rides the SET
    }
    const doc: any = await (TeDoc as any).create({ title: 'bulk' })
    events = []
    await (TeDoc as any).where({ id: doc.id }).updateAll({ deletedAt: new Date() })
    expect(events.map(e => e.op)).toEqual(['destroy'])
  })
})

describe('best-effort + unlogged silence', () => {
  it('a throwing publisher never fails the save (and later publishers still hear)', async () => {
    resetCommitPublishers()
    events = []
    registerCommitPublisher(() => { throw new Error('broken observer') })
    registerCommitPublisher(evts => { events.push(...evts) })
    const item: any = await (TeItem as any).create({ name: 'sturdy' })
    expect(item.isNewRecord).toBe(false)
    expect(events.map(e => e.op)).toEqual(['create'])
  })

  it('an ASYNC-rejecting publisher is isolated the same way (deliver awaits and catches)', async () => {
    resetCommitPublishers()
    events = []
    registerCommitPublisher(async () => { throw new Error('async broken observer') })
    registerCommitPublisher(evts => { events.push(...evts) })
    const item: any = await (TeItem as any).create({ name: 'async-sturdy' })
    await microtasks()
    expect(item.isNewRecord).toBe(false)
    expect(events.map(e => e.op)).toEqual(['create'])
  })

  it('unlogged models emit nothing (the tap piggybacks the write-log sites)', async () => {
    await (TePlain as any).create({ name: 'quiet' })
    await microtasks()
    expect(events).toEqual([])
  })
})
