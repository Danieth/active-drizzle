// @vitest-environment node
/**
 * THE ACCEPTANCE BAR — transport WS3's two forbidden corruptions, asserted
 * on real Postgres through the REAL generated funnel (columnar-handshake
 * conventions: real handlers + buildRouter's oRPC procedures on the server,
 * the EntityStore's Rule M on the client):
 *
 *   1. "A 304 never freshens a cell the client does not hold" — update a
 *      field OUTSIDE the door's projection P, validate P with the old
 *      coverage watermark W, receive fresh(V), certify — and ONLY P's
 *      lastSeen advances. Plus the GC/stale-re-merge replay: a cell whose
 *      lastSeen fell below the issue-time W (evict + stale replay while the
 *      304 was in flight) receives NO certification (M4's apply-time
 *      guard — the TLC-found hole, closed end-to-end).
 *
 *   2. "A 304 never certifies across a lifecycle event" —
 *      create → destroy → (soft-undelete) → validate with a stale W answers
 *      gone(D) / the slice, NEVER fresh; and the destroyed-at-exactly-W case
 *      (empty interval, V == W) still answers gone — clause (iii) is read
 *      from the row itself and the V==W shortcut must not skip it.
 *
 * Feature completeness (real splice ops, per-field slice trimming,
 * per-paramsHash counters, HTTP-level caching) is explicitly NOT this bar.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pgTable, serial, integer, varchar, timestamp } from 'drizzle-orm/pg-core'
import { call } from '@orpc/server'

import {
  ApplicationRecord,
  boot,
  MODEL_REGISTRY,
  model as modelDecorator,
  include,
  SoftDeletable,
  belongsTo,
  hasMany,
  resetWriteLogRegistry,
  loggedTableNames,
  latestDestroyToken,
  pruneWriteLog,
  WRITE_LOG_SCHEMA_SQL,
} from '@active-drizzle/core'
import {
  ActiveController, controller, crud, buildRouter, before, Unauthorized,
  validatableMask, defaultValidate, applySplice, paramsHashOf, buildContractProbes, runContractProbes,
} from '@active-drizzle/controller'

import { EntityStore, lastSeenOf, isGone, projFreshAt } from '../src/entity-store.js'
import { mergeEnvelope } from '../src/wire-envelope.js'
import { revalidateProjection, type ProjectionValidator } from '../src/validation-client.js'

// ── Schema ───────────────────────────────────────────────────────────────────

// DELIBERATE INTERLEAVE: secretRate is declared BETWEEN mask columns so the
// door's validatable mask is NOT a declaration-order prefix — the clause (i)
// probe indices ([0,2,3,4] here) and any positional-in-mask index mutant
// ([0,1,2,3]) disagree, so the out-of-P ⇒ fresh tests below pin that the
// probe runs in the DECLARATION numbering space, not the mask's.
const fv_loans = pgTable('fv_loans', {
  id:          serial('id').primaryKey(),
  secretRate:  integer('secret_rate'),
  title:       varchar('title', { length: 255 }).notNull(),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  lockVersion: integer('lock_version').notNull().default(0),
})

const fv_docs = pgTable('fv_docs', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }),
  lockVersion: integer('lock_version').notNull().default(0),
  deletedAt:   timestamp('deleted_at'),
})

// Depth-2 include tree (loans → notes → writer) for the runtime registry's
// reachability walk — every lock-tokened model in the tree must be logged.
const fv_notes = pgTable('fv_notes', {
  id:          serial('id').primaryKey(),
  fvLoanId:    integer('fv_loan_id'),
  fvWriterId:  integer('fv_writer_id'),
  body:        varchar('body', { length: 255 }),
  lockVersion: integer('lock_version').notNull().default(0),
})

const fv_writers = pgTable('fv_writers', {
  id:          serial('id').primaryKey(),
  name:        varchar('name', { length: 255 }),
  lockVersion: integer('lock_version').notNull().default(0),
})

const schema = { fv_loans, fv_docs, fv_notes, fv_writers }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('fv_loans')
class FvLoan extends ApplicationRecord {
  static notes = hasMany('fv_notes', { foreignKey: 'fvLoanId' })
}

@modelDecorator('fv_docs')
@include(SoftDeletable)
class FvDoc extends ApplicationRecord {}

@modelDecorator('fv_notes')
class FvNote extends ApplicationRecord {
  static writer = belongsTo('fv_writers', { foreignKey: 'fvWriterId' })
}

@modelDecorator('fv_writers')
class FvWriter extends ApplicationRecord {}

// ── Doors (real @crud decorators → real buildRouter funnel) ──────────────────

const P = ['title', 'stage', 'brokerId']            // the door's projection

@controller('/fv-loans')
@crud(FvLoan as any, {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' }, perPage: 25 },
  get:    { expose: P, abilities: true },
  create: { permit: ['title', 'stage', 'brokerId'] },
  update: { permit: ['title', 'stage', 'brokerId'], optimisticLock: true },
  wire: 'columnar',
} as any)
class FvLoanController extends ActiveController {}

@controller('/fv-docs')
@crud(FvDoc as any, {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' }, perPage: 25 },
  get:    { expose: ['title'], abilities: true },
  create: { permit: ['title'] },
  update: { permit: ['title'], optimisticLock: true },
  wire: 'columnar',
} as any)
class FvDocController extends ActiveController {}

// Depth-2 include tree door: registration must log fv_notes AND fv_writers
// (the reachability walk, not just the root+direct children).
@controller('/fv-loan-tree')
@crud(FvLoan as any, {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' }, perPage: 25 },
  get:    { expose: P, abilities: true, include: [{ notes: ['writer'] }] },
  update: { permit: ['title'], optimisticLock: true },
  wire: 'columnar',
} as any)
class FvLoanTreeController extends ActiveController {}

// A SCOPED columnar door (scopeBy — tenancy from request context): validate
// and splice must run the scope exactly as show/index do (A3), and the
// hard-delete gone(D) lane must refuse on it (the tombstone cannot be
// scope-checked — a scoped door answering it would be a cross-tenant
// existence + destroy-token oracle).
@controller('/fv-my-loans')
@crud(FvLoan as any, {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' }, perPage: 25 },
  get:    { expose: P, abilities: true },
  update: { permit: ['title'], optimisticLock: true },
  wire: 'columnar',
  scopeBy: (ctrl: any) => ({ brokerId: ctrl.context?.brokerId ?? -1 }),
} as any)
class FvMyLoanController extends ActiveController {}

// An `only:`-scoped @before auth gate naming ONLY the CRUD actions — the
// generated validate/splice siblings must still run it (hook aliasing:
// validate ≈ get, splice ≈ index; the bypass was a review blocker).
@controller('/fv-guarded-loans')
@crud(FvLoan as any, {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' }, perPage: 25 },
  get:    { expose: P, abilities: true },
  update: { permit: ['title'], optimisticLock: true },
  wire: 'columnar',
} as any)
class FvGuardedLoanController extends ActiveController {
  @before({ only: ['get', 'index'] })
  requireAuth() {
    if (!(this as any).context?.authed) throw new Unauthorized('guarded door')
  }
}

let loanRouter: Record<string, any>
let docRouter: Record<string, any>
let treeRouter: Record<string, any>
let myRouter: Record<string, any>
let guardedRouter: Record<string, any>

// ── DB setup ─────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new Pool({ connectionString: container.getConnectionUri(), ssl: false })
  const db = drizzle({ client: pool, schema })
  boot(db as any, schema)

  await pool.query(`
    CREATE TABLE fv_loans (
      id SERIAL PRIMARY KEY,
      secret_rate INTEGER,
      title VARCHAR(255) NOT NULL,
      stage INTEGER NOT NULL DEFAULT 0,
      broker_id INTEGER,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE fv_docs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255),
      lock_version INTEGER NOT NULL DEFAULT 0,
      deleted_at TIMESTAMP
    );
    CREATE TABLE fv_notes (
      id SERIAL PRIMARY KEY,
      fv_loan_id INTEGER,
      fv_writer_id INTEGER,
      body VARCHAR(255),
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE fv_writers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    ${WRITE_LOG_SCHEMA_SQL}
  `)

  resetWriteLogRegistry()
  loanRouter    = buildRouter(FvLoanController as any).router
  docRouter     = buildRouter(FvDocController as any).router
  treeRouter    = buildRouter(FvLoanTreeController as any).router
  myRouter      = buildRouter(FvMyLoanController as any).router
  guardedRouter = buildRouter(FvGuardedLoanController as any).router
  void treeRouter
  // buildRouter derived the logged set from the columnar doors — no knob.
  // fv_notes AND fv_writers prove the DEPTH-2 reachability walk: dropping
  // the recursion (registering only roots, or roots + direct children)
  // would leave included child models unlogged — their saves would skip the
  // write-log entirely and their own doors' validations would gap forever.
  expect(loggedTableNames().sort()).toEqual(['fv_docs', 'fv_loans', 'fv_notes', 'fv_writers'])
}, 120_000)

afterAll(async () => {
  resetWriteLogRegistry()
  await pool?.end()
  await container?.stop()
})

const ctxOpts = { context: {} } as any

// ── Forbidden corruption 1 ───────────────────────────────────────────────────

describe('forbidden corruption 1: a 304 never freshens a cell the client does not hold', () => {
  it('out-of-P write ⇒ fresh(V); certify advances ONLY P (held fields), nothing else', async () => {
    const store = new EntityStore()
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

    const created: any = await call(loanRouter['create'], {
      data: { title: 'Marina refi', stage: 0, brokerId: 7 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)

    const entry0 = store.get('fv_loans', id)!
    expect(projFreshAt(entry0, P)).toBe(0)                 // client holds P at the create token

    // A field OUTSIDE P moves (server-side write through the model — the
    // write-log's save() hook is the same one the door's PATCH exercises)
    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ secretRate: 42 })                   // token 0 → 1, bitmap {secretRate}

    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res).toEqual({ status: 'fresh', v: 1 })         // P untouched in (0, 1] ⇒ 304

    // The generated dispatch: fresh ⇒ store.certify(P, V, W)
    store.certify('fv_loans', id, P, res.v, 0)
    const entry = store.get('fv_loans', id)!
    for (const f of P) expect(lastSeenOf(entry, f)).toBe(1)      // P certified at V
    expect(lastSeenOf(entry, 'id')).toBe(0)                      // outside P: untouched
    expect(lastSeenOf(entry, 'secretRate')).toBeNull()           // never held — never freshened
  })

  it('an IN-P write ⇒ the slice (never fresh), and the slice is the ONE serializer’s envelope', async () => {
    const store = new EntityStore()
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

    const created: any = await call(loanRouter['create'], {
      data: { title: 'Bridge', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ title: 'Bridge (rev)' })            // IN P — token 1

    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res.status).toBe('stale')
    // A0: byte-shape of the GET — same columnar envelope, same k discipline
    const viaGet: any = await call(loanRouter['get'], { id } as any, ctxOpts)
    expect(res.envelope.entities['fv_loans'].k).toEqual(viaGet.entities['fv_loans'].k)
    expect(res.envelope.entities['fv_loans'].v).toEqual([1])

    mergeEnvelope(store, res.envelope)                     // dispatch: stale ⇒ mergeEnvelope
    const entry = store.get('fv_loans', id)!
    expect(entry.fields['title']).toBe('Bridge (rev)')
    expect(projFreshAt(entry, P)).toBe(1)                  // W advances past the interval — self-healing
  })

  it('the GC/stale-re-merge replay: certify skips every field whose lastSeen fell below the issue-time W', async () => {
    const store = new EntityStore()
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

    const created: any = await call(loanRouter['create'], {
      data: { title: 'Replay', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const staleEnvelope: any = await call(loanRouter['get'], { id } as any, ctxOpts)  // payload at token 0

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ title: 'Replay v1' })                                          // token 1 (IN P)
    const freshEnvelope: any = await call(loanRouter['get'], { id } as any, ctxOpts)  // payload at token 1
    mergeEnvelope(store, freshEnvelope)
    const W = projFreshAt(store.get('fv_loans', id)!, P)!
    expect(W).toBe(1)

    await rec.update({ secretRate: 9 })                    // token 2, outside P
    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: W,
    } as any, ctxOpts)
    expect(res).toEqual({ status: 'fresh', v: 2 })

    // While the 304 was "in flight": the entry is GC'd, then a REPLAYED
    // stale GET (token 0) re-merges — lastSeen(P) is now 0 < W
    store.remove('fv_loans', id)
    mergeEnvelope(store, staleEnvelope)
    expect(projFreshAt(store.get('fv_loans', id)!, P)).toBe(0)

    store.certify('fv_loans', id, P, res.v, W)             // M4 apply-time guard
    const entry = store.get('fv_loans', id)!
    for (const f of P) expect(lastSeenOf(entry, f)).toBe(0)      // NO certification — the
    expect(entry.fields['title']).toBe('Replay')                 // stale value never gets stamped V
  })
})

// ── Forbidden corruption 2 ───────────────────────────────────────────────────

describe('forbidden corruption 2: a 304 never certifies across a lifecycle event', () => {
  it('hard destroy: stale-W validation answers gone(D) with the REAL destroy token; the floor lands', async () => {
    const store = new EntityStore()
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

    const created: any = await call(loanRouter['create'], {
      data: { title: 'Doomed', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ title: 'Doomed v1' })               // token 1
    const echo: any = await call(loanRouter['destroy'], { id } as any, ctxOpts)
    expect(echo.touched[0]).toMatchObject({ op: 'destroy', version: 2 })   // D = loaded+1

    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res).toEqual({ status: 'gone', d: 2 })          // never fresh — and D is the
    expect(await latestDestroyToken('fv_loans', id)).toBe(2)  // tombstone's, not fabricated

    store.destroy('fv_loans', id, res.d)                   // dispatch: gone ⇒ M2 floor
    expect(isGone(store.get('fv_loans', id)!)).toBe(true)
  })

  it('soft destroy → undelete: stale-W validation answers the slice (lifecycle rows trip clause ii), never fresh', async () => {
    const store = new EntityStore()
    const docProjId = validatableMask(FvDoc, { get: { expose: ['title'], abilities: true } } as any).projId

    const created: any = await call(docRouter['create'], { data: { title: 'Phoenix' } } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)                          // client holds title@0

    const doc: any = await (FvDoc as any).find(id)
    await doc.destroy()                                    // soft: token 1, lifecycle=2
    await doc.restore()                                    // token 2, lifecycle=3 (re-creation)

    const res: any = await call(docRouter['validate'], {
      id, projId: docProjId, ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res.status).toBe('stale')                       // clause (ii): NEVER fresh across
    expect(res.envelope.entities['fv_docs'].v).toEqual([2])  // destroy+undelete — even though
                                                           // title's VALUE never changed
  })

  it('undelete-ONLY interval: W = the destroy token, restore after — clause (ii) trips on lifecycle=3 alone', async () => {
    const docProjId = validatableMask(FvDoc, { get: { expose: ['title'], abilities: true } } as any).projId

    const created: any = await call(docRouter['create'], { data: { title: 'Lazarus' } } as any, ctxOpts)
    const id = created.membership.pks[0]
    const doc: any = await (FvDoc as any).find(id)
    await doc.destroy()                                    // token 1, lifecycle=2
    // A client can lawfully hold W = 1 (the destroyed-at-exactly-W test
    // proves destroy-echo merges land cells at the destroy token). Then:
    await doc.restore()                                    // token 2, lifecycle=3

    // Interval (1, 2] contains ONLY the undelete row — no destroy pairs it.
    // Certifying across a re-creation is forbidden corruption 2: never fresh.
    const res: any = await call(docRouter['validate'], {
      id, projId: docProjId, ifNoneMatch: 1,
    } as any, ctxOpts)
    expect(res.status).toBe('stale')
    expect(res.envelope.entities['fv_docs'].v).toEqual([2])
  })

  it('a door SERVING soft-deleted rows: clause (iii) reads liveness from the row itself (V == W, record found)', async () => {
    // Both fixture doors hide deleted rows behind SoftDeletable's default
    // scope, so their destroyed-record validations take the 404-lane
    // re-check. This drives the RECORD-path clause (iii) — an unscoped/admin
    // door whose relation returns the soft-deleted row — which must answer
    // gone off the row's own soft-delete column, never 304 at V == W.
    const config: any = { get: { expose: ['title'], abilities: true }, wire: 'columnar' }
    const created: any = await call(docRouter['create'], { data: { title: 'ClauseIII' } } as any, ctxOpts)
    const id = created.membership.pks[0]
    const doc: any = await (FvDoc as any).find(id)
    await doc.destroy()                                    // soft destroy at token 1 — V = 1

    const res = await defaultValidate(
      (FvDoc as any).unscoped(),                           // the door serves deleted rows
      FvDoc, config,
      { id, projId: validatableMask(FvDoc, config).projId, ifNoneMatch: 1 },
    )
    expect(res).toEqual({ status: 'gone', d: 1 })
  })

  it('W > V (a token from the future) answers the slice server-side, never fresh', async () => {
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Clamped', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: 999,                        // V is 0 — the empty interval would
    } as any, ctxOpts)                                     // otherwise read as vacuously fresh
    expect(res.status).toBe('stale')
  })

  it('destroyed at exactly W (empty interval, V == W): clause (iii) still answers gone', async () => {
    const docProjId = validatableMask(FvDoc, { get: { expose: ['title'], abilities: true } } as any).projId

    const created: any = await call(docRouter['create'], { data: { title: 'EdgeCase' } } as any, ctxOpts)
    const id = created.membership.pks[0]
    const doc: any = await (FvDoc as any).find(id)
    await doc.destroy()                                    // soft destroy AT token 1 — current V = 1

    // The client somehow holds cells at W = V = 1 (e.g. a destroy-echo merge).
    // Interval (1, 1] is EMPTY — clauses (i)/(ii) pass vacuously. Without
    // clause (iii) this would 304 a destroyed record.
    const res: any = await call(docRouter['validate'], {
      id, projId: docProjId, ifNoneMatch: 1,
    } as any, ctxOpts)
    expect(res).toEqual({ status: 'gone', d: 1 })
  })

  it('gap rule: a pruned/pre-logging interval degrades to the slice, never fresh', async () => {
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Gappy', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ secretRate: 1 })                    // token 1, outside P
    await rec.update({ secretRate: 2 })                    // token 2, outside P

    // Simulate retention pruning token 1 out of the interval
    await pool.query(
      `DELETE FROM record_write_log WHERE model = 'fv_loans' AND pk = $1 AND token = 1`, [String(id)])

    const res: any = await call(loanRouter['validate'], {
      id, projId, ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res.status).toBe('stale')                       // (0,2] has a hole ⇒ conservative slice
  })

  it('deploy skew: a projId the door did not compile answers the slice at the door’s ACTUAL mask, never fresh', async () => {
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Skewed', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const res: any = await call(loanRouter['validate'], {
      id, projId: 'ffffffffffff', ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res.status).toBe('stale')
    expect(res.envelope.entities['fv_loans'].k)
      .toEqual(['id', 'title', 'stage', 'brokerId'])       // the door's mask, not the client's
  })
})

// ── The membership lane riders ───────────────────────────────────────────────

describe('membership lane (structure token + counter tag + v1 splice)', () => {
  it('index responses carry the structure token and the in-commit door tag; the splice satisfies O15 trivially', async () => {
    const idx1: any = await call(loanRouter['index'], {} as any, ctxOpts)
    expect(typeof idx1.membership.structureToken).toBe('string')
    expect(idx1.membership.structureToken).toHaveLength(16)
    expect(typeof idx1.membership.tag).toBe('number')

    // value churn must NOT bust the structure token (facets/value exclusion)
    const anyId = idx1.membership.pks[0]
    const rec: any = await (FvLoan as any).find(anyId)
    await rec.update({ secretRate: 777 })
    const idx2: any = await call(loanRouter['index'], {} as any, ctxOpts)
    expect(idx2.membership.structureToken).toBe(idx1.membership.structureToken)
    expect(idx2.membership.tag).toBe(idx1.membership.tag)  // value writes don't bump (v1 rule)

    // a lifecycle write bumps the tag in-commit and changes the structure
    await call(loanRouter['create'], { data: { title: 'New member', stage: 0 } } as any, ctxOpts)
    const idx3: any = await call(loanRouter['index'], {} as any, ctxOpts)
    expect(idx3.membership.tag).toBe(idx1.membership.tag + 1)
    expect(idx3.membership.structureToken).not.toBe(idx1.membership.structureToken)

    // v1 splice: replace-all with list@to — apply(list@from, ops) = list@to (O15)
    const splice: any = await call(loanRouter['splice'], { fromTag: 0 } as any, ctxOpts)
    expect(splice.ops).toEqual([{ op: 'replace-all', pks: idx3.membership.pks }])
    expect(applySplice(idx1.membership.pks, splice.ops)).toEqual(idx3.membership.pks)
    expect(splice.toTag).toBe(idx3.membership.tag)
  })

  it('paramsHash: distinct membership-determining params hash apart; key order never matters', () => {
    // key-order invariance (canonicalization)
    expect(paramsHashOf({ filters: { a: 1, b: 2 } })).toBe(paramsHashOf({ filters: { b: 2, a: 1 } }))
    // distinctness across every membership-determining input
    expect(paramsHashOf({ filters: { a: 1 } })).not.toBe(paramsHashOf({ filters: { a: 2 } }))
    expect(paramsHashOf({ q: 'x' })).not.toBe(paramsHashOf({}))
    expect(paramsHashOf({ scopes: ['active'] })).not.toBe(paramsHashOf({}))
    expect(paramsHashOf({ sort: { field: 'id', dir: 'asc' } }))
      .not.toBe(paramsHashOf({ sort: { field: 'id', dir: 'desc' } }))
    expect(paramsHashOf({ page: 1 })).not.toBe(paramsHashOf({ page: 2 }))
  })

  it('contract probes: the validate surface refuses to answer fresh off a forged projId', async () => {
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Probe target', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const probes = buildContractProbes(FvLoanController, { recordId: id })
    expect(probes.some(p => p.procedure === 'validate')).toBe(true)
    const failures = await runContractProbes(probes, (proc, input) =>
      call(loanRouter[proc], input as any, ctxOpts))
    expect(failures).toEqual([])
  })
})

// ── A3 through the generated siblings: scope + hooks ─────────────────────────

describe('scoped door (scopeBy): validate and splice run the tenancy exactly as show/index', () => {
  const myProjId = () => validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

  it('another tenant’s record validates to NOT_FOUND — never fresh, never gone', async () => {
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Broker 7 loan', stage: 0, brokerId: 7 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]

    // The owner validates fine through the scoped door…
    const mine: any = await call(myRouter['validate'], {
      id, projId: myProjId(), ifNoneMatch: 0,
    } as any, { context: { brokerId: 7 } } as any)
    expect(mine).toEqual({ status: 'fresh', v: 0 })

    // …another tenant gets show's 404 (A3: scope membership must not leak)
    await expect(call(myRouter['validate'], {
      id, projId: myProjId(), ifNoneMatch: 0,
    } as any, { context: { brokerId: 8 } } as any)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a SCOPED door never answers gone(D) off the tombstone (no cross-tenant destroy oracle); unscoped doors still do', async () => {
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Broker 7 doomed', stage: 0, brokerId: 7 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    await call(loanRouter['destroy'], { id } as any, ctxOpts)          // D = 1, hard delete

    // The tombstone stores no scope columns — even the OWNER's context gets
    // the 404 through the scoped door (and so does any other tenant probing
    // sequential pks, which is the point).
    for (const brokerId of [7, 8]) {
      await expect(call(myRouter['validate'], {
        id, projId: myProjId(), ifNoneMatch: 0,
      } as any, { context: { brokerId } } as any)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    // The unscoped door keeps the declared gone(D) lane
    const res: any = await call(loanRouter['validate'], {
      id, projId: myProjId(), ifNoneMatch: 0,
    } as any, ctxOpts)
    expect(res).toEqual({ status: 'gone', d: 1 })
  })

  it('splice through the scoped door answers ONLY the tenant’s membership', async () => {
    await call(loanRouter['create'], {
      data: { title: 'Broker 9 loan', stage: 0, brokerId: 9 },
    } as any, ctxOpts)
    const ctx7 = { context: { brokerId: 7 } } as any
    const idx7: any = await call(myRouter['index'], {} as any, ctx7)
    const splice7: any = await call(myRouter['splice'], { fromTag: 0 } as any, ctx7)
    expect(splice7.ops).toEqual([{ op: 'replace-all', pks: idx7.membership.pks }])
    const all: any = await call(loanRouter['index'], {} as any, ctxOpts)
    expect(idx7.membership.pks.length).toBeGreaterThan(0)
    expect(idx7.membership.pks.length).toBeLessThan(all.membership.pks.length)
  })
})

describe('hook aliasing: an only:[get,index]-scoped @before auth gate covers validate and splice', () => {
  it('the generated siblings refuse exactly as get/index do; an authed context passes', async () => {
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Guarded', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    const projId = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any).projId

    // Unauthenticated: get and index refuse — and so must their siblings
    // (the auth hook names only ['get', 'index']; before aliasing, validate
    // answered show-grade bytes and splice the full membership).
    await expect(call(guardedRouter['get'], { id } as any, ctxOpts))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(call(guardedRouter['validate'], { id, projId, ifNoneMatch: 0 } as any, ctxOpts))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(call(guardedRouter['splice'], { fromTag: 0 } as any, ctxOpts))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    // Authed: the whole lane works
    const authed = { context: { authed: true } } as any
    const res: any = await call(guardedRouter['validate'], { id, projId, ifNoneMatch: 0 } as any, authed)
    expect(res).toEqual({ status: 'fresh', v: 0 })
    const splice: any = await call(guardedRouter['splice'], { fromTag: 0 } as any, authed)
    expect(splice.ops[0]!.op).toBe('replace-all')
  })
})

// ── The CLIENT half, end-to-end (WS3: revalidateProjection through the real
//    generated funnel — the same dispatch the generated .with().revalidate
//    performs, driven here as the module the strings call) ──────────────────

describe('client dispatch: revalidateProjection against the real router', () => {
  function loanValidator(): ProjectionValidator {
    const mask = validatableMask(FvLoan, { get: { expose: P, abilities: true } } as any)
    return {
      model: 'fv_loans',
      fields: mask.fields,
      projId: mask.projId,
      validate: (input: any) => call(loanRouter['validate'], input as any, ctxOpts) as any,
      fetch: (id: any) => call(loanRouter['get'], { id } as any, ctxOpts) as any,
    }
  }

  it('signal ⇒ validate(W=projFreshAt) ⇒ fresh certifies ONLY the held mask at V', async () => {
    const store = new EntityStore()
    const spec = loanValidator()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'E2E fresh', stage: 0, brokerId: 3 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)                                  // client holds mask@0

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ secretRate: 5 })                            // token 1, OUTSIDE the mask

    const out = await revalidateProjection(store, spec, id, { signal: 1 })
    expect(out).toEqual({ outcome: 'fresh', v: 1 })
    const entry = store.get('fv_loans', id)!
    for (const f of spec.fields) expect(lastSeenOf(entry, f)).toBe(1)
    expect(lastSeenOf(entry, 'secretRate')).toBeNull()             // never held — never freshened
    // and the whole projection is current again: a second dispatch skips
    expect(await revalidateProjection(store, spec, id, { signal: 1 })).toEqual({ outcome: 'current' })
  })

  it('an in-mask write dispatches the slice: values land from the DB and W self-heals', async () => {
    const store = new EntityStore()
    const spec = loanValidator()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'E2E stale', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ title: 'E2E stale (rev)' })                 // token 1, IN the mask

    const out = await revalidateProjection(store, spec, id, { signal: 1 })
    expect(out).toEqual({ outcome: 'stale' })
    const entry = store.get('fv_loans', id)!
    expect(entry.fields['title']).toBe('E2E stale (rev)')          // the DB's value, not a 200's word
    expect(projFreshAt(entry, spec.fields)).toBe(1)
  })

  it('a destroyed record dispatches gone(D): the floor lands from the tombstone token', async () => {
    const store = new EntityStore()
    const spec = loanValidator()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'E2E gone', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)
    await call(loanRouter['destroy'], { id } as any, ctxOpts)      // D = 1

    const out = await revalidateProjection(store, spec, id, { signal: 1 })
    expect(out).toEqual({ outcome: 'gone', d: 1 })
    expect(isGone(store.get('fv_loans', id)!)).toBe(true)
  })

  it('an unheld projection FETCHES through the real GET (never validates) and then holds the mask', async () => {
    const store = new EntityStore()                                // empty: nothing held
    const spec = loanValidator()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'E2E unheld', stage: 2 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]

    const out = await revalidateProjection(store, spec, id)
    expect(out).toEqual({ outcome: 'fetched' })
    const entry = store.get('fv_loans', id)!
    expect(entry.fields['title']).toBe('E2E unheld')
    expect(projFreshAt(entry, spec.fields)).toBe(0)                // now 304-able
  })

  it('a never-existed pk (no tombstone) evicts via the legacy 404 lane — no fabricated floor', async () => {
    const store = new EntityStore()
    store.merge('fv_loans', 999_999, { id: 999_999, title: 'ghost', stage: 0, brokerId: null }, { version: 0 })
    const spec = loanValidator()
    const out = await revalidateProjection(store, spec, 999_999, { signal: 1 })
    expect(out).toEqual({ outcome: 'evicted' })
    expect(store.get('fv_loans', 999_999)).toBeUndefined()
  })
})

// ── ACCEPTANCE EVIDENCE (the WS3 bar, run as one suite) ──────────────────────
//
// The describes below are the five acceptance items, each end-to-end: real
// Postgres, the REAL generated funnel (buildRouter's oRPC procedures), the
// REAL EntityStore + revalidateProjection dispatch — never a mocked half.

function specFor(router: Record<string, any>, model: any, config: any) {
  const mask = validatableMask(model, config)
  return {
    model: ((model as any)._activeDrizzleTableName ?? (model as any).tableName) as string,
    fields: mask.fields,
    projId: mask.projId,
    validate: (input: any) => call(router['validate'], input as any, ctxOpts) as any,
    fetch: (id: any) => call(router['get'], { id } as any, ctxOpts) as any,
  }
}
const loanSpec = () => specFor(loanRouter, FvLoan, { get: { expose: P, abilities: true } })
const docSpec  = () => specFor(docRouter, FvDoc, { get: { expose: ['title'], abilities: true } })

describe('acceptance 1 (rider): a partially-held projection NEVER validates — it fetches', () => {
  it('holding a strict subset of the mask has no lawful W: the validate callable is never invoked', async () => {
    const store = new EntityStore()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Partial hold', stage: 4, brokerId: 11 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]

    // The client holds only {id, title} — 2 of the mask's 4 fields.
    store.merge('fv_loans', id, { id, title: 'Partial hold' }, { version: 0 })
    expect(projFreshAt(store.get('fv_loans', id)!, loanSpec().fields)).toBeNull()

    const spec = {
      ...loanSpec(),
      validate: () => { throw new Error('FORBIDDEN: validate() must never run for a partial hold') },
    }
    const out = await revalidateProjection(store, spec, id, { signal: 1 })
    expect(out).toEqual({ outcome: 'fetched' })                  // full GET, ONE decoder
    const entry = store.get('fv_loans', id)!
    expect(entry.fields['stage']).toBe(4)                        // now whole —
    expect(projFreshAt(entry, loanSpec().fields)).toBe(0)        // and 304-able going forward
  })
})

describe('acceptance 2, end-to-end: the store never ends with a pre-destroy cell certified past D', () => {
  it('destroy variant: revalidate lands the REAL floor (floor = D); the pre-destroy cell dies', async () => {
    const store = new EntityStore()
    const spec = loanSpec()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Lifecycle A', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)                                // holds mask@0, W = 0

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ title: 'Lifecycle A v1' })                // token 1
    await call(loanRouter['destroy'], { id } as any, ctxOpts)    // D = 2

    const out = await revalidateProjection(store, spec, id, { signal: 2 })
    expect(out).toEqual({ outcome: 'gone', d: 2 })               // NEVER fresh across destroy
    const entry = store.get('fv_loans', id)!
    expect(entry.floor).toBe(2)                                  // floor = D, from the tombstone
    expect(isGone(entry)).toBe(true)                             // no cell survives at ≤ D:
    for (const f of spec.fields) {                               // every held lastSeen ≤ floor
      const ls = lastSeenOf(entry, f)
      expect(ls === null || ls <= entry.floor).toBe(true)        // nothing certified past D
    }
  })

  it('destroy+recreate variant (soft-delete lineage, same pk): the slice lands FRESH cells at the recreated token — never a pre-destroy certification', async () => {
    const store = new EntityStore()
    const spec = docSpec()
    const created: any = await call(docRouter['create'], { data: { title: 'Phoenix E2E' } } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)                                // holds title@0, W = 0

    const doc: any = await (FvDoc as any).find(id)
    await doc.destroy()                                          // token 1, lifecycle=2
    await doc.restore()                                          // token 2, lifecycle=3 — same pk, new life

    const out = await revalidateProjection(store, spec, id, { signal: 2 })
    expect(out).toEqual({ outcome: 'stale' })                    // clause (ii): NEVER a 304 across
    const entry = store.get('fv_docs', id)!                      // the lifecycle pair, even though
    expect(entry.fields['title']).toBe('Phoenix E2E')            // the VALUE never changed
    for (const f of spec.fields) expect(lastSeenOf(entry, f)).toBe(2)  // fresh cells AT the slice's
    expect(projFreshAt(entry, spec.fields)).toBe(2)              // token — merged, not certified
    expect(entry.floor).toBe(-Infinity)                          // live again: no floor claimed
    // and the healed W makes the next dispatch a clean skip
    expect(await revalidateProjection(store, spec, id, { signal: 2 })).toEqual({ outcome: 'current' })
  })
})

describe('acceptance 4 — O15: the membership splice property under random mutations, per door', () => {
  // Deterministic PRNG (mulberry32) — reproducible acceptance evidence.
  function mulberry32(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('loan door: apply(list@from, ops) = list@to on every splice; lifecycle writes (and ONLY they) bump the tag', async () => {
    const rand = mulberry32(0x5eed_2026)
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!
    const docTagBefore = (await call(docRouter['index'], {} as any, ctxOpts) as any).membership.tag

    for (let round = 0; round < 12; round++) {
      const from: any = await call(loanRouter['index'], {} as any, ctxOpts)
      const mutations = 1 + Math.floor(rand() * 3)
      let lifecycleOps = 0

      for (let m = 0; m < mutations; m++) {
        const live: Array<number> = from.membership.pks
        const roll = rand()
        if (roll < 0.4) {
          await call(loanRouter['create'], {
            data: { title: `O15 r${round}m${m}`, stage: round },
          } as any, ctxOpts)
          lifecycleOps++
        } else if (roll < 0.7 && live.length > 2) {
          await call(loanRouter['destroy'], { id: pick(live) } as any, ctxOpts)
          lifecycleOps++
        } else if (live.length > 0) {
          const rec: any = await (FvLoan as any).find(pick(live))
          if (rec) await rec.update({ secretRate: Math.floor(rand() * 1000) })   // VALUE-only
        }
      }

      const splice: any = await call(loanRouter['splice'], { fromTag: from.membership.tag } as any, ctxOpts)
      const to: any = await call(loanRouter['index'], {} as any, ctxOpts)

      // THE O15 axiom — apply(list@from, ops) = list@to, every round
      expect(applySplice(from.membership.pks, splice.ops)).toEqual(to.membership.pks)
      expect(splice.fromTag).toBe(from.membership.tag)
      expect(splice.toTag).toBe(to.membership.tag)
      expect(splice.door).toBe('/fv-loans')
      expect(splice.paramsHash).toBe(paramsHashOf({}))           // server-computed echo

      // The counter is exactly the lifecycle-write count (v1 conservative
      // bump; value writes never bump — the stated residual, pinned)
      expect(to.membership.tag - from.membership.tag).toBe(lifecycleOps)
      if (lifecycleOps === 0) {
        expect(to.membership.structureToken).toBe(from.membership.structureToken)
      }
    }

    // Per-door isolation: 12 rounds of loan churn never bumped the doc door
    const docTagAfter = (await call(docRouter['index'], {} as any, ctxOpts) as any).membership.tag
    expect(docTagAfter).toBe(docTagBefore)
  })

  it('doc door (soft-delete lineage): the property holds across soft destroy AND restore', async () => {
    const rand = mulberry32(0xd0c_2026)
    const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!
    const softDeleted: number[] = []

    for (let round = 0; round < 8; round++) {
      const from: any = await call(docRouter['index'], {} as any, ctxOpts)
      let lifecycleOps = 0
      const roll = rand()
      if (roll < 0.4 || from.membership.pks.length < 2) {
        await call(docRouter['create'], { data: { title: `O15 doc r${round}` } } as any, ctxOpts)
        lifecycleOps++
      } else if (roll < 0.7 || softDeleted.length === 0) {
        const id = pick(from.membership.pks as number[])
        const doc: any = await (FvDoc as any).find(id)
        await doc.destroy()                                      // soft: lifecycle=2
        softDeleted.push(id)
        lifecycleOps++
      } else {
        const id = softDeleted.pop()!
        const doc: any = await (FvDoc as any).unscoped().where({ id }).first()
        await doc.restore()                                      // lifecycle=3
        lifecycleOps++
      }

      const splice: any = await call(docRouter['splice'], { fromTag: from.membership.tag } as any, ctxOpts)
      const to: any = await call(docRouter['index'], {} as any, ctxOpts)
      expect(applySplice(from.membership.pks, splice.ops)).toEqual(to.membership.pks)
      expect(splice.toTag).toBe(to.membership.tag)
      expect(to.membership.tag - from.membership.tag).toBe(lifecycleOps)
    }
  })

  it('tag mismatch ⇒ the full-fetch fallback: an unknown fromTag still converges to the door’s ACTUAL list, and an unknown op is a hard client error (the fallback trigger)', async () => {
    // A client whose fromTag the server has never seen (evicted cache, deploy
    // skew, clock of another door): v1 answers replace-all with list@to — the
    // splice IS the full fetch, so the fallback converges by construction.
    const splice: any = await call(loanRouter['splice'], { fromTag: 999_999 } as any, ctxOpts)
    const idx: any = await call(loanRouter['index'], {} as any, ctxOpts)
    expect(applySplice([], splice.ops)).toEqual(idx.membership.pks)          // from ANY prior list
    expect(applySplice([1, 2, 3], splice.ops)).toEqual(idx.membership.pks)   // — including garbage
    expect(splice.toTag).toBe(idx.membership.tag)

    // The client twin's drift tripwire: a future op kind the client does not
    // know must throw (⇒ generated hooks fall back to the full index fetch),
    // never silently corrupt the list.
    expect(() => applySplice([1], [{ op: 'shuffle' } as any]))
      .toThrow(/unknown op 'shuffle'/)
  })
})

describe('acceptance 5 — retention expiry ⇒ the conservative slice, never a 304; tombstones are exempt', () => {
  it('REAL pruneWriteLog expires the interval: validation degrades to the slice, the slice self-heals W, and post-heal 304s work again', async () => {
    const store = new EntityStore()
    const spec = loanSpec()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Retention', stage: 1 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)                                // holds mask@0, W = 0

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ secretRate: 10 })                         // token 1, OUTSIDE the mask
    await rec.update({ secretRate: 20 })                         // token 2, OUTSIDE the mask
    // Without retention this exact validation would be fresh(2) — proven by
    // the out-of-P tests above. Now age the lifecycle=0 rows past the window
    // and run the REAL pruner (the un-aged create row stays; only
    // lifecycle=2 tombstones are exempt from aging by rule).
    await pool.query(
      `UPDATE record_write_log SET committed_at = now() - interval '100 hours'
       WHERE model = 'fv_loans' AND pk = $1 AND lifecycle = 0`, [String(id)])
    expect(await pruneWriteLog()).toBeGreaterThanOrEqual(2)      // default 72h window

    const out = await revalidateProjection(store, spec, id, { signal: 2 })
    expect(out).toEqual({ outcome: 'stale' })                    // gap rule: NEVER fresh over
    const entry = store.get('fv_loans', id)!                     // a pruned interval — even though
    expect(entry.fields['stage']).toBe(1)                        // no mask field ever changed
    expect(projFreshAt(entry, spec.fields)).toBe(2)              // the slice advanced W past the gap

    // Self-healing: the gap is now outside every future interval — the next
    // out-of-mask write 304s again through the same funnel.
    await rec.update({ secretRate: 30 })                         // token 3, outside the mask
    const healed = await revalidateProjection(store, spec, id, { signal: 3 })
    expect(healed).toEqual({ outcome: 'fresh', v: 3 })
    for (const f of spec.fields) expect(lastSeenOf(store.get('fv_loans', id)!, f)).toBe(3)
  })

  it('lifecycle rows survive retention forever: gone(D) is still answerable after the prune', async () => {
    const store = new EntityStore()
    const spec = loanSpec()
    const created: any = await call(loanRouter['create'], {
      data: { title: 'Tombstone outlives retention', stage: 0 },
    } as any, ctxOpts)
    const id = created.membership.pks[0]
    mergeEnvelope(store, created)

    const rec: any = await (FvLoan as any).find(id)
    await rec.update({ secretRate: 1 })                          // token 1 (lifecycle=0, prunable)
    await call(loanRouter['destroy'], { id } as any, ctxOpts)    // D = 2 (lifecycle=2, EXEMPT)

    await pool.query(
      `UPDATE record_write_log SET committed_at = now() - interval '100 hours'
       WHERE model = 'fv_loans' AND pk = $1`, [String(id)])      // age EVERY row of the lineage
    await pruneWriteLog()

    expect(await latestDestroyToken('fv_loans', id)).toBe(2)     // the tombstone map survived
    const out = await revalidateProjection(store, spec, id, { signal: 2 })
    expect(out).toEqual({ outcome: 'gone', d: 2 })               // T4: the REAL D, post-retention
    expect(store.get('fv_loans', id)!.floor).toBe(2)
  })
})

