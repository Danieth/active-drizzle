/**
 * The versioned-models pass (O2/O14) — the cross-IR optimistic-lock contract.
 *
 * O2: a lock-tokened model MUST carry an integer lock column shaped
 *     `integer('lock_version').notNull().default(0)`; the schema is
 *     user-authored, so enforcement is refuse-with-teaching-error (with the
 *     paste-ready snippet), never auto-declare.
 * O14: a lock-tokened model whose pk is reusable (natural key / plain
 *     integer / undetectable) must @include(SoftDeletable) — serial,
 *     identity, and uuid pks are never reused, so lineage is automatic.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractSchema, extractModel } from '../../src/codegen/extractor.js'
import { extractControllers } from '../../src/codegen/controller-extractor.js'
import { validateVersionedModels } from '../../src/codegen/versioned-models.js'
import type { Diagnostic } from '../../src/codegen/types.js'

const SNIPPET = "lockVersion: integer('lock_version').notNull().default(0)"

/** One-stop fixture: schema + model + optional controller → diagnostics. */
function runPass(opts: {
  schema: string
  model: string
  ctrl?: string
}): { diags: Diagnostic[]; model: any } {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, experimentalDecorators: true },
  })
  project.createSourceFile('/project/db/schema.ts', opts.schema)
  project.createSourceFile('/project/models/deal.model.ts', opts.model)
  const ctrlPaths: string[] = []
  if (opts.ctrl) {
    project.createSourceFile('/project/controllers/deal.ctrl.ts', opts.ctrl)
    ctrlPaths.push('/project/controllers/deal.ctrl.ts')
  }
  const schema = extractSchema(project, '/project/db/schema.ts')
  const model = extractModel(project, '/project/models/deal.model.ts')
  const ctrlMeta = extractControllers(project, ctrlPaths)
  const diags = validateVersionedModels(ctrlMeta, { schema, models: [model] })
  return { diags, model }
}

const lockCtrl = (lock: string = 'true') => `
  @controller('/deals')
  @crud(Deal, { update: { permit: ['name'], optimisticLock: ${lock} } })
  export class DealController {}
`

const dealModel = (extra = '') => `
  @model('deals')
  export class Deal {
    ${extra}
  }
`

const serialSchema = (cols = '') => `
  import { pgTable, serial, integer, text, timestamp, varchar, uuid } from 'drizzle-orm/pg-core'
  export const deals = pgTable('deals', {
    id: serial('id').primaryKey(),
    name: text('name'),
    updatedAt: timestamp('updated_at'),
    ${cols}
  })
`

describe('O2a — the lock column must exist', () => {
  it('refuses an opted-in model with no lockVersion column, suggestion carries the paste-ready snippet', () => {
    const { diags } = runPass({ schema: serialSchema(), model: dealModel(), ctrl: lockCtrl() })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toMatch(/has no\s+'lockVersion' column/s)
    expect(diags[0]!.suggestion).toContain(SNIPPET)
  })

  it('a declared `static lockingColumn` resolves the name (and the snippet adapts)', () => {
    const { diags } = runPass({
      schema: serialSchema(),
      model: dealModel(`static lockingColumn = 'revCount'`),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'revCount'")
    expect(diags[0]!.suggestion).toContain("revCount: integer('rev_count').notNull().default(0)")
  })
})

describe('O2b — the lock column must be integer().notNull().default(0)', () => {
  it('nullable → names the missing .notNull()', () => {
    const { diags } = runPass({
      schema: serialSchema(`lockVersion: integer('lock_version').default(0),`),
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain('.notNull()')
    expect(diags[0]!.suggestion).toContain(SNIPPET)
  })

  it('no default → names the missing .default(0)', () => {
    const { diags } = runPass({
      schema: serialSchema(`lockVersion: integer('lock_version').notNull(),`),
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain('.default(0)')
  })

  it('a bigint lock column is refused (pg returns strings — the CAS cannot bump them)', () => {
    const { diags } = runPass({
      schema: `
        import { pgTable, serial, bigint, text } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          id: serial('id').primaryKey(),
          name: text('name'),
          lockVersion: bigint('lock_version', { mode: 'number' }).notNull().default(0),
        })
      `,
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'bigint'")
  })

  it('the mis-shape fires on MODEL-side opt-in alone (a lockVersion column IS the opt-in — core CAS engages on it)', () => {
    const { diags } = runPass({
      schema: serialSchema(`lockVersion: integer('lock_version'),`),
      model: dealModel(),
      // no controller at all
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/mis-shaped/)
  })
})

describe('O2c — the build-time updatedAt-cosplay kill', () => {
  it("optimisticLock: 'updatedAt' (a timestamp column) is refused outright, naming the migration", () => {
    const { diags } = runPass({
      schema: serialSchema(`lockVersion: integer('lock_version').notNull().default(0),`),
      model: dealModel(),
      ctrl: lockCtrl(`'updatedAt'`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/timestamps cannot be lock tokens/i)
    expect(diags[0]!.suggestion).toContain(SNIPPET)
  })

  it('a timestamp lockingColumn override is refused too', () => {
    const { diags } = runPass({
      schema: serialSchema(),
      model: dealModel(`static lockingColumn = 'updatedAt'`),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/is a timestamp/)
  })
})

describe("O2d — optimisticLock: '<col>' must name the model's locking column", () => {
  it('an undeclared integer column is refused (build-time twin of the runtime guard)', () => {
    const { diags } = runPass({
      schema: serialSchema(`rev: integer('rev').notNull().default(0), lockVersion: integer('lock_version').notNull().default(0),`),
      model: dealModel(),
      ctrl: lockCtrl(`'rev'`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/never advance/)
    expect(diags[0]!.suggestion).toContain("static lockingColumn = 'rev'")
  })

  it("the declared lockingColumn silences it; 'lockVersion' needs no declaration", () => {
    const declared = runPass({
      schema: serialSchema(`rev: integer('rev').notNull().default(0),`),
      model: dealModel(`static lockingColumn = 'rev'`),
      ctrl: lockCtrl(`'rev'`),
    })
    expect(declared.diags).toEqual([])
    const convention = runPass({
      schema: serialSchema(`lockVersion: integer('lock_version').notNull().default(0),`),
      model: dealModel(),
      ctrl: lockCtrl(`'lockVersion'`),
    })
    expect(convention.diags).toEqual([])
  })

  it("'lockVersion' over a model that declared lockingColumn = 'rev' is refused too (comparison is against the RESOLVED column)", () => {
    // The envelope would serve tokens from lockVersion while core's CAS bumps
    // 'rev' — a permanently-passing pre-check, i.e. a silently dead lock.
    const { diags } = runPass({
      schema: serialSchema(`rev: integer('rev').notNull().default(0), lockVersion: integer('lock_version').notNull().default(0),`),
      model: dealModel(`static lockingColumn = 'rev'`),
      ctrl: lockCtrl(`'lockVersion'`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/never advance/)
  })

  it('a string opt-in error does NOT also fire the O2a missing-column error (one mistake, one diagnostic)', () => {
    // The classic upgrade case: `optimisticLock: 'updatedAt'` on a table with
    // NO lockVersion column — the cosplay refusal already carries the full
    // migration; a second "no 'lockVersion' column" error would name a column
    // the user never mentioned.
    const { diags } = runPass({
      schema: serialSchema(), // no lockVersion column at all
      model: dealModel(),
      ctrl: lockCtrl(`'updatedAt'`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/timestamps cannot be lock tokens/i)
  })
})

describe('optimisticLock vs `static lockingColumn = false` is a contradiction', () => {
  it('refused with both fixes named', () => {
    const { diags } = runPass({
      schema: serialSchema(),
      model: dealModel(`static lockingColumn = false`),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain('lockingColumn = false')
    expect(diags[0]!.suggestion).toContain(SNIPPET)
  })

  it('without a controller opt-in, `lockingColumn = false` simply turns the pass off', () => {
    const { diags } = runPass({
      // even with a (mis-shaped) lockVersion column present
      schema: serialSchema(`lockVersion: integer('lock_version'),`),
      model: dealModel(`static lockingColumn = false`),
    })
    expect(diags).toEqual([])
  })
})

describe('O14 — the pk lineage rule', () => {
  const naturalKeySchema = (cols = '') => `
    import { pgTable, varchar, integer, text, timestamp } from 'drizzle-orm/pg-core'
    export const deals = pgTable('deals', {
      slug: varchar('slug', { length: 64 }).primaryKey(),
      name: text('name'),
      ${cols}
    })
  `
  const goodLock = `lockVersion: integer('lock_version').notNull().default(0),`

  it('varchar pk + optimisticLock without soft-delete → refusal naming BOTH fixes', () => {
    const { diags } = runPass({
      schema: naturalKeySchema(goodLock),
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/REUSABLE/)
    expect(diags[0]!.suggestion).toMatch(/never-reused pk|serial/)
    expect(diags[0]!.suggestion).toContain('@include(SoftDeletable)')
  })

  it('the same model + @include(SoftDeletable) passes', () => {
    const { diags, model } = runPass({
      schema: naturalKeySchema(goodLock + ` deletedAt: timestamp('deleted_at'),`),
      model: `
        @model('deals')
        @include(SoftDeletable)
        export class Deal {}
      `,
      ctrl: lockCtrl(),
    })
    expect(model.softDelete).toBe(true)
    expect(diags).toEqual([])
  })

  it('@include(SoftDeletable) with a MISSING soft-delete column is refused — the lineage certificate would be void', () => {
    const { diags } = runPass({
      schema: naturalKeySchema(goodLock), // no deletedAt column at all
      model: `
        @model('deals')
        @include(SoftDeletable)
        export class Deal {}
      `,
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/no 'deletedAt' column/)
    expect(diags[0]!.suggestion).toContain("timestamp('deleted_at')")
  })

  it("a NON-timestamp soft-delete column is refused — the concern's destroy writes new Date()", () => {
    const { diags } = runPass({
      schema: naturalKeySchema(goodLock + ` deletedAt: integer('deleted_at'),`),
      model: `
        @model('deals')
        @include(SoftDeletable)
        export class Deal {}
      `,
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/'integer'/)
  })

  it('a custom columnName is honored end-to-end (extracted AND validated against the table)', () => {
    const good = runPass({
      schema: naturalKeySchema(goodLock + ` removedAt: timestamp('removed_at'),`),
      model: `
        @model('deals')
        @include(SoftDeletable, { columnName: 'removedAt' })
        export class Deal {}
      `,
      ctrl: lockCtrl(),
    })
    expect(good.diags).toEqual([])
    const bad = runPass({
      schema: naturalKeySchema(goodLock + ` deletedAt: timestamp('deleted_at'),`), // wrong column present
      model: `
        @model('deals')
        @include(SoftDeletable, { columnName: 'removedAt' })
        export class Deal {}
      `,
      ctrl: lockCtrl(),
    })
    expect(bad.diags).toHaveLength(1)
    expect(bad.diags[0]!.message).toMatch(/no 'removedAt' column/)
  })

  it('a plain (non-serial, non-identity) integer pk is reusable → refused', () => {
    const { diags } = runPass({
      schema: `
        import { pgTable, integer, text } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          id: integer('id').primaryKey(),
          name: text('name'),
          ${goodLock}
        })
      `,
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/REUSABLE/)
  })

  it('NO detectable pk (composite third-arg pk) is conservatively refused, and the error says why', () => {
    const { diags } = runPass({
      schema: `
        import { pgTable, integer, text, primaryKey } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          tenantId: integer('tenant_id').notNull(),
          dealNo: integer('deal_no').notNull(),
          name: text('name'),
          ${goodLock}
        }, t => [primaryKey({ columns: [t.tenantId, t.dealNo] })])
      `,
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/composite|invisible to codegen/)
  })

  it('serial, identity, and uuid.defaultRandom pks all pass (never reused)', () => {
    const goodCases = [
      serialSchema(goodLock),
      `
        import { pgTable, integer, text } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
          name: text('name'),
          ${goodLock}
        })
      `,
      `
        import { pgTable, uuid, integer, text } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          id: uuid('id').defaultRandom().primaryKey(),
          name: text('name'),
          ${goodLock}
        })
      `,
    ]
    for (const schema of goodCases) {
      const { diags } = runPass({ schema, model: dealModel(), ctrl: lockCtrl() })
      expect(diags).toEqual([])
    }
  })

  it('a DEFAULTLESS uuid pk is REUSABLE (client-supplied — a natural key in uuid clothing) → refused', () => {
    // Without .defaultRandom()/$defaultFn the writer supplies the uuid, and an
    // offline-first client re-creating a destroyed uuid restarts the token
    // chain — the exact silent-stale-certify case O14 refuses.
    const { diags } = runPass({
      schema: `
        import { pgTable, uuid, integer, text } from 'drizzle-orm/pg-core'
        export const deals = pgTable('deals', {
          id: uuid('id').primaryKey(),
          name: text('name'),
          ${goodLock}
        })
      `,
      model: dealModel(),
      ctrl: lockCtrl(),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/REUSABLE/)
    expect(diags[0]!.message).toMatch(/client-supplied/)
    expect(diags[0]!.suggestion).toContain('uuid.defaultRandom')
  })

  it('a model with NO lock opt-in and a natural pk is untouched (rule only fires on lock-tokened models)', () => {
    const { diags } = runPass({
      schema: naturalKeySchema(), // no lockVersion column, no controller
      model: dealModel(),
    })
    expect(diags).toEqual([])
  })
})

describe('extractor groundwork', () => {
  it("uuid().defaultRandom() reads as hasDefault (no longer misclassified as no-default)", () => {
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile('/s.ts', `
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const t = pgTable('t', { id: uuid('id').defaultRandom().primaryKey() })
    `)
    const schema = extractSchema(project, '/s.ts')
    const id = schema.tables['t']!.columns.find(c => c.name === 'id')!
    expect(id.hasDefault).toBe(true)
    expect(id.primaryKey).toBe(true)
  })

  it('static lockingColumn literals extract (string and false); absent stays undefined', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true } })
    project.createSourceFile('/a.model.ts', `@model('deals')\nexport class A { static lockingColumn = 'rev' }`)
    project.createSourceFile('/b.model.ts', `@model('deals')\nexport class B { static lockingColumn = false }`)
    project.createSourceFile('/c.model.ts', `@model('deals')\nexport class C {}`)
    expect(extractModel(project, '/a.model.ts').lockingColumn).toBe('rev')
    expect(extractModel(project, '/b.model.ts').lockingColumn).toBe(false)
    expect(extractModel(project, '/c.model.ts').lockingColumn).toBeUndefined()
  })

  it('@include(SoftDeletable) is detected, honoring the columnName config literal', () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true } })
    project.createSourceFile('/a.model.ts', `
      @model('deals')
      @include(SoftDeletable, { columnName: 'removedAt' })
      export class A {}
    `)
    project.createSourceFile('/b.model.ts', `
      @model('deals')
      @include(Trackable)
      export class B {}
    `)
    const a = extractModel(project, '/a.model.ts')
    expect(a.softDelete).toBe(true)
    expect(a.softDeleteColumn).toBe('removedAt')
    const b = extractModel(project, '/b.model.ts')
    expect(b.softDelete).toBeUndefined()
  })
})
