/**
 * Columnar wire parity suite (transport WS2, DESIGN-wire-identity §2's
 * checklist as tests): the SAME door served flag-off (nested) and flag-on
 * (columnar) over real Postgres must agree on
 *
 *   - the pk set and ordering per table (root ordering + association order)
 *   - the column set == the ceiling slice exactly (nothing outside expose;
 *     k[0] = pk; the lock token NEVER a k column)
 *   - cell-by-cell codec equality (enums as labels, null vs absent pinned
 *     separately)
 *   - pagination / facets / emptyReason identical, membership-separated
 *   - v[i] == the lock column (null = untracked lane)
 *   - included hasMany as an ordered pk-array on the owner + child rows in
 *     their own table; shared lookups (authors) deduped
 *   - show/echo doors: same abilities/can/version; _key stitching moved to
 *     meta.nestedKeys; 409 conflicts carry the columnar envelope
 *   - flat loading (WS2b): 1 root query + one per included table, and the
 *     serializer is loader-agnostic (nested-loaded graph ⇒ same envelope)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pgTable, serial, integer, varchar, text, date, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

import {
  ApplicationRecord,
  boot,
  MODEL_REGISTRY,
  model as modelDecorator,
  Attr,
  hasMany,
  hasOne,
  belongsTo,
  attachFlatIncludes,
} from '@active-drizzle/core'
import {
  defaultIndex, defaultGet, defaultCreate, defaultUpdate, defaultDestroy,
  buildColumnarEnvelope, buildColumnarRecordEnvelope, usesColumnar,
  ActiveController, crud,
  Conflict,
} from '@active-drizzle/controller'

// ── Schema (tables + drizzle relations for the nested RQB lane) ──────────────

const users = pgTable('users', {
  id:   serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
})

const loans = pgTable('loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }).notNull(),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  secretRate:  integer('secret_rate'),
  lockVersion: integer('lock_version').notNull().default(0),
})

const notes = pgTable('notes', {
  id:          serial('id').primaryKey(),
  loanId:      integer('loan_id').notNull(),
  authorId:    integer('author_id'),
  body:        text('body'),
  kind:        integer('kind').notNull().default(0),
  position:    integer('position').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})

// Polymorphic-inverse + hasOne fixtures (flat-loader guards, real PG)
const attachments = pgTable('attachments', {
  id:             serial('id').primaryKey(),
  attachableType: varchar('attachable_type', { length: 50 }),
  attachableId:   integer('attachable_id'),
  name:           varchar('name', { length: 100 }),
})

const summaries = pgTable('summaries', {
  id:     serial('id').primaryKey(),
  loanId: integer('loan_id').notNull(),
  body:   text('body'),
})

// Attr-kind fixture (§2 checklist: identical codec output per Attr kind —
// money, dates, jsonb — flag-on vs flag-off).
const invoices = pgTable('invoices', {
  id:          serial('id').primaryKey(),
  amount:      integer('amount'),   // integer cents; Attr.money() transforms in place
  dueOn:       date('due_on', { mode: 'string' }),
  signedAt:    timestamp('signed_at', { withTimezone: true, mode: 'date' }),
  meta:        jsonb('meta'),
  lockVersion: integer('lock_version').notNull().default(0),
})

const loansRelations = relations(loans, ({ many, one }) => ({
  notes:  many(notes),
  broker: one(users, { fields: [loans.brokerId], references: [users.id] }),
}))
const notesRelations = relations(notes, ({ one }) => ({
  loan:   one(loans, { fields: [notes.loanId], references: [loans.id] }),
  author: one(users, { fields: [notes.authorId], references: [users.id] }),
}))

const schema = { users, loans, notes, invoices, attachments, summaries, loansRelations, notesRelations }

// ── Models ────────────────────────────────────────────────────────────────────

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('users')
class User extends ApplicationRecord {}

@modelDecorator('notes')
class Note extends ApplicationRecord {
  static loan   = belongsTo('loans')
  static author = belongsTo('users', { foreignKey: 'authorId' })
  static kind   = Attr.enum({ update: 0, warning: 1 } as const)
}

@modelDecorator('attachments')
class AttachmentRec extends ApplicationRecord {}
void AttachmentRec

@modelDecorator('summaries')
class SummaryRec extends ApplicationRecord {}
void SummaryRec

@modelDecorator('loans')
class Loan extends ApplicationRecord {
  static notes  = hasMany('notes', { order: { position: 'asc' }, acceptsNested: { allowDestroy: true } })
  static broker = belongsTo('users', { foreignKey: 'brokerId' })
  static stage  = Attr.enum({ open: 0, won: 1 } as const)
  // Flat-loader guard fixtures: polymorphic inverse + hasOne
  static attachments = hasMany('attachments', { as: 'attachable' })
  static brief       = hasOne('summaries')
}

@modelDecorator('invoices')
class Invoice extends ApplicationRecord {
  static amount   = Attr.money()                // integer cents in db, decimal dollars on the wire
  static signedAt = Attr.date()                 // Date on the model, ISO on the wire
  static meta     = Attr.json<{ tags: string[] }>()
}

// void the unused-var lint for classes referenced only via registry
void User

// ── Door configs: the SAME door, flag off vs on ──────────────────────────────

const baseConfig = {
  index: {
    sortable: ['id', 'title'],
    defaultSort: { field: 'id', dir: 'asc' as const },
    filterable: ['stage'],
    facets: ['stage'],
    include: [{ notes: ['author'] }],
    perPage: 25,
  },
  get: {
    expose: ['title', 'stage', 'brokerId'],
    abilities: true,
    include: [{ notes: ['author'] }],
  },
  create: { permit: ['title', 'stage', 'brokerId', 'notesAttributes'] },
  update: { permit: ['title', 'stage', 'notesAttributes'], optimisticLock: true },
}
const nestedCfg: any = { ...baseConfig, wire: 'nested' }
const columnarCfg: any = { ...baseConfig, wire: 'columnar' }

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Decode one columnar table into { pk → row-object } plus the parallel token. */
function decodeTable(section: { k: string[]; v: Array<number | null>; r: any[][] }) {
  const rows = new Map<any, Record<string, any>>()
  const tokens = new Map<any, number | null>()
  section.r.forEach((cells, i) => {
    const obj: Record<string, any> = {}
    section.k.forEach((col, j) => { obj[col] = cells[j] })
    rows.set(obj[section.k[0]!], obj)
    tokens.set(obj[section.k[0]!], section.v[i]!)
  })
  return { rows, tokens }
}

// ── DB setup ─────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: Pool
let queryCount = 0
let counting = false

let dana: any, ito: any, bob: any
let l1: any, l2: any
let n1: any, n2: any, n3: any

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  pool = new Pool({ connectionString: container.getConnectionUri(), ssl: false })
  const db = drizzle({
    client: pool,
    schema,
    logger: { logQuery: () => { if (counting) queryCount++ } },
  })
  boot(db as any, schema)

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
      secret_rate INTEGER,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE notes (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL,
      author_id INTEGER,
      body TEXT,
      kind INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE invoices (
      id SERIAL PRIMARY KEY,
      amount INTEGER,
      due_on DATE,
      signed_at TIMESTAMPTZ,
      meta JSONB,
      lock_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE attachments (
      id SERIAL PRIMARY KEY,
      attachable_type VARCHAR(50),
      attachable_id INTEGER,
      name VARCHAR(100)
    );
    CREATE TABLE summaries (
      id SERIAL PRIMARY KEY,
      loan_id INTEGER NOT NULL,
      body TEXT
    );
  `)

  dana = await (User as any).create({ name: 'Dana' })
  ito  = await (User as any).create({ name: 'Ito' })
  bob  = await (User as any).create({ name: 'Bob' })

  l1 = await (Loan as any).create({ title: 'Marina refi', stage: 'open', brokerId: bob.id, secretRate: 42 })
  l2 = await (Loan as any).create({ title: 'Bridge', stage: 'won', brokerId: bob.id, secretRate: 7 })

  // out-of-pk-order positions prove the association ORDER clause is honored
  n1 = await (Note as any).create({ loanId: l1.id, authorId: dana.id, body: 'Called back', kind: 'update', position: 2 })
  n2 = await (Note as any).create({ loanId: l1.id, authorId: dana.id, body: null, kind: 'warning', position: 1 })
  n3 = await (Note as any).create({ loanId: l2.id, authorId: ito.id, body: 'Signed', kind: 'update', position: 1 })
}, 60_000)

afterAll(async () => {
  await pool.end()
  await container.stop()
})

// ── The suite ────────────────────────────────────────────────────────────────

describe('usesColumnar', () => {
  it('reads the top-level wire flag', () => {
    expect(usesColumnar(columnarCfg)).toBe(true)
    expect(usesColumnar(nestedCfg)).toBe(false)
    expect(usesColumnar(undefined)).toBe(false)
  })
})

describe('INDEX door parity (flag-on vs flag-off)', () => {
  let flagOff: any
  let flagOn: any

  beforeAll(async () => {
    flagOff = await defaultIndex((Loan as any).all(), Loan, nestedCfg, { facets: true })
    flagOn  = await defaultIndex((Loan as any).all(), Loan, columnarCfg, { facets: true })
  })

  it('same pk set and root ordering; membership separated from entities', () => {
    expect(flagOn.membership.pks).toEqual(flagOff.data.map((r: any) => r.id))
    expect(flagOn.membership.pks).toEqual([l1.id, l2.id])
  })

  it('pagination and facets are identical (and live in membership)', () => {
    expect(flagOn.membership.pagination).toEqual(flagOff.pagination)
    expect(flagOn.membership.facets).toEqual(flagOff.facets)
    expect(flagOn.membership.facets).toEqual({ stage: { open: 1, won: 1 } })
  })

  it('the loans k is EXACTLY the ceiling slice: pk first, expose columns, the hasMany pk-array — and NEVER the lock token', () => {
    expect(flagOn.entities.loans.k).toEqual(['id', 'title', 'stage', 'brokerId', 'noteIds'])
    expect(flagOn.entities.loans.k).not.toContain('lockVersion')
    expect(flagOn.entities.loans.k).not.toContain('secretRate')
  })

  it('root cells match the nested lane cell-by-cell (codecs: enum labels)', () => {
    const { rows } = decodeTable(flagOn.entities.loans)
    for (const nestedRow of flagOff.data) {
      const cRow = rows.get(nestedRow.id)!
      expect(cRow.title).toEqual(nestedRow.title)
      expect(cRow.stage).toEqual(nestedRow.stage)      // 'open' / 'won' — the codec ran
      expect(cRow.brokerId).toEqual(nestedRow.brokerId)
    }
    expect(rows.get(l1.id)!.stage).toBe('open')
  })

  it('included hasMany = ordered pk-array on the owner (association order honored) + child rows once each', () => {
    const { rows } = decodeTable(flagOn.entities.loans)
    // position asc: n2 (pos 1) before n1 (pos 2)
    expect(rows.get(l1.id)!.noteIds).toEqual([n2.id, n1.id])
    expect(rows.get(l2.id)!.noteIds).toEqual([n3.id])
    // KNOWN NESTED-LANE GAP (pinned, reported): drizzle RQB include loading
    // does NOT apply the association's declared `order` — it returns pk
    // order. The flat loader honors the order clause (the §2 checklist's
    // requirement, and what `loan.notes` itself does). Same SET either way.
    expect(flagOff.data[0].notes.map((n: any) => n.id).sort()).toEqual([n1.id, n2.id].sort())
    // child rows land once each in their OWN table
    const noteRows = decodeTable(flagOn.entities.notes)
    expect([...noteRows.rows.keys()].sort()).toEqual([n1.id, n2.id, n3.id].sort())
  })

  it('child cells run their model codecs; null is an explicit cell, never absence', () => {
    const { rows } = decodeTable(flagOn.entities.notes)
    expect(flagOn.entities.notes.k[0]).toBe('id')
    expect(flagOn.entities.notes.k).not.toContain('lockVersion')
    expect(flagOn.entities.notes.k).toContain('body')
    // PINNED ACCEPTANCE (expose-only door): included child rows serialize
    // WHOLE (minus the lock token) — this is the exact full column list, so
    // any accidental widening (a future secret column would ride BOTH lanes
    // identically and no lane-vs-lane comparison could see it) or narrowing
    // fails here, loudly. Doors that need child slicing declare `access:`.
    expect([...flagOn.entities.notes.k].sort()).toEqual(
      ['authorId', 'body', 'id', 'kind', 'loanId', 'position'])
    expect(rows.get(n2.id)!.body).toBeNull()           // explicit null cell
    expect(rows.get(n1.id)!.kind).toBe('update')       // child enum label (A0)
    expect(rows.get(n2.id)!.kind).toBe('warning')
    expect(rows.get(n1.id)!.loanId).toBe(l1.id)        // FK linkage travels flat
    // KNOWN NESTED-LANE GAP (pinned, reported): the nested envelope serves
    // included child rows RAW — toJSON only-mode bypasses the child's Attr
    // codecs (enum stays an int) and even ships the child's lockVersion.
    // Columnar hydrates children through the model class (A0's one-codec
    // law) and keeps the token out of k.
    const rawNote = flagOff.data[0].notes.find((n: any) => n.id === n1.id)!
    expect(rawNote.kind).toBe(0)
    expect(rawNote).toHaveProperty('lockVersion')
  })

  it('v[i] mirrors each row lock column; token-less models ride the untracked lane; shared authors dedupe', () => {
    const loanTokens = decodeTable(flagOn.entities.loans).tokens
    expect(loanTokens.get(l1.id)).toBe(0)
    const noteTokens = decodeTable(flagOn.entities.notes).tokens
    expect(noteTokens.get(n1.id)).toBe(0)
    // users has no lock column → every row untracked
    const userSection = flagOn.entities.users
    expect(userSection.v.every((t: any) => t === null)).toBe(true)
    // dana authored two notes but appears ONCE
    const userRows = decodeTable(userSection).rows
    expect([...userRows.keys()].sort()).toEqual([dana.id, ito.id].sort())
    expect(userRows.get(dana.id)!.name).toBe('Dana')
  })
})

describe('SHOW door parity', () => {
  let flagOff: any
  let flagOn: any

  beforeAll(async () => {
    flagOff = await defaultGet((Loan as any).all(), Loan, nestedCfg, l1.id)
    flagOn  = await defaultGet((Loan as any).all(), Loan, columnarCfg, l1.id)
  })

  it('membership is the single pk; verdicts and version are IDENTICAL to the nested envelope', () => {
    expect(flagOn.membership).toEqual({ pks: [l1.id] })
    expect(flagOn.abilities).toEqual(flagOff.abilities)
    expect(flagOn.can).toEqual(flagOff.can)
    expect(flagOn.version).toEqual(flagOff.version)
    expect(typeof flagOn.version).toBe('string')
  })

  it('the root row carries exactly the ceiling slice + the pk-array; secretRate stays absent (not null)', () => {
    expect(flagOn.entities.loans.k).toEqual(['id', 'title', 'stage', 'brokerId', 'noteIds'])
    const { rows } = decodeTable(flagOn.entities.loans)
    const row = rows.get(l1.id)!
    expect(row.title).toBe('Marina refi')
    expect('secretRate' in row).toBe(false)
    expect(row.noteIds).toEqual([n2.id, n1.id])
  })

  it('grandchild includes land in their own table (3 tables total: loans, notes, users)', () => {
    expect(Object.keys(flagOn.entities).sort()).toEqual(['loans', 'notes', 'users'])
    const { rows } = decodeTable(flagOn.entities.users)
    expect(rows.get(dana.id)!.name).toBe('Dana')
  })
})

describe('UPDATE echoes (same serializer — A3 door totality)', () => {
  it('a flagged update echoes the columnar envelope with a bumped version and adopted _key in meta.nestedKeys (per TABLE)', async () => {
    const before = await (Loan as any).where({ id: l1.id }).first()
    const env: any = await defaultUpdate((Loan as any).all(), Loan, columnarCfg, l1.id, {
      title: 'Marina refi (rev)',
      _version: String(before.lockVersion),
      notesAttributes: [{ _key: 'k_tmp_abc', body: 'Fresh note', kind: 'update', position: 3, authorId: ito.id }],
    }, {}, undefined)

    expect(env.entities).toBeDefined()
    expect(env.membership.pks).toEqual([l1.id])
    expect(Number(env.version)).toBe(Number(before.lockVersion) + 1)

    const { rows } = decodeTable(env.entities.loans)
    expect(rows.get(l1.id)!.title).toBe('Marina refi (rev)')

    // the created nested row is adopted by _key — moved OFF the rows into
    // meta.nestedKeys, keyed by the child's TABLE
    const noteRows = decodeTable(env.entities.notes).rows
    const created = [...noteRows.values()].find(r => r.body === 'Fresh note')!
    expect(created).toBeDefined()
    expect(env.meta?.nestedKeys?.notes).toEqual({ [String(created.id)]: 'k_tmp_abc' })

    // and the owner's pk-array includes the new child, in association order
    expect(rows.get(l1.id)!.noteIds).toEqual([n2.id, n1.id, created.id])
  })

  it('a stale _version 409s with the COLUMNAR envelope (reload/overwrite UI has the fresh truth)', async () => {
    try {
      await defaultUpdate((Loan as any).all(), Loan, columnarCfg, l1.id, {
        title: 'never lands', _version: '999',
      }, {}, undefined)
      expect.unreachable('stale write must 409')
    } catch (e: any) {
      expect(e).toBeInstanceOf(Conflict)
      expect(e.envelope?.entities?.loans).toBeDefined()
      expect(e.envelope.membership.pks).toEqual([l1.id])
    }
  })
})

describe('DESTROY echo', () => {
  it('a flagged destroy returns touched with the DESTROY-COMMIT token D = lock + 1 (A1: strictly increasing across destroys too)', async () => {
    const doomed = await (Loan as any).create({ title: 'Doomed', stage: 'open' })
    // bump once so the token is non-zero
    doomed.title = 'Doomed v2'
    await doomed.save()
    // read token is 1; the destroy COMMIT gets its own position in the chain
    // (D = 2), so a payload raced at the read token can never outlive the
    // floor — the pre-fix echo of the READ token left a same-token window.
    const echo: any = await defaultDestroy((Loan as any).all(), Loan, doomed.id, columnarCfg)
    expect(echo).toEqual({
      success: true,
      touched: [{ resource: 'loans', id: doomed.id, op: 'destroy', version: 2 }],
    })
    // unflagged doors keep the legacy void return
    const doomed2 = await (Loan as any).create({ title: 'Doomed 2', stage: 'open' })
    const legacy = await defaultDestroy((Loan as any).all(), Loan, doomed2.id, nestedCfg)
    expect(legacy).toBeUndefined()
  })
})

describe('WS2b — flat loading', () => {
  it('columnar index costs 1 root query + one per included table (count + rows + notes + users)', async () => {
    queryCount = 0
    counting = true
    await defaultIndex((Loan as any).all(), Loan, columnarCfg, {})
    counting = false
    // COUNT(*) + roots + notes(fk IN) + users(pk IN) = 4
    expect(queryCount).toBe(4)
  })

  it('the serializer is loader-agnostic: a NESTED-loaded graph produces the same tables and cells (child ROW ORDER comes from the loader — the flat loader honors declared association order, RQB does not)', async () => {
    const flagOn: any = await defaultIndex((Loan as any).all(), Loan, columnarCfg, {})
    const nestedLoaded = await (Loan as any).includes({ notes: ['author'] }).order('id', 'asc').load()
    const env = buildColumnarEnvelope(nestedLoaded, Loan, columnarCfg, {
      includeSpecs: [{ notes: ['author'] }],
    })
    expect(env.membership.pks).toEqual(flagOn.membership.pks)
    // same table set, same k headers, same cells per pk; child order normalized
    expect(Object.keys(env.entities).sort()).toEqual(Object.keys(flagOn.entities).sort())
    for (const table of Object.keys(flagOn.entities)) {
      expect(env.entities[table]!.k).toEqual(flagOn.entities[table].k)
      const a = decodeTable(env.entities[table]!)
      const b = decodeTable(flagOn.entities[table])
      expect([...a.rows.keys()].sort()).toEqual([...b.rows.keys()].sort())
      for (const [pk, rowA] of a.rows) {
        const rowB = b.rows.get(pk)!
        for (const col of flagOn.entities[table].k) {
          if (Array.isArray(rowA[col])) expect([...rowA[col]].sort()).toEqual([...rowB[col]].sort())
          else expect(rowA[col]).toEqual(rowB[col])
        }
        expect(a.tokens.get(pk)).toEqual(b.tokens.get(pk))
      }
    }
  })
})

describe('Attr-kind codec parity (§2 checklist: money, dates, jsonb — ONE codec per field, both lanes)', () => {
  // Root-level cells (the child-codec divergence is a PINNED nested-lane bug,
  // asserted in the index suite above — this fixture has no includes so both
  // lanes' cells must be byte-identical after JSON round-trip, which is what
  // actually crosses the wire).
  const wire = (v: any) => JSON.parse(JSON.stringify(v === undefined ? { __absent: true } : v))
  const EXPOSED = ['amount', 'dueOn', 'signedAt', 'meta']

  const invBase = {
    index: { defaultSort: { field: 'id', dir: 'asc' as const }, perPage: 25 },
    get: { expose: EXPOSED, abilities: true },
    update: { permit: ['amount'], optimisticLock: true },
  }
  const invNested: any = { ...invBase, wire: 'nested' }
  const invColumnar: any = { ...invBase, wire: 'columnar' }

  let inv1: any, inv2: any, inv3: any
  let flagOff: any, flagOn: any

  beforeAll(async () => {
    inv1 = await (Invoice as any).create({
      amount: 19.99,
      dueOn: '2026-03-01',
      signedAt: new Date('2026-01-02T03:04:05.678Z'),
      meta: { tags: ['a', 'b'], nested: { x: 1 } },
    })
    inv2 = await (Invoice as any).create({ amount: -0.05, dueOn: null, signedAt: null, meta: null })
    inv3 = await (Invoice as any).create({ amount: null, dueOn: '2026-12-31', signedAt: null, meta: { tags: [] } })

    flagOff = await defaultIndex((Invoice as any).all(), Invoice, invNested, {})
    flagOn  = await defaultIndex((Invoice as any).all(), Invoice, invColumnar, {})
  })

  it('k is the ceiling exactly — and the token never rides', () => {
    expect(flagOn.entities.invoices.k).toEqual(['id', ...EXPOSED])
    expect(flagOn.entities.invoices.k).not.toContain('lockVersion')
  })

  it('every exposed cell is JSON-round-trip identical to the nested lane, for every row', () => {
    const { rows } = decodeTable(flagOn.entities.invoices)
    expect(flagOff.data).toHaveLength(3)
    for (const nestedRow of flagOff.data) {
      const cRow = rows.get(nestedRow.id)!
      expect(cRow).toBeDefined()
      for (const f of EXPOSED) {
        expect(wire(cRow[f])).toEqual(wire(nestedRow[f]))
      }
    }
  })

  it('money: decimal dollars as numbers (exact-string math), negatives exact, NaN-free null lane', () => {
    const { rows } = decodeTable(flagOn.entities.invoices)
    expect(rows.get(inv1.id)!.amount).toBe(19.99)
    expect(rows.get(inv2.id)!.amount).toBe(-0.05)
    expect(rows.get(inv3.id)!.amount).toBeNull()          // explicit null CELL, not absence
    expect('amount' in rows.get(inv3.id)!).toBe(true)
  })

  it('dates: DATE stays the calendar string, TIMESTAMPTZ serializes to the same ISO instant', () => {
    const { rows } = decodeTable(flagOn.entities.invoices)
    expect(rows.get(inv1.id)!.dueOn).toBe('2026-03-01')
    expect(wire(rows.get(inv1.id)!.signedAt)).toBe('2026-01-02T03:04:05.678Z')
    expect(rows.get(inv2.id)!.signedAt).toBeNull()
  })

  it('jsonb: structural identity, and null is a value', () => {
    const { rows } = decodeTable(flagOn.entities.invoices)
    expect(wire(rows.get(inv1.id)!.meta)).toEqual({ tags: ['a', 'b'], nested: { x: 1 } })
    expect(wire(rows.get(inv3.id)!.meta)).toEqual({ tags: [] })
    expect(rows.get(inv2.id)!.meta).toBeNull()
  })

  it('show door: same cells and same verdicts as the nested envelope', async () => {
    const offShow: any = await defaultGet((Invoice as any).all(), Invoice, invNested, inv1.id)
    const onShow: any  = await defaultGet((Invoice as any).all(), Invoice, invColumnar, inv1.id)
    expect(onShow.membership).toEqual({ pks: [inv1.id] })
    expect(onShow.abilities).toEqual(offShow.abilities)
    expect(onShow.can).toEqual(offShow.can)
    expect(onShow.version).toEqual(offShow.version)
    const { rows, tokens } = decodeTable(onShow.entities.invoices)
    for (const f of EXPOSED) expect(wire(rows.get(inv1.id)![f])).toEqual(wire(offShow.record[f]))
    expect(tokens.get(inv1.id)).toBe(0)
  })
})

describe('size bench (the acceptance fixture: 20 roots × 40 children × 8 shared authors)', () => {
  // MEASURED FINDING (2026-08-27, this fixture): raw JSON = ~50% of nested;
  // post-brotli-4 the two converge (~95-98%) because brotli erases repeated
  // keys and duplicated embedded objects almost entirely on a 2-level graph.
  // The wire-identity ~40%-compressed number came from a deeper synthetic
  // graph and did NOT reproduce here — exactly the risk the design names
  // ("treat the bench as the acceptance fixture, not a promise for every
  // door; record per-door numbers at flip time"). The RAW ratio is the
  // structural invariant (keys once per table, entities once per response),
  // so that is what this test pins; brotli numbers are logged for the
  // tracker.
  it('columnar RAW payload is ≤ ~55% of the nested baseline (brotli logged, recorded at flip time)', async () => {
    const { brotliCompressSync, constants } = await import('node:zlib')
    // Realistic-entropy values (a seeded PRNG — real doors carry names,
    // amounts, and prose, not 800 copies of one sentence; a fully
    // repetitive fixture lets brotli erase the nested lane's key overhead
    // and measures nothing).
    let seed = 0x2f6e2b1
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
      return (seed >>> 0) / 0xffffffff
    }
    const word = () => Math.floor(rnd() * 0xffffffff).toString(36)
    const phrase = (n: number) => Array.from({ length: n }, word).join(' ')
    // seed the 20×40×8 graph with raw SQL (speed)
    const authorIds: number[] = []
    for (let i = 0; i < 8; i++) {
      const r = await pool.query(`INSERT INTO users (name) VALUES ($1) RETURNING id`, [`${phrase(2)}`])
      authorIds.push(r.rows[0].id)
    }
    const loanIds: number[] = []
    for (let i = 0; i < 20; i++) {
      const r = await pool.query(
        `INSERT INTO loans (title, stage, broker_id, secret_rate) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`${phrase(5)}`, i % 2, authorIds[i % 8], Math.floor(rnd() * 10_000)],
      )
      loanIds.push(r.rows[0].id)
    }
    const values: string[] = []
    const params: any[] = []
    let p = 1
    for (const loanId of loanIds) {
      for (let j = 0; j < 40; j++) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`)
        params.push(loanId, authorIds[j % 8], phrase(8), j % 2, Math.floor(rnd() * 100_000))
      }
    }
    await pool.query(
      `INSERT INTO notes (loan_id, author_id, body, kind, position) VALUES ${values.join(',')}`,
      params,
    )

    const scoped = () => (Loan as any).where({ id: loanIds })
    const nested: any = await defaultIndex(scoped(), Loan, nestedCfg, { perPage: 100 })
    const columnar: any = await defaultIndex(scoped(), Loan, columnarCfg, { perPage: 100 })

    const brotli = (s: string) => brotliCompressSync(Buffer.from(s), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
    }).length
    const nestedRaw = JSON.stringify(nested)
    const columnarRaw = JSON.stringify(columnar)
    const nestedBr = brotli(nestedRaw)
    const columnarBr = brotli(columnarRaw)
    // recorded for the tracker at flip time
    console.log(`[columnar bench] raw: ${columnarRaw.length} / ${nestedRaw.length} = ${(columnarRaw.length / nestedRaw.length * 100).toFixed(1)}%  ` +
      `brotli-4: ${columnarBr} / ${nestedBr} = ${(columnarBr / nestedBr * 100).toFixed(1)}%`)
    expect(columnarRaw.length / nestedRaw.length).toBeLessThanOrEqual(0.55)
    // brotli parity floor: columnar must never be LARGER than nested
    expect(columnarBr).toBeLessThanOrEqual(nestedBr)
  }, 60_000)
})

describe('INDEX pagination parity ACROSS pages (hasMore true → false)', () => {
  let a: any, b: any, c: any
  let scoped: () => any

  beforeAll(async () => {
    a = await (Loan as any).create({ title: 'Page A', stage: 'open' })
    b = await (Loan as any).create({ title: 'Page B', stage: 'open' })
    c = await (Loan as any).create({ title: 'Page C', stage: 'open' })
    scoped = () => (Loan as any).where({ id: [a.id, b.id, c.id] })
  })

  it('page 0 fills and reports hasMore; page 1 is the remainder with hasMore false — identical to the nested lane', async () => {
    for (const page of [0, 1]) {
      const off: any = await defaultIndex(scoped(), Loan, nestedCfg, { perPage: 2, page })
      const on: any  = await defaultIndex(scoped(), Loan, columnarCfg, { perPage: 2, page })
      expect(on.membership.pks).toEqual(off.data.map((r: any) => r.id))
      expect(on.membership.pagination).toEqual(off.pagination)
    }
    const p0: any = await defaultIndex(scoped(), Loan, columnarCfg, { perPage: 2, page: 0 })
    const p1: any = await defaultIndex(scoped(), Loan, columnarCfg, { perPage: 2, page: 1 })
    expect(p0.membership.pks).toEqual([a.id, b.id])
    expect(p0.membership.pagination).toEqual({ page: 0, perPage: 2, totalCount: 3, totalPages: 2, hasMore: true })
    expect(p1.membership.pks).toEqual([c.id])
    expect(p1.membership.pagination).toEqual({ page: 1, perPage: 2, totalCount: 3, totalPages: 2, hasMore: false })
  })
})

describe('root ORDERING parity on non-pk sorts (membership.pks is the loader order, never re-sorted)', () => {
  it('title asc and desc both match the nested lane row order', async () => {
    const scoped = () => (Loan as any).where({ id: [l1.id, l2.id] })
    for (const dir of ['asc', 'desc'] as const) {
      const off: any = await defaultIndex(scoped(), Loan, nestedCfg, { sort: { field: 'title', dir } })
      const on: any  = await defaultIndex(scoped(), Loan, columnarCfg, { sort: { field: 'title', dir } })
      expect(on.membership.pks).toEqual(off.data.map((r: any) => r.id))
    }
    // 'Bridge' < 'Marina …': ascending title order DIFFERS from pk order —
    // a serializer that re-sorted pks by pk would fail here
    const asc: any = await defaultIndex(scoped(), Loan, columnarCfg, { sort: { field: 'title', dir: 'asc' } })
    expect(asc.membership.pks).toEqual([l2.id, l1.id])
  })
})

describe('CREATE echo (columnar) — the same serializer, stripped-field issues, _key adoption', () => {
  it('a flagged create returns the columnar envelope: entities, version, issues, meta.nestedKeys', async () => {
    const env: any = await defaultCreate((Loan as any).all(), Loan, columnarCfg, {
      title: 'Created via columnar',
      stage: 'open',
      notesAttributes: [{ _key: 'k_created_1', body: 'Born with parent', kind: 'update', position: 1 }],
      hacker: 'nope',   // not permitted → must surface as an issue, never vanish
    }, {}, {}, undefined)

    expect(env.entities?.loans).toBeDefined()
    expect(env.membership.pks).toHaveLength(1)
    const pk = env.membership.pks[0]
    const { rows, tokens } = decodeTable(env.entities.loans)
    expect(rows.get(pk)!.title).toBe('Created via columnar')
    expect(typeof env.version).toBe('string')
    expect(tokens.get(pk)).toBe(Number(env.version))
    expect(env.issues).toEqual([{ field: 'hacker', code: 'forbidden' }])
    // the created nested row is adopted by _key, keyed by the child's TABLE
    const noteRows = decodeTable(env.entities.notes).rows
    const created = [...noteRows.values()].find(r => r.body === 'Born with parent')!
    expect(created).toBeDefined()
    expect(env.meta?.nestedKeys?.notes).toEqual({ [String(created.id)]: 'k_created_1' })
    expect(rows.get(pk)!.noteIds).toEqual([created.id])
  })
})

describe('this.envelope() on a flagged door (the custom @mutation echo path — A3 door totality)', () => {
  class LoanEchoController extends ActiveController<any> {
    run(record: any) { return (this as any).envelope(record) }
  }
  ;(crud as any)(Loan, columnarCfg)(LoanEchoController)

  it('a record loaded WITHOUT includes still echoes the TRUE hasMany membership (flat includes attached, never a fabricated [])', async () => {
    const bare = await (Loan as any).where({ id: l1.id }).first()   // no includes — the custom-mutation shape
    expect(bare._attributes.notes).toBeUndefined()
    const ctrl: any = new LoanEchoController()
    ctrl.context = {}
    const env: any = await ctrl.run(bare)

    const get: any = await defaultGet((Loan as any).all(), Loan, columnarCfg, l1.id)
    const envRow = decodeTable(env.entities.loans).rows.get(l1.id)!
    const getRow = decodeTable(get.entities.loans).rows.get(l1.id)!
    expect(envRow.noteIds).toEqual(getRow.noteIds)
    expect(envRow.noteIds.length).toBeGreaterThan(0)
    // child + grandchild tables ride too, exactly as the GET door serves them
    expect(Object.keys(env.entities).sort()).toEqual(Object.keys(get.entities).sort())
  })

  it('the raw serializer OMITS the pk-array column for an unloaded hasMany (absence, never []) — the store-wipe guard', async () => {
    const bare = await (Loan as any).where({ id: l1.id }).first()
    const env: any = buildColumnarRecordEnvelope(bare, Loan, columnarCfg, {}, undefined)
    expect(env.entities.loans.k).not.toContain('noteIds')
    expect(env.entities.notes).toBeUndefined()
  })
})

describe('membership passengers on the columnar lane (emptyReason / chart / metric)', () => {
  it('a zero-match page carries emptyReason (and an empty entities map) — parity with nested', async () => {
    const scoped = () => (Loan as any).where({ id: l1.id })
    const off: any = await defaultIndex(scoped(), Loan, nestedCfg, { filters: { stage: 'won' } })
    const on: any  = await defaultIndex(scoped(), Loan, columnarCfg, { filters: { stage: 'won' } })
    expect(off.emptyReason).toBe('no-matches')
    expect(on.membership.emptyReason).toBe('no-matches')
    expect(on.membership.pks).toEqual([])
    expect(on.membership.pagination.totalCount).toBe(0)
    expect(on.entities).toEqual({})
  })

  it('chart and metric aggregates ride membership, identical to the nested lane', async () => {
    const aggBase = { ...baseConfig, index: { ...baseConfig.index, chartable: ['stage'], measures: [] } }
    const aggNested: any = { ...aggBase, wire: 'nested' }
    const aggColumnar: any = { ...aggBase, wire: 'columnar' }
    const scoped = () => (Loan as any).where({ id: [l1.id, l2.id] })
    const off: any = await defaultIndex(scoped(), Loan, aggNested, { chart: { x: 'stage' }, metric: 'count', perPage: 0 })
    const on: any  = await defaultIndex(scoped(), Loan, aggColumnar, { chart: { x: 'stage' }, metric: 'count', perPage: 0 })
    expect(off.chart).toBeDefined()
    expect(on.membership.chart).toEqual(off.chart)
    expect(on.membership.metric).toEqual(off.metric)
    expect(on.membership.metric).toEqual(2)
  })
})

describe('flat-loader guards over real PG (polymorphic inverse, hasOne, order tiebreaker, default scopes)', () => {
  it('a polymorphic-inverse hasMany scopes by the parent TYPE — another parent type sharing the id leaks nothing', async () => {
    await pool.query(
      `INSERT INTO attachments (attachable_type, attachable_id, name) VALUES
       ('Loan', $1, 'deed.pdf'), ('Invoice', $1, 'invoice-secret.pdf')`, [l1.id])
    const root = await (Loan as any).where({ id: l1.id }).first()
    await attachFlatIncludes([root], Loan, ['attachments'])
    const names = root._attributes.attachments.map((atRec: any) => atRec.name)
    expect(names).toEqual(['deed.pdf'])   // the Invoice-typed row NEVER attaches
  })

  it('hasOne flat-loads first-per-parent (pk asc) and SERIALIZES into its own entity table', async () => {
    await pool.query(`INSERT INTO summaries (loan_id, body) VALUES ($1, 'first'), ($1, 'second')`, [l1.id])
    const root = await (Loan as any).where({ id: l1.id }).first()
    await attachFlatIncludes([root], Loan, ['brief'])
    expect(root._attributes.brief.body).toBe('first')   // first per parent, deterministic

    const briefCfg: any = { ...columnarCfg, get: { ...columnarCfg.get, include: ['brief'] } }
    const env: any = buildColumnarRecordEnvelope(root, Loan, briefCfg, {}, undefined)
    expect(env.entities.summaries).toBeDefined()
    const { rows } = decodeTable(env.entities.summaries)
    expect([...rows.values()][0]!.body).toBe('first')
    expect([...rows.values()][0]!.loanId).toBe(l1.id)   // linkage rides on the CHILD row
  })

  it('equal association-order values fall back to pk asc — within-parent child order is deterministic', async () => {
    const tied = await (Loan as any).create({ title: 'Tied positions', stage: 'open' })
    const t1 = await (Note as any).create({ loanId: tied.id, body: 'older', kind: 'update', position: 5 })
    const t2 = await (Note as any).create({ loanId: tied.id, body: 'newer', kind: 'update', position: 5 })
    const env: any = await defaultGet((Loan as any).all(), Loan, columnarCfg, tied.id)
    expect(decodeTable(env.entities.loans).rows.get(tied.id)!.noteIds).toEqual([t1.id, t2.id])
  })

  it('child DEFAULT SCOPES do not run in flat loading — the nested lane never applied them, and a row-set change must not ride a transport flag', async () => {
    // Note gains a default scope that would hide every note with position != 1
    Object.defineProperty(Note, '__defaultScopes', {
      value: new Map([['TestOnly', (q: any) => q.where({ position: 1 })]]),
      configurable: true, writable: true,
    })
    try {
      const scoped = () => (Loan as any).where({ id: l1.id })
      const off: any = await defaultIndex(scoped(), Loan, nestedCfg, {})
      const on: any  = await defaultIndex(scoped(), Loan, columnarCfg, {})
      const offIds = off.data[0].notes.map((n: any) => n.id).sort()
      const onIds = [...decodeTable(on.entities.loans).rows.get(l1.id)!.noteIds].sort()
      expect(onIds).toEqual(offIds)                       // SAME row set, flag on or off
      expect(onIds.length).toBeGreaterThan(1)             // the scope WOULD have cut this to 1
    } finally {
      Object.defineProperty(Note, '__defaultScopes', { value: new Map(), configurable: true, writable: true })
    }
  })
})

describe('runtime teaching errors (plugin-less backstop)', () => {
  it('columnar without expose fails loud with the fix in the message', () => {
    const cfg: any = { wire: 'columnar', get: {} }
    expect(() => buildColumnarRecordEnvelope({ id: 1, toJSON: () => ({ id: 1 }) }, Loan, cfg, {}, undefined))
      .toThrow(/requires a read ceiling/)
  })

  it('columnar without abilities fails loud — the flag must not change the app-visible hook shape (P6)', () => {
    const cfg: any = { wire: 'columnar', get: { expose: ['title'] } }
    expect(() => buildColumnarRecordEnvelope({ id: 1, toJSON: () => ({ id: 1 }) }, Loan, cfg, {}, undefined))
      .toThrow(/abilities: true/)
  })

  it('an include outside an explicit access ceiling is refused at serialize time (the ceiling is total)', async () => {
    const record = await (Loan as any).where({ id: l1.id }).first()
    await attachFlatIncludes([record], Loan, ['notes'])
    const cfg: any = { wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['notes'] } }
    // simulate the decorator's explicit access node: viewable title, NO includes
    const { PROJECTION_NODE } = await import('@active-drizzle/controller')
    cfg[PROJECTION_NODE as any] = { fields: new Set(['title']), edit: new Set(), include: {}, explicit: true }
    expect(() => buildColumnarRecordEnvelope(record, Loan, cfg, {}, undefined))
      .toThrow(/not declared in this door's `access:` ceiling/)
  })
})
