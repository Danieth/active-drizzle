/**
 * WS3 codegen substrate — the write-log registry pass (wire-columnar.ts):
 *
 *   - the LOGGED-MODEL SET is derived (lock-tokened ∩ reachable from a
 *     wire:'columnar' door, root or include), never a knob;
 *   - each logged model gets ONE declaration-order field numbering + a
 *     fieldsRev hash (deploy-drift detection);
 *   - each columnar door gets projId = hash of its compiled validatable
 *     mask — scalar + belongsTo-FK columns ONLY (hasMany pk-arrays are
 *     excluded by construction), the lock column never included;
 *   - the projId rule matches the RUNTIME twin (validatableMask in the
 *     controller) through the SHARED hash helpers — pinned here against
 *     projIdFor over the same field set;
 *   - validateWriteLogSchema refuses (O2a-pattern teaching error, DDL in
 *     the message) when columnar doors imply logged models but the schema
 *     lacks the transport tables.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractSchema, extractModel } from '../../src/codegen/extractor.js'
import { extractControllers } from '../../src/codegen/controller-extractor.js'
import {
  computeWriteLogRegistry, validatableMaskFields, validateWriteLogSchema,
  validateColumnarDoors,
} from '../../src/codegen/wire-columnar.js'
import { projIdFor, fieldsRevOf } from '../../src/runtime/write-log.js'

// secretRate deliberately INTERLEAVED between mask columns: the field
// numbering (declaration order) must never be confused with mask position.
const SCHEMA = `
  import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'
  export const loans = pgTable('loans', {
    id: serial('id').primaryKey(),
    secretRate: integer('secret_rate'),
    title: text('title'),
    stage: integer('stage'),
    brokerId: integer('broker_id'),
    priceCents: integer('price_cents'),
    lockVersion: integer('lock_version').notNull().default(0),
  })
  export const notes = pgTable('notes', {
    id: serial('id').primaryKey(),
    loanId: integer('loan_id'),
    body: text('body'),
    lockVersion: integer('lock_version').notNull().default(0),
  })
  export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    name: text('name'),
  })
`

// The three transport tables, as an app schema would declare them — the
// green path of validateWriteLogSchema (a presence-predicate mutant that
// ALWAYS refuses would brick every real columnar project at build time).
const TRANSPORT_TABLES = `
  export const recordWriteLog = pgTable('record_write_log', {
    model: text('model').notNull(),
    pk: text('pk').notNull(),
    token: integer('token').notNull(),
    lifecycle: integer('lifecycle').notNull().default(0),
  })
  export const recordWriteLogMeta = pgTable('record_write_log_meta', {
    model: text('model').primaryKey(),
    fieldsHash: text('fields_hash').notNull(),
  })
  export const membershipTags = pgTable('membership_tags', {
    door: text('door').primaryKey(),
    tag: integer('tag').notNull().default(0),
  })
`

const MODELS: Array<[string, string]> = [
  ['/p/models/loan.model.ts', `
    @model('loans')
    export class Loan {
      static notes = hasMany('notes')
      static broker = belongsTo('users', { foreignKey: 'brokerId' })
    }
  `],
  ['/p/models/note.model.ts', `
    @model('notes')
    export class Note {}
  `],
  ['/p/models/user.model.ts', `
    @model('users')
    export class User {}
  `],
]

function run(ctrl: string, opts: { transportTables?: boolean } = {}) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, experimentalDecorators: true },
  })
  project.createSourceFile('/p/db/schema.ts', SCHEMA + (opts.transportTables ? TRANSPORT_TABLES : ''))
  const models = MODELS.map(([path, src]) => {
    project.createSourceFile(path, src)
    return extractModel(project, path)
  })
  project.createSourceFile('/p/controllers/loan.ctrl.ts', ctrl)
  const schema = extractSchema(project, '/p/db/schema.ts')
  const ctrlMeta = extractControllers(project, ['/p/controllers/loan.ctrl.ts'])
  return { ctrlMeta, projectMeta: { schema, models } }
}

const COLUMNAR_CTRL = `
  @controller('/loans')
  @crud(Loan, {
    wire: 'columnar',
    get: { expose: ['title', 'stage', 'notes'], abilities: true, include: ['notes', 'broker'] },
    update: { permit: ['title'], optimisticLock: true },
  })
  export class LoanController {}
`

describe('computeWriteLogRegistry — the derived logged set', () => {
  it('logs lock-tokened models reachable from the columnar door (root + includes); untracked models never log', () => {
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL)
    const registry = computeWriteLogRegistry(ctrlMeta, projectMeta as any)
    expect(registry.models.map(m => m.tableName).sort()).toEqual(['loans', 'notes'])
    // users has no lock column — reachable but NEVER logged (untracked lane)
    expect(registry.models.some(m => m.tableName === 'users')).toBe(false)
  })

  it('a nested (flag-off) door contributes nothing — logging piggybacks on the columnar opt-in', () => {
    const { ctrlMeta, projectMeta } = run(`
      @controller('/loans')
      @crud(Loan, { get: { expose: ['title'], abilities: true } })
      export class LoanController {}
    `)
    const registry = computeWriteLogRegistry(ctrlMeta, projectMeta as any)
    expect(registry.models).toEqual([])
    expect(registry.doors).toEqual([])
  })

  it('field numbering is ALL table columns in declaration order, and fieldsRev pins it', () => {
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL)
    const registry = computeWriteLogRegistry(ctrlMeta, projectMeta as any)
    const loans = registry.models.find(m => m.tableName === 'loans')!
    expect(loans.fields).toEqual(['id', 'secretRate', 'title', 'stage', 'brokerId', 'priceCents', 'lockVersion'])
    expect(loans.fieldsRev).toBe(fieldsRevOf(loans.fields))
    expect(loans.lockColumn).toBe('lockVersion')
  })
})

describe('validatableMaskFields + projId — the compiled door mask', () => {
  it('mask = pk + exposed physical columns + included belongsTo FKs; pk-arrays and the lock column excluded', () => {
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL)
    const mask = validatableMaskFields(ctrlMeta.controllers[0]!, projectMeta as any)
    // 'notes' (the hasMany / its pk-array) is NOT a physical column — excluded
    // by construction; brokerId rides as the included belongsTo's FK.
    expect([...mask].sort()).toEqual(['brokerId', 'id', 'stage', 'title'])
    const registry = computeWriteLogRegistry(ctrlMeta, projectMeta as any)
    expect(registry.doors).toHaveLength(1)
    expect(registry.doors[0]!.projId).toBe(projIdFor(mask))
    // order-insensitive by construction: a mask is a set
    expect(projIdFor(['id', 'title', 'stage', 'brokerId'])).toBe(registry.doors[0]!.projId)
    // and a ceiling change yields a NEW projId
    expect(projIdFor(['id', 'title', 'stage'])).not.toBe(registry.doors[0]!.projId)
  })

  it('an Attr-renamed property (expose name ≠ physical column) is EXCLUDED — the declared degradation', () => {
    // `static price = Attr.money('priceCents')` exposes 'price' while the
    // physical column is 'priceCents' — codegen cannot see Attr._column, so
    // the field lands in NEITHER form in the compiled mask. The runtime twin
    // includes the mapped column, so the projIds then differ and every
    // validate answers the conservative slice (correct, never a 304);
    // registerColumnarDoorTransport warns at router build naming the field.
    const { ctrlMeta, projectMeta } = run(`
      @controller('/loans')
      @crud(Loan, {
        wire: 'columnar',
        get: { expose: ['title', 'price'], abilities: true },
        update: { permit: ['title'], optimisticLock: true },
      })
      export class LoanController {}
    `)
    const mask = validatableMaskFields(ctrlMeta.controllers[0]!, projectMeta as any)
    expect(mask).not.toContain('price')
    expect(mask).not.toContain('priceCents')
    expect([...mask].sort()).toEqual(['id', 'title'])
  })
})

describe('validateColumnarDoors W9 — the lock-token warning (dead validation lane)', () => {
  it('a columnar door on a lock-less model warns: every revalidation is a full record, no tag', () => {
    const { ctrlMeta, projectMeta } = run(`
      @controller('/users')
      @crud(User, {
        wire: 'columnar',
        get: { expose: ['name'], abilities: true },
      })
      export class UserController {}
    `)
    const diags = validateColumnarDoors(ctrlMeta, projectMeta as any)
    const w9 = diags.find(d => d.message.includes('lock-token'))
    expect(w9).toBeDefined()
    expect(w9!.severity).toBe('warning')
    expect(w9!.message).toContain('User')
  })

  it('a lock-tokened columnar door does not warn', () => {
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL)
    const diags = validateColumnarDoors(ctrlMeta, projectMeta as any)
    expect(diags.filter(d => d.message.includes('lock-token'))).toEqual([])
  })
})

describe('validateWriteLogSchema — the O2a-pattern refusal', () => {
  it('columnar doors + missing transport tables ⇒ teaching error carrying the DDL', () => {
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL)
    const diags = validateWriteLogSchema(ctrlMeta, projectMeta as any)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toContain('write-logged')
    expect(diags[0]!.suggestion).toContain('CREATE TABLE record_write_log')
  })

  it('no columnar doors ⇒ no requirement', () => {
    const { ctrlMeta, projectMeta } = run(`
      @controller('/loans')
      @crud(Loan, { get: { expose: ['title'] } })
      export class LoanController {}
    `)
    expect(validateWriteLogSchema(ctrlMeta, projectMeta as any)).toEqual([])
  })

  it('GREEN PATH: a schema declaring the transport tables passes with zero diagnostics', () => {
    // Pins the presence predicate itself — a mutant that always refuses
    // would brick every correctly-migrated columnar project at build time.
    const { ctrlMeta, projectMeta } = run(COLUMNAR_CTRL, { transportTables: true })
    expect(validateWriteLogSchema(ctrlMeta, projectMeta as any)).toEqual([])
  })
})
