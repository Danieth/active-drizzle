// @vitest-environment node
/**
 * The Rule M handshake (transport WS2 acceptance, item 3): a columnar
 * response produced by the REAL server handlers over REAL Postgres, funneled
 * through the GENERATED client path (the `_loanMergeEcho` /
 * `mergeRecordEnvelope` shapes react-generator.ts emits, copied verbatim
 * below), must land PER-FIELD lastSeen in the EntityStore equal to the
 * database's actual lock ints — i.e. the tokens are threaded end-to-end,
 * never dropped — and the landed projection must be certify-able (M4: a 304
 * at the coverage watermark re-certifies every field).
 *
 * This is the seam neither package pins alone: the controller suite proves
 * the envelope, the wire-envelope suite proves the decoder on synthetic
 * envelopes; this file drives server bytes into the store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pgTable, serial, integer, varchar, text } from 'drizzle-orm/pg-core'

import {
  ApplicationRecord,
  boot,
  MODEL_REGISTRY,
  model as modelDecorator,
  Attr,
  hasMany,
  belongsTo,
  resolveWireAssociation,
} from '@active-drizzle/core'
import { defaultGet, defaultUpdate, defaultDestroy } from '@active-drizzle/controller'

import {
  EntityStore,
  lastSeenOf,
  isCurrent,
  isGone,
  visibleFields,
  projFreshAt,
} from '../src/entity-store.js'
import { mergeEnvelope, mergeRecordEnvelope } from '../src/wire-envelope.js'

// ── Schema + models (the parity suite's loans door) ──────────────────────────

const users = pgTable('users', {
  id:   serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
})
const loans = pgTable('loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }).notNull(),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  lockVersion: integer('lock_version').notNull().default(0),
})
const notes = pgTable('notes', {
  id:          serial('id').primaryKey(),
  loanId:      integer('loan_id').notNull(),
  authorId:    integer('author_id'),
  body:        text('body'),
  position:    integer('position').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})
const schema = { users, loans, notes }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('users')
class User extends ApplicationRecord {}

@modelDecorator('notes')
class Note extends ApplicationRecord {
  static loan   = belongsTo('loans')
  static author = belongsTo('users', { foreignKey: 'authorId' })
}

@modelDecorator('loans')
class Loan extends ApplicationRecord {
  static notes  = hasMany('notes', { order: { position: 'asc' }, acceptsNested: { allowDestroy: true } })
  static broker = belongsTo('users', { foreignKey: 'brokerId' })
  static stage  = Attr.enum({ open: 0, won: 1 } as const)
}
void User
void Note

const columnarCfg: any = {
  get: {
    expose: ['title', 'stage', 'brokerId'],
    abilities: true,
    include: [{ notes: ['author'] }],
  },
  update: { permit: ['title', 'stage', 'notesAttributes'], optimisticLock: true },
  wire: 'columnar',
}

// ── The GENERATED client path, verbatim (react-generator.ts emitWireSpec /
//    _entities.gen). The one substitution: `entityStore` is a fresh local
//    store instead of the app singleton — same call shapes, isolated state. ──

const entityStore = new EntityStore()
// _entities.gen.ts registration (json/jsonb/.array() → 'jsonb'; columnar
// hasMany ids → 'pkArray'; keyed by table)
entityStore.registerFieldKinds('loans', { noteIds: 'pkArray' })
entityStore.registerFieldKinds('notes', {})
entityStore.registerFieldKinds('users', {})

/** Columnar wire spec — compiled reassembly knowledge for this door's SHOW/echo responses (get include tree). */
const _loanWireSpec = { table: 'loans', pk: 'id', includes: [{ name: 'notes', table: 'notes', kind: 'hasMany', fk: 'loanId', idsColumn: 'noteIds', includes: [{ name: 'author', table: 'users', kind: 'belongsTo', fk: 'authorId' }] }] }
/** This door's projected columns — the mask store-materialized list rows read through. */
const _loanWireFields = ['id', 'title', 'stage', 'brokerId', 'noteIds']
/** Columnar echo decode (P6) — the funnel every mutation response takes. */
const _loanMergeEcho = (res: any): any =>
  res && typeof res === 'object' && res.entities
    ? mergeRecordEnvelope(entityStore, res, _loanWireSpec)
    : res && typeof res === 'object' && res.touched
      ? (mergeEnvelope(entityStore, res), res)
      : res

// ── DB setup ─────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: Pool
let dana: any, bob: any
let l1: any
let n1: any, n2: any

const dbLock = async (table: string, id: number): Promise<number> =>
  (await pool.query(`SELECT lock_version FROM ${table} WHERE id = $1`, [id])).rows[0].lock_version

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new Pool({ connectionString: container.getConnectionUri(), ssl: false })
  boot(drizzle({ client: pool, schema }) as any, schema)

  await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100)
    );
    CREATE TABLE loans (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      stage INTEGER NOT NULL DEFAULT 0,
      broker_id INTEGER,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE notes (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL,
      author_id INTEGER,
      body TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
  `)

  dana = await (User as any).create({ name: 'Dana' })
  bob  = await (User as any).create({ name: 'Bob' })
  l1   = await (Loan as any).create({ title: 'Marina refi', stage: 'open', brokerId: bob.id })
  n1   = await (Note as any).create({ loanId: l1.id, authorId: dana.id, body: 'Called back', position: 2 })
  n2   = await (Note as any).create({ loanId: l1.id, authorId: dana.id, body: 'Ping', position: 1 })
  // bump n1 once so per-row tokens are DISTINCT — a record-level shortcut
  // (one token stamped on every row) would be caught below
  const note1 = await (Note as any).find(n1.id)
  note1.body = 'Called back twice'
  await note1.save()
}, 120_000)

afterAll(async () => {
  await pool.end()
  await container.stop()
})

// Tests run in file order and SHARE the store deliberately — the handshake is
// a token flow, and each step's precondition is the previous step's landing.

let staleGetEnv: any // the pre-update GET envelope, replayed later as the stale slice

describe('the wire spec mirrors the RUNTIME association resolution (codegen and server are two implementations — pin, not assert)', () => {
  it('table / fk / idsColumn of every spec node equal resolveWireAssociation on the live models', () => {
    const notesMeta = resolveWireAssociation(Loan, 'notes')!
    const specNotes = _loanWireSpec.includes[0]!
    expect(specNotes.table).toBe(notesMeta.targetTable)
    expect(specNotes.fk).toBe(notesMeta.foreignKey)
    expect(specNotes.idsColumn).toBe(notesMeta.idsKey)
    expect(specNotes.kind).toBe(notesMeta.kind)

    const authorMeta = resolveWireAssociation(Note, 'author')!
    const specAuthor = specNotes.includes[0]!
    expect(specAuthor.table).toBe(authorMeta.targetTable)
    expect(specAuthor.fk).toBe(authorMeta.foreignKey)
    expect(specAuthor.kind).toBe(authorMeta.kind)
  })
})

describe('the Rule M handshake (server bytes → generated funnel → per-field lastSeen)', () => {
  it('GET through _loanMergeEcho lands every wire field at the row\'s ACTUAL lock int (tokens threaded, not dropped)', async () => {
    staleGetEnv = await defaultGet((Loan as any).all(), Loan, columnarCfg, l1.id)
    const out = _loanMergeEcho(staleGetEnv)

    // the app-facing shape survived (P6: FormSession untouched)
    expect(out.record.title).toBe('Marina refi')
    expect(out.record.notes.map((n: any) => n.id)).toEqual([n2.id, n1.id]) // association order
    expect(out.version).toBe(String(await dbLock('loans', l1.id)))

    // THE handshake assertion: per-field lastSeen == the database lock int,
    // for every field this door's projection reads
    const loanTok = await dbLock('loans', l1.id)
    const loanEntry = entityStore.get('loans', l1.id)!
    for (const f of _loanWireFields) {
      expect(lastSeenOf(loanEntry, f), `loans.${f}`).toBe(loanTok)
    }

    // child rows land at their OWN tokens (n1 was bumped to 1, n2 sits at 0
    // — distinct values prove per-row threading, not a stamped record token)
    expect(await dbLock('notes', n1.id)).toBe(1)
    expect(await dbLock('notes', n2.id)).toBe(0)
    expect(lastSeenOf(entityStore.get('notes', n1.id)!, 'body')).toBe(1)
    expect(lastSeenOf(entityStore.get('notes', n2.id)!, 'body')).toBe(0)

    // token-less models ride the untracked lane (v null → no lastSeen)
    expect(lastSeenOf(entityStore.get('users', dana.id)!, 'name')).toBeNull()
  }, 30_000)

  it('an UPDATE echo re-threads the bumped token; replaying the stale GET cannot regress any cell (M1 on real tokens)', async () => {
    const before = await dbLock('loans', l1.id)
    const echo = await defaultUpdate((Loan as any).all(), Loan, columnarCfg, l1.id, {
      title: 'Marina refi (rev)',
      _version: String(before),
    }, {}, undefined)
    const out = _loanMergeEcho(echo)
    expect(out.record.title).toBe('Marina refi (rev)')

    const after = await dbLock('loans', l1.id)
    expect(after).toBe(before + 1)
    const entry = entityStore.get('loans', l1.id)!
    expect(visibleFields(entry)['title']).toBe('Marina refi (rev)')
    for (const f of _loanWireFields) expect(lastSeenOf(entry, f), `loans.${f}`).toBe(after)

    // the stale pre-update envelope arrives late (network reorder) — the
    // per-field gate drops every cell of it
    _loanMergeEcho(staleGetEnv)
    const replayed = entityStore.get('loans', l1.id)!
    expect(visibleFields(replayed)['title']).toBe('Marina refi (rev)')
    expect(lastSeenOf(replayed, 'title')).toBe(after)
  }, 30_000)

  it('the landed projection is CERTIFY-able: projFreshAt is the real lock int and a 304 at a newer token re-freshens every field (M4)', async () => {
    const tok = await dbLock('loans', l1.id)
    const entry = entityStore.get('loans', l1.id)!

    // coverage watermark = min lastSeen over the door's fields — a dropped
    // token anywhere would make this null (not-304-able) and fail here
    const W = projFreshAt(entry, _loanWireFields)
    expect(W).toBe(tok)

    // a bare signal (elsewhere-edit rumor) makes every field suspect…
    entityStore.signal('loans', l1.id, tok + 3)
    for (const f of _loanWireFields) expect(isCurrent(entityStore.get('loans', l1.id)!, f)).toBe(false)

    // …and the 304 lane certifies the held cells at the validated token —
    // values untouched, freshness restored. This throws (dev O8 guard) if
    // any wire field landed unheld or untracked.
    entityStore.certify('loans', l1.id, _loanWireFields, tok + 3, W!)
    const certified = entityStore.get('loans', l1.id)!
    for (const f of _loanWireFields) expect(isCurrent(certified, f), `loans.${f}`).toBe(true)
    expect(visibleFields(certified)['title']).toBe('Marina refi (rev)')
  })

  it('a DESTROY echo through the same funnel raises the floor — the stale GET cannot resurrect (M2/T2)', async () => {
    const doomed = await (Loan as any).create({ title: 'Doomed', stage: 'open' })
    doomed.title = 'Doomed v2'
    await doomed.save() // token 1 — non-zero so the floor bites

    const getEnv = await defaultGet((Loan as any).all(), Loan, columnarCfg, doomed.id)
    _loanMergeEcho(getEnv)
    expect(visibleFields(entityStore.get('loans', doomed.id)!)['title']).toBe('Doomed v2')

    const echo = await defaultDestroy((Loan as any).all(), Loan, doomed.id, columnarCfg)
    const out = _loanMergeEcho(echo)
    expect(out).toBe(echo) // the touched lane returns the response itself
    expect(isGone(entityStore.get('loans', doomed.id)!)).toBe(true)

    // the pre-destroy payload replays (its cells sit at lastSeen == D - 1;
    // the destroy COMMIT owns its own token position, D = lock + 1) —
    // floor semantics keep the record gone
    _loanMergeEcho(getEnv)
    expect(isGone(entityStore.get('loans', doomed.id)!)).toBe(true)
  }, 30_000)
})
