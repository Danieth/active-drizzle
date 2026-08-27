/**
 * Transaction wraps must be DATABASE-AWARE.
 *
 * - save()/destroy()'s "already in a transaction" gate must compare the
 *   ambient tx's database with the MODEL's own — a tx on 'default' provides
 *   zero atomicity for writes routed to a bindDatabase()-bound connection.
 * - withLock() must open its transaction on the model's own database, or
 *   FOR UPDATE runs in autocommit on the bound connection.
 * - A nested transaction() on the SAME database must run via the current tx
 *   client (a real savepoint) — resolving the root instance opens an
 *   INDEPENDENT top-level transaction instead. On a DIFFERENT database it IS
 *   independent: its afterCommit queue flushes at ITS OWN commit, never
 *   handed to (and dropped with) the other database's transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, bindDatabase, transaction } from '../../src/runtime/boot.js'
import { Relation } from '../../src/runtime/relation.js'
import { model, afterCommit } from '../../src/runtime/decorators.js'
import { hasMany } from '../../src/runtime/markers.js'

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, name: c, _name: c }
  return t
}

function makeDb(tag: string, opts: { childRow?: any } = {}) {
  const db: any = {
    tag,
    query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => (opts.childRow ? [opts.childRow] : [])) }) }),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 10 }]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 10 }]) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
    transaction: vi.fn((cb: any) => cb(db)),
  }
  return db
}

const eventCommits: string[] = []

@model('re_event_details')
class ReEventDetail extends ApplicationRecord {}
void ReEventDetail
@model('re_events')
class ReEvent extends ApplicationRecord {
  static details = hasMany('re_event_details', { acceptsNested: true } as any)
  @afterCommit()
  note() { eventCommits.push('event-committed') }
}
@model('re_event_logs')
class ReEventLog extends ApplicationRecord {}
void ReEventLog
@model('re_event_parents')
class ReEventParent extends ApplicationRecord {
  static logs = hasMany('re_event_logs', { dependent: 'destroy' } as any)
}
@model('re_posts')
class RePost extends ApplicationRecord {}
void RePost

const defaultSchema = { re_posts: fakeTable(['id', 'title']) }
const analyticsSchema = {
  re_events: fakeTable(['id', 'kind']),
  re_event_details: fakeTable(['id', 're_eventId', 'note']),
  re_event_logs: fakeTable(['id', 're_event_parentId']),
  re_event_parents: fakeTable(['id']),
}

// forged child: belongs to event 777, not the new event 10
let mainDb = makeDb('main')
let adb = makeDb('analytics', { childRow: { id: 99, re_eventId: 777, note: 'not-ours' } })

beforeEach(() => {
  eventCommits.length = 0
  mainDb = makeDb('main')
  adb = makeDb('analytics', { childRow: { id: 99, re_eventId: 777, note: 'not-ours' } })
  boot(mainDb, defaultSchema)
  bindDatabase('analytics', adb, analyticsSchema)
})

// ── save()/destroy() gate is db-aware ────────────────────────────────────────

describe('save() inside a DIFFERENT database\'s transaction still opens its own wrap', () => {
  it('a bound model with nested attributes gets an atomic wrap on ITS database', async () => {
    await transaction(async () => {
      const ev = new ReEvent({ kind: 'x', detailsAttributes: [{ id: 99, note: 'n' }] })
      const ok = await ev.save()
      expect(ok).toBe(false)                 // forged child → rolled back
      expect(ev.isNewRecord).toBe(true)      // state restored — no phantom
    })
    // the wrap must have opened on the MODEL's connection, not been skipped
    // because an unrelated default-db tx was ambient
    expect(adb.transaction).toHaveBeenCalledTimes(1)
  })

  it('destroy() of a bound cascade model wraps on ITS database too', async () => {
    await transaction(async () => {
      const p = new ReEventParent({ id: 1 }, false)
      await p.destroy()
    })
    expect(adb.transaction).toHaveBeenCalledTimes(1)
  })
})

// ── withLock() opens on the model's database ─────────────────────────────────

describe('withLock() opens its transaction on the model\'s own database', () => {
  it('a bound model locks on the bound connection, not on default', async () => {
    await new Relation(ReEvent as any).withLock(async () => 'ok')
    expect(adb.transaction).toHaveBeenCalledTimes(1)
    expect(mainDb.transaction).not.toHaveBeenCalled()
  })
})

// ── nested transaction(): savepoint on same db, independence across dbs ──────

describe('nested transaction() semantics', () => {
  it('same database: runs via the CURRENT tx client (a savepoint), not a second top-level tx', async () => {
    const savepoint = vi.fn(async (cb: any) => cb({ tag: 'savepoint-tx' }))
    const txClient: any = { tag: 'main-tx', transaction: savepoint }
    mainDb.transaction.mockImplementationOnce(async (cb: any) => cb(txClient))

    await transaction(async () => {
      await transaction(async () => 'inner')
    })

    expect(mainDb.transaction).toHaveBeenCalledTimes(1)   // ONE top-level BEGIN
    expect(savepoint).toHaveBeenCalledTimes(1)            // the nesting is a savepoint
  })

  it('different database: independent — its afterCommit flushes at ITS commit, not dropped with the outer rollback', async () => {
    await expect(transaction(async () => {
      await transaction(async () => {
        const ev = new ReEvent({ kind: 'x' })
        await ev.save()
      }, { database: 'analytics' })
      expect(eventCommits).toEqual(['event-committed'])   // fired when ANALYTICS committed
      throw new Error('outer-rollback')
    })).rejects.toThrow('outer-rollback')
    expect(eventCommits).toEqual(['event-committed'])     // …and survived the outer rollback
  })

  it('a successful bound-model save inside a default tx fires afterCommit at ITS OWN commit', async () => {
    // the analytics write is durable the moment its own wrap/statement commits —
    // deferring its afterCommit into the DEFAULT tx's queue drops it on rollback
    await expect(transaction(async () => {
      const ev = new ReEvent({ kind: 'y' })
      await ev.save()
      throw new Error('outer-rollback')
    })).rejects.toThrow('outer-rollback')
    expect(eventCommits).toEqual(['event-committed'])
  })
})
