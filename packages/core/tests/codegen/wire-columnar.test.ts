/**
 * The columnar-doors pass (transport WS2) — the build-time gate for
 * `wire: 'columnar'`:
 *
 *   W1  columnar requires get.expose (the k header IS the column picking)
 *   W2  columnar + included hasMany requires update.optimisticLock (the
 *       owner's pk-array column is refused where the write path can't CAS)
 *   W3  columnar refused on STI-parent doors whose subclasses diverge in
 *       exposed field surface (columnar JSON cannot express per-row absence)
 *   W4  habtm / hasMany-through / polymorphic belongsTo includes refused
 *       (at every depth of the include tree)
 *   W5  columnar requires get.abilities (flagged doors always serve the
 *       record envelope — P6 forbids the flag changing the hook shape)
 *   W6  hasOne in the INDEX include tree refused (list rows cannot re-nest)
 *   W7  includes must sit inside an explicit `access:` ceiling
 *   W8  `access:` + diverging get.expose refused
 *
 * Plus: the `wire` literal extracts, and the react generator emits the
 * flagged hook bodies + wire spec + _entities.gen.ts registration.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractSchema, extractModel } from '../../src/codegen/extractor.js'
import { extractControllers } from '../../src/codegen/controller-extractor.js'
import { validateColumnarDoors } from '../../src/codegen/wire-columnar.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import { projIdFor } from '../../src/runtime/write-log.js'
import type { Diagnostic } from '../../src/codegen/types.js'

const SCHEMA = `
  import { pgTable, serial, integer, text, jsonb } from 'drizzle-orm/pg-core'
  export const loans = pgTable('loans', {
    id: serial('id').primaryKey(),
    title: text('title'),
    stage: integer('stage'),
    brokerId: integer('broker_id'),
    settings: jsonb('settings'),
    lockVersion: integer('lock_version').notNull().default(0),
  })
  export const notes = pgTable('notes', {
    id: serial('id').primaryKey(),
    loanId: integer('loan_id'),
    authorId: integer('author_id'),
    body: text('body'),
  })
  export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    name: text('name'),
  })
`

const LOAN_MODEL = `
  @model('loans')
  export class Loan {
    static notes = hasMany('notes')
    static broker = belongsTo('users', { foreignKey: 'brokerId' })
  }
`
const NOTE_MODEL = `
  @model('notes')
  export class Note {
    static author = belongsTo('users', { foreignKey: 'authorId' })
  }
`
const USER_MODEL = `
  @model('users')
  export class User {}
`

function run(opts: { ctrl: string; models?: Array<[string, string]>; schema?: string }): {
  diags: Diagnostic[]
  ctrlMeta: ReturnType<typeof extractControllers>
  project: Project
  models: any[]
  schema: any
} {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, experimentalDecorators: true },
  })
  project.createSourceFile('/p/db/schema.ts', opts.schema ?? SCHEMA)
  const modelSources = opts.models ?? [
    ['/p/models/loan.model.ts', LOAN_MODEL],
    ['/p/models/note.model.ts', NOTE_MODEL],
    ['/p/models/user.model.ts', USER_MODEL],
  ]
  const models = modelSources.map(([path, src]) => {
    project.createSourceFile(path, src)
    return extractModel(project, path)
  })
  project.createSourceFile('/p/controllers/loan.ctrl.ts', opts.ctrl)
  const schema = extractSchema(project, '/p/db/schema.ts')
  const ctrlMeta = extractControllers(project, ['/p/controllers/loan.ctrl.ts'])
  const diags = validateColumnarDoors(ctrlMeta, { schema, models })
  return { diags, ctrlMeta, project, models, schema }
}

const flaggedCtrl = (config: string) => `
  @controller('/loans')
  @crud(Loan, ${config})
  export class LoanController {}
`

describe('wire literal extraction', () => {
  it("extracts wire: 'columnar' at the CrudConfig top level", () => {
    const { ctrlMeta } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'] } }`),
    })
    expect(ctrlMeta.controllers[0]!.crudConfig?.wire).toBe('columnar')
  })

  it('preserves NESTED include objects in the IR (grandchild reassembly is compiled knowledge)', () => {
    const { ctrlMeta } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], include: [{ notes: ['author'] }] }, update: { permit: ['title'], optimisticLock: true } }`),
    })
    expect(ctrlMeta.controllers[0]!.crudConfig?.get?.include).toEqual([{ notes: ['author'] }])
  })

  it('resolves SPREAD elements in include arrays — `include: [...SHARED]` is the idiomatic DRY form (flag-off doors too)', () => {
    const { ctrlMeta } = run({
      ctrl: `
        const SHARED_INCLUDES = ['notes'] as const
        @controller('/loans')
        @crud(Loan, { get: { expose: ['title'], include: [...SHARED_INCLUDES, { broker: [] }, 'broker'] } })
        export class LoanController {}
      `,
    })
    expect(ctrlMeta.controllers[0]!.crudConfig?.get?.include).toEqual(['notes', { broker: [] }, 'broker'])
  })

  it('an unknown wire value is a teaching error listing the two formats', () => {
    const { diags } = run({ ctrl: flaggedCtrl(`{ wire: 'protobuf', get: { expose: ['title'] } }`) })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'protobuf'")
    expect(diags[0]!.message).toContain("'columnar' or 'nested'")
  })

  it("wire: 'nested' (the default, spelled out) validates nothing", () => {
    const { diags } = run({ ctrl: flaggedCtrl(`{ wire: 'nested' }`) })
    expect(diags).toHaveLength(0)
  })
})

describe('W1 — columnar requires the read ceiling', () => {
  it('refuses a flagged door without get.expose, teaching the fix', () => {
    const { diags } = run({ ctrl: flaggedCtrl(`{ wire: 'columnar', get: { abilities: true } }`) })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('error')
    expect(diags[0]!.message).toContain("wire: 'columnar'")
    expect(diags[0]!.message).toMatch(/expose/)
    expect(diags[0]!.suggestion).toContain('expose')
  })

  it('passes with expose declared', () => {
    const { diags } = run({ ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title', 'stage'], abilities: true } }`) })
    expect(diags).toHaveLength(0)
  })
})

describe('W5 — columnar requires the record envelope (abilities)', () => {
  it('refuses a flagged door without get.abilities — the flag must not change the hook shape (P6)', () => {
    const { diags } = run({ ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'] } }`) })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/abilities: true/)
    expect(diags[0]!.message).toMatch(/hook shape|app-visible/)
    expect(diags[0]!.suggestion).toMatch(/abilities: true/)
  })
})

describe('W2 — included hasMany requires the CAS', () => {
  it('refuses a hasMany include without update.optimisticLock, naming BOTH fixes', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['notes'] } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'notes'")
    expect(diags[0]!.message).toMatch(/pk-array/i)
    expect(diags[0]!.message).toMatch(/compare-and-swap|CAS/i)
    expect(diags[0]!.suggestion).toMatch(/optimisticLock: true/)
    expect(diags[0]!.suggestion).toMatch(/own paged door/)
  })

  it('passes once the door declares optimisticLock', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['notes'] }, update: { permit: ['title'], optimisticLock: true } }`),
    })
    expect(diags).toHaveLength(0)
  })

  it('a belongsTo include never needs the lock (FK column, no pk-array)', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title', 'brokerId'], abilities: true, include: ['broker'] } }`),
    })
    expect(diags).toHaveLength(0)
  })

  it('the index include tree is checked too', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{ wire: 'columnar', index: { include: ['notes'] }, get: { expose: ['title'], abilities: true } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'notes'")
  })

  it('a DEPTH-2 hasMany whose owning model has no lock column is refused (untracked pk-array = silent LWW)', () => {
    // notes (no lock_version column in this schema) → notes.replies would
    // ride v = null. The door's own lock cannot protect a child's pk-array.
    const { diags } = run({
      models: [
        ['/p/models/loan.model.ts', LOAN_MODEL],
        ['/p/models/note.model.ts', `
          @model('notes')
          export class Note {
            static author = belongsTo('users', { foreignKey: 'authorId' })
            static replies = hasMany('replies')
          }
        `],
        ['/p/models/reply.model.ts', `
          @model('replies')
          export class Reply {}
        `],
        ['/p/models/user.model.ts', USER_MODEL],
      ],
      schema: SCHEMA + `
        export const replies = pgTable('replies', {
          id: serial('id').primaryKey(),
          noteId: integer('note_id'),
          body: text('body'),
        })
      `,
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: [{ notes: ['replies'] }] }, update: { permit: ['title'], optimisticLock: true } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/'replies' \(nested include\)/)
    expect(diags[0]!.message).toMatch(/no lock column|untracked/)
    expect(diags[0]!.suggestion).toMatch(/lock_version/)
  })
})

describe('W6 — hasOne in the INDEX include tree', () => {
  const HASONE_MODELS: Array<[string, string]> = [
    ['/p/models/loan.model.ts', `
      @model('loans')
      export class Loan {
        static brief = hasOne('notes')
      }
    `],
    ['/p/models/note.model.ts', NOTE_MODEL],
    ['/p/models/user.model.ts', USER_MODEL],
  ]

  it('refuses it — list rows cannot re-nest hasOne, the member silently vanishes', () => {
    const { diags } = run({
      models: HASONE_MODELS,
      ctrl: flaggedCtrl(`{ wire: 'columnar', index: { include: ['brief'] }, get: { expose: ['title'], abilities: true } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/hasOne/)
    expect(diags[0]!.message).toMatch(/list row|INDEX/)
    expect(diags[0]!.suggestion).toMatch(/get\.include/)
  })

  it('allows the same hasOne in the GET tree (detail responses re-nest it)', () => {
    const { diags } = run({
      models: HASONE_MODELS,
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['brief'] } }`),
    })
    expect(diags).toHaveLength(0)
  })
})

describe('W7/W8 — explicit access ceilings', () => {
  it('W7: an include outside the access tree is refused (the ceiling is total)', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{
        wire: 'columnar',
        access: { viewable: ['title'] },
        index: { include: ['notes'] },
        update: { permit: ['title'], optimisticLock: true },
      }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/'notes'/)
    expect(diags[0]!.message).toMatch(/access/)
    expect(diags[0]!.message).toMatch(/entire column set|TOTAL/i)
  })

  it('W7 passes when the include is declared in the access tree (and W1 accepts access as the ceiling)', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{
        wire: 'columnar',
        access: { viewable: ['title'], include: { notes: { viewable: ['body'] } } },
        index: { include: ['notes'] },
        update: { permit: ['title'], optimisticLock: true },
      }`),
    })
    expect(diags).toHaveLength(0)
  })

  it('W8: expose fields outside the access ceiling are refused (silent-undefined divergence)', () => {
    const { diags } = run({
      ctrl: flaggedCtrl(`{
        wire: 'columnar',
        access: { viewable: ['title'] },
        get: { expose: ['title', 'stage'], abilities: true },
      }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/'stage'/)
    expect(diags[0]!.message).toMatch(/silently undefined/)
  })
})

describe('W4 — includes the wire cannot address', () => {
  it('refuses a habtm include (join-table batching is a later phase)', () => {
    const { diags } = run({
      models: [
        ['/p/models/loan.model.ts', `
          @model('loans')
          export class Loan {
            static tags = habtm('loan_tags')
          }
        `],
      ],
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['tags'] }, update: { permit: ['title'], optimisticLock: true } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/habtm/)
    expect(diags[0]!.suggestion).toMatch(/own paged door/)
  })

  it('refuses a polymorphic belongsTo include (no fixed identity table)', () => {
    const { diags } = run({
      models: [
        ['/p/models/loan.model.ts', `
          @model('loans')
          export class Loan {
            static owner = belongsTo({ polymorphic: true })
          }
        `],
      ],
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true, include: ['owner'] } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toMatch(/POLYMORPHIC/)
  })
})

describe('W3 — STI divergence', () => {
  const stiModels: Array<[string, string]> = [
    ['/p/models/loan.model.ts', `
      @model('loans')
      export class Loan {
        static title = Attr.string({ label: 'Title' })
      }
    `],
    ['/p/models/bridge.model.ts', `
      import { Loan } from './loan.model.js'
      @model('loans')
      export class BridgeLoan extends Loan {
        static stiType = 'BridgeLoan'
        static stage = Attr.enum({ open: 0, won: 1 } as const)
      }
    `],
    ['/p/models/refi.model.ts', `
      import { Loan } from './loan.model.js'
      @model('loans')
      export class RefiLoan extends Loan {
        static stiType = 'RefiLoan'
      }
    `],
  ]

  it('refuses a columnar STI-parent door whose subclasses diverge in an EXPOSED field', () => {
    const { diags } = run({
      models: stiModels,
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title', 'stage'], abilities: true } }`),
    })
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("'stage'")
    expect(diags[0]!.message).toContain('BridgeLoan')
    expect(diags[0]!.message).toMatch(/per-row absence/)
    expect(diags[0]!.suggestion).toMatch(/later phase/)
  })

  it('allows the flag when the divergent field is OUTSIDE the ceiling', () => {
    const { diags } = run({
      models: stiModels,
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true } }`),
    })
    expect(diags).toHaveLength(0)
  })
})

// ── Generated output (the client-half strings) ───────────────────────────────

describe('react generator — flagged door emission', () => {
  function generate(ctrlSrc: string) {
    const { ctrlMeta, models, schema } = run({ ctrl: ctrlSrc })
    const files = generateReactHooks(ctrlMeta, { schema, models }, '/out')
    const byName = new Map(files.map(f => [f.filePath.split('/').pop()!, f.content]))
    return byName
  }

  const FLAGGED = flaggedCtrl(`{
    wire: 'columnar',
    index: { include: [{ notes: ['author'] }], sortable: ['id'] },
    get: { expose: ['title', 'stage', 'brokerId'], abilities: true, include: [{ notes: ['author'] }] },
    update: { permit: ['title', 'stage'], optimisticLock: true },
  }`)

  it('emits the wire specs, projected fields, and the echo decoder', () => {
    const files = generate(FLAGGED)
    const gen = files.get('loan.gen.ts')!
    expect(gen).toContain(`const _loanWireSpec = { table: 'loans', pk: 'id', includes: [{ name: 'notes', table: 'notes', kind: 'hasMany', fk: 'loanId', idsColumn: 'noteIds', includes: [{ name: 'author', table: 'users', kind: 'belongsTo', fk: 'authorId' }] }] }`)
    expect(gen).toContain(`const _loanWireSpecIndex = `)
    expect(gen).toContain(`const _loanWireFields = ['id', 'title', 'stage', 'brokerId', 'noteIds']`)
    expect(gen).toContain(`const _loanMergeEcho = `)
    expect(gen).toContain(`mergeRecordEnvelope(entityStore, res, _loanWireSpec)`)
  })

  it('index/get queryFns merge through the store; membership is the query data', () => {
    const files = generate(FLAGGED)
    const gen = files.get('loan.gen.ts')!
    expect(gen).toContain(`mergeEnvelope(entityStore, env)`)
    expect(gen).toContain(`return { membership: env.membership, ...(env.ctx !== undefined ? { ctx: env.ctx } : {}) }`)
    expect(gen).toContain(`useProjectedRows('loans', _m?.pks ?? [], _loanWireFields, _loanWireSpecIndex)`)
    expect(gen).toContain(`mergeRecordEnvelope(entityStore, await client.loans.get({ id }), _loanWireSpec)`)
    // mutations decode echoes; destroy routes touched → store
    expect(gen).toContain(`client.loans.create({ data }).then(_loanMergeEcho)`)
    expect(gen).toContain(`client.loans.destroy({ id }).then(_loanMergeEcho)`)
    // registration side-effect import
    expect(gen).toContain(`import './_entities.gen'`)
  })

  it('_entities.gen.ts registers jsonb columns, and pk-array ids for columnar hasMany includes', () => {
    const files = generate(FLAGGED)
    const entities = files.get('_entities.gen.ts')!
    expect(entities).toContain(`store.registerFieldKinds('loans', { settings: 'jsonb', noteIds: 'pkArray' })`)
    expect(entities).toContain('registerEntityFieldKinds()')
  })

  it('the echo decoder routes the TOUCHED lane through mergeEnvelope (destroy floors are raised in real apps)', () => {
    const gen = generate(FLAGGED).get('loan.gen.ts')!
    // the decoder's own touched branch — NOT the index queryFn's mergeEnvelope
    expect(gen).toContain(`? (mergeEnvelope(entityStore, res), res)`)
  })

  it('infiniteIndex pages through membership.pagination and recomposes rows from the store', () => {
    const gen = generate(FLAGGED).get('loan.gen.ts')!
    expect(gen).toContain(`getNextPageParam:  (last: any) => last?.membership?.pagination?.hasMore ? (last.membership.pagination.page + 1) : undefined,`)
    expect(gen).toContain(`useProjectedRows('loans', _allPks, _loanWireFields, _loanWireSpecIndex)`)
  })

  it('the 409 error mapper merges the conflict envelope through the decoder (a real payload at its token)', () => {
    const gen = generate(FLAGGED).get('loan.gen.ts')!
    expect(gen).toContain(`envelope: _loanMergeEcho(parsed.envelope)`)
  })

  it('the index-surface and .with() index lanes decode through mergeIndexEnvelope with the INDEX spec', () => {
    const gen = generate(FLAGGED).get('loan.gen.ts')!
    expect(gen).toContain(`mergeIndexEnvelope(entityStore, await client.loans.index(params as any), _loanWireSpecIndex)`)
    expect(gen).toContain(`.then((env: any) => mergeIndexEnvelope(entityStore, env, _loanWireSpecIndex))`)
  })

  it('WS3 client half: the validatable mask + embedded projId + revalidate dispatch + structure-token sharing', () => {
    const gen = generate(FLAGGED).get('loan.gen.ts')!
    // The mask: pk + exposed physical columns; lock column and the hasMany
    // pk-array (noteIds) EXCLUDED by construction — the codegen twin of the
    // server's validatableMask.
    expect(gen).toContain(`const _loanValidatableFields = ['id', 'title', 'stage', 'brokerId']`)
    // projId embedded as a LITERAL via the shared hash helper — the client
    // never hashes at runtime, and the two sides cannot drift.
    expect(gen).toContain(`const _loanProjId = '${projIdFor(['id', 'title', 'stage', 'brokerId'])}'`)
    // The dispatch is ONE module call — no protocol logic in generated strings.
    expect(gen).toContain(`revalidateProjection(entityStore, _loanValidator(scopes), id, opts)`)
    expect(gen).toContain(`client.loans.validate({ ...input })`)
    // W comes from the store (projFreshAt over HELD fields) inside the module;
    // the generated string must never compute or pass knownVersion.
    expect(gen).not.toContain('knownVersion')
    // Membership structure-token guard rides the index queries as structuralSharing.
    expect(gen).toContain(`structuralSharing: shareMembershipData`)
  })

  it('a flagged door in a project with ZERO non-scalar kinds still gets _entities.gen.ts (the generated import must resolve)', () => {
    // no jsonb/habtm anywhere, no includes on the door — the module is empty
    // registration, but it EXISTS, so `import './_entities.gen'` compiles.
    const { ctrlMeta, models, schema } = run({
      schema: `
        import { pgTable, serial, text } from 'drizzle-orm/pg-core'
        export const loans = pgTable('loans', {
          id: serial('id').primaryKey(),
          title: text('title'),
        })
      `,
      models: [['/p/models/loan.model.ts', `
        @model('loans')
        export class Loan {}
      `]],
      ctrl: flaggedCtrl(`{ wire: 'columnar', get: { expose: ['title'], abilities: true } }`),
    })
    const files = generateReactHooks(ctrlMeta, { schema, models }, '/out')
    const byName = new Map(files.map(f => [f.filePath.split('/').pop()!, f.content]))
    expect(byName.get('loan.gen.ts')).toContain(`import './_entities.gen'`)
    const entities = byName.get('_entities.gen.ts')
    expect(entities).toBeDefined()
    expect(entities).toContain('export function registerEntityFieldKinds')
  })

  it('an access-ceiling door emits per-child field masks into the wire spec (client-side §3a projection)', () => {
    const files = generate(flaggedCtrl(`{
      wire: 'columnar',
      access: { viewable: ['title', 'stage'], include: { notes: { editable: ['body'], viewable: ['authorId'] } } },
      index: { include: ['notes'] },
      update: { permit: ['title'], optimisticLock: true },
    }`))
    const gen = files.get('loan.gen.ts')!
    expect(gen).toContain(`{ name: 'notes', table: 'notes', kind: 'hasMany', fk: 'loanId', idsColumn: 'noteIds', fields: ['id', 'body', 'authorId'] }`)
  })

  it('an UNFLAGGED door emits none of the columnar machinery (byte-identity)', () => {
    const files = generate(flaggedCtrl(`{
      index: { include: [{ notes: ['author'] }], sortable: ['id'] },
      get: { expose: ['title', 'stage', 'brokerId'], abilities: true, include: [{ notes: ['author'] }] },
      update: { permit: ['title', 'stage'], optimisticLock: true },
    }`))
    const gen = files.get('loan.gen.ts')!
    expect(gen).not.toContain('WireSpec')
    expect(gen).not.toContain('mergeEnvelope')
    expect(gen).not.toContain('useProjectedRows')
    expect(gen).not.toContain(`import './_entities.gen'`)
    expect(gen).toContain(`queryFn:  () => client.loans.index({ ...params })`)
  })
})
