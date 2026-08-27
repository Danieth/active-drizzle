/**
 * Channel emitter — transport WS4's publish half + slice builders.
 *
 * Pins (no DB needed — boot() with schema objects is enough for masks):
 *  - buildRouter POPULATES the shared door registry; the record-lane mask
 *    agrees with validatableMask (the ONE mask rule).
 *  - THE SILENCE RULE: a change outside the door's mask publishes NOTHING;
 *    the ceiling is per VIEW (get vs index masks diverge on include FKs).
 *  - Unknown changed keys are conservative wildcards.
 *  - Channel routing: rec:${door}:${pk}; URL-scoped VALUE events route to
 *    the tenant index lane from the record's own scope columns; ids-only
 *    events fall back to the door-wide lane; membership events always route.
 *  - Coalescing supersede lives gateway-side; here the slice builders:
 *    multi-row batches share one section, destroy slices are touched-only,
 *    and the CHANGE payload is byte-shaped { entities } JSON.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { pgTable, serial, integer, varchar } from 'drizzle-orm/pg-core'
import {
  ApplicationRecord, boot, MODEL_REGISTRY,
  model as modelDecorator, belongsTo,
  registerLoggedModel, resetWriteLogRegistry, resetCommitPublishers,
  emitCommitEvents,
} from '@active-drizzle/core'
import { ActiveController, controller, crud, scope, buildRouter } from '@active-drizzle/controller'
import {
  registerColumnarDoorTransport, columnarDoorRegistry, columnarDoorFor,
  resetColumnarDoorRegistry, validatableMask,
} from '../../src/validate-handler.js'
import { MemoryBus, type BusCommitEvent } from '../../src/channels/bus.js'
import {
  startChannelEmitter, recordChannel, indexChannel, indexChannelsFor, scopeHashOf,
  changeIntersectsMask, buildChangeSliceBytes, destroySliceBytes,
  sliceBytesFromEnvelope,
} from '../../src/channels/emitter.js'

// ── Schema / models (no DB — masks and serialization are pure) ──────────────

const em_loans = pgTable('em_loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  teamId:      integer('team_id'),
  secretRate:  integer('secret_rate'),
  lockVersion: integer('lock_version').notNull().default(0),
})
const em_brokers = pgTable('em_brokers', {
  id:          serial('id').primaryKey(),
  name:        varchar('name', { length: 100 }),
  lockVersion: integer('lock_version').notNull().default(0),
})
const schema = { em_loans, em_brokers }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('em_loans')
class EmLoan extends ApplicationRecord {
  static broker = belongsTo('em_brokers', { foreignKey: 'brokerId' })
}
@modelDecorator('em_brokers')
class EmBroker extends ApplicationRecord {}

const DOOR_CONFIG: any = {
  index: { sortable: ['id'] },
  get: { expose: ['id', 'title', 'stage'], abilities: true, include: ['broker'] },
  update: { permit: ['title', 'stage'], optimisticLock: true },
  wire: 'columnar',
}

@controller('/em-loans')
@crud(EmLoan as any, DOOR_CONFIG)
class EmLoanController extends ActiveController {}

@scope('teamId')
@controller('/em-scoped')
@crud(EmLoan as any, { ...DOOR_CONFIG } as any)
class EmScopedController extends ActiveController {}

beforeAll(() => {
  boot({} as any, schema)
  resetWriteLogRegistry()
  resetColumnarDoorRegistry()
  registerLoggedModel(EmLoan)
  registerLoggedModel(EmBroker)
  buildRouter(EmLoanController as any)
  buildRouter(EmScopedController as any)
})

afterAll(() => {
  resetCommitPublishers()
  resetWriteLogRegistry()
  resetColumnarDoorRegistry()
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))

let bus: MemoryBus
let published: Array<{ channel: string; event: BusCommitEvent }>
let stop: (() => void) | null = null

beforeEach(() => {
  resetCommitPublishers()
  stop?.()
  bus = new MemoryBus()
  published = []
  const origPublish = bus.publish.bind(bus)
  bus.publish = (channel, event) => { published.push({ channel, event }); origPublish(channel, event) }
  stop = startChannelEmitter({ bus })
})

// ── Registry population ─────────────────────────────────────────────────────

describe('door registry (populated by buildRouter, zero app wiring)', () => {
  it('retains both doors with table, scopes, and lazily-computed masks', () => {
    const ids = columnarDoorRegistry().map(e => e.doorId).sort()
    expect(ids).toEqual(['/em-loans', '/teams/:teamId/em-scoped'])
    const flat = columnarDoorFor('/em-loans')!
    expect(flat.tableName).toBe('em_loans')
    expect(flat.scopes).toEqual([])
    const scoped = columnarDoorFor('/teams/:teamId/em-scoped')!
    expect(scoped.scopes).toEqual([{ paramName: 'teamId', field: 'teamId', resource: 'teams' }])
  })

  it('the record-lane mask IS validatableMask (one rule, no drift)', () => {
    const entry = columnarDoorFor('/em-loans')!
    expect([...entry.getMask()].sort())
      .toEqual([...validatableMask(EmLoan, DOOR_CONFIG).fields].sort())
    // get vs index ceilings: the broker FK is a GET include, not an INDEX one
    expect(entry.getMask().has('brokerId')).toBe(true)
    expect(entry.indexMask().has('brokerId')).toBe(false)
  })
})

// ── The silence rule ────────────────────────────────────────────────────────

describe('the silence rule (the moat)', () => {
  it('a change outside expose publishes NOTHING for that door', async () => {
    emitCommitEvents([{ table: 'em_loans', pk: 1, token: 4, op: 'update', changedKeys: ['secretRate'] }])
    await tick()
    expect(published).toEqual([])
  })

  it('a change inside expose publishes to the record channel', async () => {
    emitCommitEvents([{ table: 'em_loans', pk: 1, token: 4, op: 'update', changedKeys: ['title'] }])
    await tick()
    const channels = published.map(p => p.channel)
    expect(channels).toContain(recordChannel('/em-loans', 1))
    expect(channels).toContain(recordChannel('/teams/:teamId/em-scoped', 1))
  })

  it('per-VIEW ceilings: an FK change frames the record lane but is silent on the index lane', async () => {
    emitCommitEvents([{ table: 'em_loans', pk: 2, token: 1, op: 'update', changedKeys: ['brokerId'] }])
    await tick()
    const channels = published.map(p => p.channel)
    expect(channels).toContain(recordChannel('/em-loans', 2))
    expect(channels.some(c => c.startsWith('idx:'))).toBe(false)
  })

  it('an unknown changed key is a conservative wildcard', () => {
    const entry = columnarDoorFor('/em-loans')!
    expect(changeIntersectsMask(
      { op: 'update', changedKeys: ['not_a_column_anywhere'], table: 'em_loans' }, entry.getMask(),
    )).toBe(true)
  })

  it('an unregistered table publishes nothing at all', async () => {
    emitCommitEvents([{ table: 'em_ghosts', pk: 1, token: 0, op: 'create', changedKeys: [] }])
    await tick()
    expect(published).toEqual([])
  })
})

// ── Index-lane routing ──────────────────────────────────────────────────────

describe('index-lane routing', () => {
  it('membership events (create) route to the index lane regardless of masks', async () => {
    const rec: any = new (EmLoan as any)({ id: 3, title: 't', stage: 0, teamId: 9, lockVersion: 0 }, false)
    emitCommitEvents([{ table: 'em_loans', pk: 3, token: 0, op: 'create', changedKeys: [], record: rec }])
    await tick()
    const channels = published.map(p => p.channel)
    expect(channels).toContain(indexChannel('/em-loans'))
    // URL-scoped door: tenant lane derived from the record's OWN scope column
    expect(channels).toContain(indexChannel('/teams/:teamId/em-scoped', scopeHashOf({ teamId: 9 })))
  })

  it('scoped VALUE events without a record fall back to the door-wide lane (SIGNAL side)', async () => {
    emitCommitEvents([{ table: 'em_loans', pk: 4, token: 2, op: 'update', changedKeys: ['stage'] }])
    await tick()
    const channels = published.map(p => p.channel)
    expect(channels).toContain(indexChannel('/teams/:teamId/em-scoped'))
    expect(channels.some(c => c.includes('?'))).toBe(false)   // no tenant lane without the record
  })

  it("an UNPLACEABLE record (null scope column) is STRIPPED from the scoped door-wide publish — values never ride a lane every tenant holds", async () => {
    const rec: any = new (EmLoan as any)({ id: 5, title: 'secretish', stage: 1, teamId: null, lockVersion: 2 }, false)
    emitCommitEvents([{ table: 'em_loans', pk: 5, token: 2, op: 'update', changedKeys: ['title'], record: rec }])
    await tick()
    const scopedWide = published.find(p => p.channel === indexChannel('/teams/:teamId/em-scoped'))!
    expect(scopedWide).toBeDefined()
    expect(scopedWide.event.record).toBeUndefined()
  })

  it('a SCOPE-COLUMN value write publishes the value to the NEW tenant lane AND an ids-only membershipHint door-wide (re-tenanting is membership on both sides)', async () => {
    const rec: any = new (EmLoan as any)({ id: 6, title: 't', stage: 1, teamId: 9, lockVersion: 3 }, false)
    emitCommitEvents([{ table: 'em_loans', pk: 6, token: 3, op: 'update', changedKeys: ['teamId'], record: rec }])
    await tick()
    const tenant = published.find(p =>
      p.channel === indexChannel('/teams/:teamId/em-scoped', scopeHashOf({ teamId: 9 })))!
    expect(tenant).toBeDefined()
    expect(tenant.event.record).toBe(rec)
    const wide = published.find(p => p.channel === indexChannel('/teams/:teamId/em-scoped'))!
    expect(wide).toBeDefined()
    expect(wide.event.record).toBeUndefined()
    expect(wide.event.membershipHint).toBe(true)
  })

  it('indexChannelsFor hashes ONLY the scope params — extra SUB params (filters, perPage) cannot subscribe a lane nobody publishes', () => {
    const scoped = columnarDoorFor('/teams/:teamId/em-scoped')!
    const bare = indexChannelsFor(scoped, { teamId: 9 })
    const noisy = indexChannelsFor(scoped, { teamId: 9, perPage: 50, q: 'foo', sort: 'id' })
    expect(noisy).toEqual(bare)
    // …and the tenant lane agrees with the PUBLISH side's record-derived hash
    expect(bare[0]).toBe(indexChannel('/teams/:teamId/em-scoped', scopeHashOf({ teamId: 9 })))
    // string-vs-number scope values canonicalize identically (URL params are strings)
    expect(indexChannelsFor(scoped, { teamId: '9' })).toEqual(bare)
  })
})

// ── Slice builders (A0 — the ONE serializer's bytes) ────────────────────────

describe('slice builders', () => {
  const loan = (id: number, over: Record<string, any> = {}) =>
    new (EmLoan as any)({ id, title: `t${id}`, stage: 1, brokerId: 7, teamId: 1, secretRate: 99, lockVersion: 5, ...over }, false)

  it('serializes the door projection: expose + belongsTo FK, never the secret, never the token as a column', () => {
    const entry = columnarDoorFor('/em-loans')!
    const slice = buildChangeSliceBytes(entry, [loan(10)])
    const parsed = JSON.parse(new TextDecoder().decode(slice.bytes))
    const section = parsed.entities.em_loans
    expect(section.k).toEqual(['id', 'title', 'stage', 'brokerId'])
    expect(section.v).toEqual([5])                       // token rides in v, not k
    expect(section.r).toEqual([[10, 't10', 1, 7]])
    expect(slice.tokens).toEqual([{ pk: 10, token: 5, op: 'update' }])
    expect(parsed.touched).toBeUndefined()
  })

  it('multi-row batches share ONE section (coalescing batches into one frame)', () => {
    const entry = columnarDoorFor('/em-loans')!
    const slice = buildChangeSliceBytes(entry, [loan(1), loan(2, { lockVersion: 8 })])
    const section = JSON.parse(new TextDecoder().decode(slice.bytes)).entities.em_loans
    expect(section.r.map((r: any[]) => r[0])).toEqual([1, 2])
    expect(section.v).toEqual([5, 8])
    expect(slice.tokens).toEqual([{ pk: 1, token: 5, op: 'update' }, { pk: 2, token: 8, op: 'update' }])
  })

  it('k-DIVERGENCE fallback: a batch whose rows disagree on column presence serializes per-row — never a thrown-away frame', () => {
    const entry = columnarDoorFor('/em-loans')!
    // A partial-select row (no `stage`) diverges from the full row's k.
    const partial: any = new (EmLoan as any)({ id: 2, title: 't2', brokerId: 7, lockVersion: 8 }, false)
    const slice = buildChangeSliceBytes(entry, [loan(1), partial])
    const section = JSON.parse(new TextDecoder().decode(slice.bytes)).entities.em_loans
    // The first row's shape wins the frame; the genuinely divergent row is
    // dropped from THIS frame (its subscriber heals via the pull — C1).
    expect(section.k).toEqual(['id', 'title', 'stage', 'brokerId'])
    expect(section.r).toEqual([[1, 't1', 1, 7]])
    expect(slice.tokens).toEqual([{ pk: 1, token: 5, op: 'update' }])
  })

  it('destroy slices are touched-only (mergeEnvelope raises floors — zero new client code)', () => {
    const entry = columnarDoorFor('/em-loans')!
    const parsed = JSON.parse(new TextDecoder().decode(destroySliceBytes(entry, 42, 6)))
    expect(parsed).toEqual({ touched: [{ resource: 'em_loans', id: 42, op: 'destroy', version: 6 }] })
  })

  it('sliceBytesFromEnvelope strips a full door envelope to { entities, touched? }', () => {
    const bytes = sliceBytesFromEnvelope({
      entities: { em_loans: { k: ['id'], v: [1], r: [[1]] } },
      membership: { pks: [1] }, abilities: { title: 'edit' }, version: 'x',
    } as any)
    expect(JSON.parse(new TextDecoder().decode(bytes)))
      .toEqual({ entities: { em_loans: { k: ['id'], v: [1], r: [[1]] } } })
  })
})
