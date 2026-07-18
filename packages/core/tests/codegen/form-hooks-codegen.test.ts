/**
 * Generated typed form handles + wired hooks (envelope controllers).
 *
 * An envelope controller (get.expose + get.abilities) emits:
 *   - `${Model}FormHandle` — FormHandleApi & per-field TypedFieldComponent<kind>
 *   - use${Model}EditForm — GET envelope → FormSession → handle; PATCH diff
 *   - use${Model}NewForm — defaults draft → create
 * Controllers without the envelope emit none of it.
 */

import { describe, it, expect } from 'vitest'
import { createTestProject } from '../helpers/index.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import { extractControllers } from '../../src/codegen/controller-extractor.js'
import { Project } from 'ts-morph'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

const loansSchema = `
import { pgTable, serial, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const loans = pgTable('loans', {
  id: serial('id').primaryKey(),
  amount: integer('amount'),
  purpose: text('purpose'),
  isPublished: boolean('is_published'),
  status: integer('status'),
  updatedAt: timestamp('updated_at'),
})
`

const loanModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', { label: 'Amount' })
  static status = Attr.state({
    states: { draft: 0, submitted: 1 } as const,
    initial: 'draft',
    transitions: { submit: { from: ['draft'], to: 'submitted' } },
  })
}
`

function generate(overrides: Partial<CtrlMeta> = {}): string {
  const project = createTestProject({
    schema: loansSchema,
    models: { 'Loan.model.ts': loanModel },
  })
  const projectMeta: ProjectMeta = {
    schema: project.extractSchema(),
    models: [project.extractModel('Loan.model.ts')],
  }
  const ctrl: CtrlMeta = {
    filePath: '/src/Loan.ctrl.ts',
    className: 'LoanController',
    basePath: '/loans',
    scopes: [],
    kind: 'crud',
    modelClass: 'Loan',
    mutations: [],
    actions: [],
    crudConfig: {
      get: { expose: ['id', 'amount', 'purpose', 'isPublished', 'status'], abilities: true },
      update: { permit: ['amount', 'purpose'] },
      create: { permit: ['amount', 'purpose'] },
    },
    ...overrides,
  } as CtrlMeta
  const files = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
  return files.find(f => f.filePath.includes('loan.gen'))!.content
}

describe('typed form handle emission', () => {
  it('emits FormHandleApi & per-field TypedFieldComponent with resolved kinds', () => {
    const out = generate()
    expect(out).toContain('export type LoanFormHandle = FormHandleApi<LoanClient> & {')
    expect(out).toContain(`amount: TypedFieldComponent<'money'>`)      // Attr meta kind
    expect(out).toContain(`status: TypedFieldComponent<'state'>`)      // Attr.state
    expect(out).toContain(`purpose: TypedFieldComponent<'string'>`)    // column fallback
    expect(out).toContain(`isPublished: TypedFieldComponent<'boolean'>`)
    expect(out).toContain(`id: TypedFieldComponent<'integer'>`)
  })

  it('wires useEditForm through useGeneratedForm: id-keyed, envelope-fed, _event passthrough', () => {
    const out = generate()
    expect(out).toContain('export function useLoanEditForm(id: number)')
    expect(out).toContain('useGeneratedForm<LoanClient>({')
    expect(out).toContain('formKey: id,')
    expect(out).toContain('data: query.data ?? null,')
    expect(out).toContain('makeDraft: (r) => new LoanClient(r),')
    expect(out).toContain(`data: _event ? { ...data, _event } : data`)
    expect(out).toContain('qc.invalidateQueries')
    expect(out).toContain(`fieldMeta: (LoanClient as any).fieldMeta`)
    // envelope-shaped responses ALWAYS flow through (abilities re-mask)
    expect(out).toContain(`'record' in res ? { envelope: res }`)
    // no versioning machinery anywhere
    expect(out).not.toContain('version')
  })

  it('wires useNewForm with a defaults draft and create transport', () => {
    const out = generate()
    expect(out).toContain('export function useLoanNewForm()')
    expect(out).toContain(`mode: 'new'`)
    expect(out).toContain('client.loans.create')
  })

  it('maps transport failures to the SubmitResult contract (422/401/403)', () => {
    const out = generate()
    expect(out).toContain('parsed?.isValidation ? 422')
    expect(out).toContain('parsed?.isUnauthorized ? 401')
  })

  it('scoped controllers thread scope params through the transport', () => {
    const out = generate({
      scopes: [{ field: 'teamId', resource: 'teams', paramName: 'teamId' }],
    } as Partial<CtrlMeta>)
    expect(out).toContain('scopes: { teamId: number }')
    expect(out).toContain('...scopes, id')
  })

  it('controllers WITHOUT the envelope emit no form hooks at all', () => {
    const out = generate({
      crudConfig: { update: { permit: ['amount'] }, create: { permit: ['amount'] } },
    } as Partial<CtrlMeta>)
    expect(out).not.toContain('FormHandle')
    expect(out).not.toContain('useLoanEditForm')
    expect(out).not.toContain('FormSession')
  })
})

describe('nested meta emission', () => {
  it('acceptsNested associations emit kind nested with child fields + orderBy', () => {
    const schema = `
import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'
export const deals = pgTable('deals', {
  id: serial('id').primaryKey(),
  name: text('name'),
})
export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  dealId: integer('deal_id'),
  body: text('body'),
  position: integer('position'),
})
`
    const dealModel = `
import { ApplicationRecord, model, Attr, hasMany } from 'active-drizzle'
@model('deals')
export class Deal extends ApplicationRecord {
  static notes = hasMany('notes', { acceptsNested: { allowDestroy: true }, order: { position: 'asc' } })
}
`
    const noteModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('notes')
export class Note extends ApplicationRecord {
  static body = Attr.string({ label: 'Note' })
}
`
    const project = createTestProject({ schema, models: { 'Deal.model.ts': dealModel, 'Note.model.ts': noteModel } })
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Deal.model.ts'), project.extractModel('Note.model.ts')],
    }
    const makeCtrl = (crudConfig: any): CtrlMeta => ({
      filePath: '/src/Deal.ctrl.ts', className: 'DealController', basePath: '/deals',
      scopes: [], kind: 'crud', modelClass: 'Deal', mutations: [], actions: [],
      crudConfig,
    } as CtrlMeta)
    const gen = (crudConfig: any) =>
      generateReactHooks({ controllers: [makeCtrl(crudConfig)] } as CtrlProjectMeta, projectMeta, '/out')
        .find(f => f.filePath.includes('deal.gen'))!.content

    // Permitted: the nested form ships, and Write types the rows array
    const out = gen({
      get: { expose: ['id', 'name'], abilities: true, include: ['notes'] },
      update: { permit: ['name', 'notesAttributes'] }, create: { permit: ['name', 'notesAttributes'] },
    })
    expect(out).toContain(`notes: { kind: 'nested', allowDestroy: true, orderBy: 'position', fields: {`)
    expect(out).toContain(`body: { kind: 'string', label: "Note" }`)
    expect(out).toContain(`position: { kind: 'integer' }`)
    expect(out).toContain(`notesAttributes?: Array<Record<string, any> & { id?: number; _destroy?: boolean; _key?: string }>`)
    expect(out).not.toContain(`'notesAttributes'>`)   // never a Pick key — it isn't a column
    // The parent foreign key is NEVER advertised as an editable child field
    // (it is forced server-side; the sanitizer strips it) — dealId absent
    expect(out).not.toContain(`dealId:`)

    // Fail-closed gate: both permits static and neither includes
    // notesAttributes → the server would strip every nested write, so the
    // editable nested form is NOT generated
    const gated = gen({
      get: { expose: ['id', 'name'], abilities: true, include: ['notes'] },
      update: { permit: ['name'] }, create: { permit: ['name'] },
    })
    expect(gated).not.toContain(`kind: 'nested'`)

    // A DYNAMIC (record-aware) permit could allow it at runtime → emit;
    // the envelope's abilities mask governs per record
    const dynamic = gen({
      get: { expose: ['id', 'name'], abilities: true, include: ['notes'] },
      update: {}, create: { permit: ['name'] },   // update.permit extracted as undefined
    })
    expect(dynamic).toContain(`notes: { kind: 'nested'`)
  })

  it('nests to ARBITRARY DEPTH — a grandchild array emits inside the child fields', () => {
    const schema = `
import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'
export const deals = pgTable('deals', { id: serial('id').primaryKey(), name: text('name') })
export const notes = pgTable('notes', {
  id: serial('id').primaryKey(), dealId: integer('deal_id'), body: text('body'),
})
export const reactions = pgTable('reactions', {
  id: serial('id').primaryKey(), noteId: integer('note_id'), userId: integer('user_id'), kind: text('kind'),
})
`
    const dealModel = `
import { ApplicationRecord, model, hasMany } from 'active-drizzle'
@model('deals')
export class Deal extends ApplicationRecord {
  static notes = hasMany('notes', { acceptsNested: { allowDestroy: true } })
}
`
    const noteModel = `
import { ApplicationRecord, model, Attr, hasMany } from 'active-drizzle'
@model('notes')
export class Note extends ApplicationRecord {
  static body = Attr.string({ label: 'Note' })
  static reactions = hasMany('reactions', { acceptsNested: { allowDestroy: true } })
}
`
    const reactionModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('reactions')
export class Reaction extends ApplicationRecord {
  static kind = Attr.string({ label: 'Kind' })
}
`
    const project = createTestProject({
      schema,
      models: { 'Deal.model.ts': dealModel, 'Note.model.ts': noteModel, 'Reaction.model.ts': reactionModel },
    })
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [
        project.extractModel('Deal.model.ts'),
        project.extractModel('Note.model.ts'),
        project.extractModel('Reaction.model.ts'),
      ],
    }
    const ctrl: CtrlMeta = {
      filePath: '/src/Deal.ctrl.ts', className: 'DealController', basePath: '/deals',
      scopes: [], kind: 'crud', modelClass: 'Deal', mutations: [], actions: [],
      crudConfig: {
        get: { expose: ['id', 'name'], abilities: true, include: ['notes'] },
        update: { permit: ['name', 'notesAttributes'] }, create: { permit: ['name', 'notesAttributes'] },
      },
    } as CtrlMeta
    const out = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
      .find(f => f.filePath.includes('deal.gen'))!.content

    // The reactions grandchild nests INSIDE the notes fields object
    expect(out).toContain(`reactions: { kind: 'nested'`)
    expect(out).toContain(`kind: { kind: 'string', label: "Kind" }`)
    // Server-forced fields stripped at BOTH levels
    expect(out).not.toContain(`dealId:`)
    expect(out).not.toContain(`noteId:`)
    // Structural: reactions appears after the notes 'kind: nested' opener
    const notesIdx = out.indexOf(`notes: { kind: 'nested'`)
    const reactionsIdx = out.indexOf(`reactions: { kind: 'nested'`)
    expect(notesIdx).toBeGreaterThanOrEqual(0)
    expect(reactionsIdx).toBeGreaterThan(notesIdx)   // nested within, not a sibling
  })
})

describe('review findings — write types and state typing', () => {
  it('permit: [...SPREAD] of a local const resolves (write type not empty)', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModel },
    })
    const ctrlSource = `
import { controller, crud } from '@active-drizzle/controller'
class Loan {}
const EDITABLE = ['amount', 'purpose'] as const

@controller()
@crud(Loan, {
  get: { expose: ['id', 'amount', 'purpose', 'status'], abilities: true },
  create: { permit: [...EDITABLE] },
  update: { permit: (ctx: any, ctrl: any, r: any) => (r.isDraft() ? [...EDITABLE] : []) },
})
class LoanController {}
`
    const p2 = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: false } })
    p2.createSourceFile('/src/loan.ctrl.ts', ctrlSource)
    const ctrl = extractControllers(p2, ['/src/loan.ctrl.ts']).controllers[0]!
    expect(ctrl.crudConfig?.create?.permit).toEqual(['amount', 'purpose'])

    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Loan.model.ts')],
    }
    const out = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
      .find(f => f.filePath.includes('loan.gen'))!.content
    expect(out).toContain(`export type LoanWrite = Pick<LoanAttrs, 'amount' | 'purpose'>`)
  })

  it('all-dynamic permits fall back to expose-derived write type', () => {
    const out = generate({
      crudConfig: {
        get: { expose: ['id', 'amount', 'purpose', 'updatedAt'], abilities: true },
        // both permits dynamic → extracted as undefined
      },
    } as Partial<CtrlMeta>)
    // id/updatedAt never writable; the rest form the static Write type
    expect(out).toContain(`export type LoanWrite = Pick<LoanAttrs, 'amount' | 'purpose'>`)
  })

  it('Attr.state fields are typed as label unions in Attrs and declares', () => {
    const out = generate()
    expect(out).toMatch(/status\??: 'draft' \| 'submitted'/)
    expect(out).not.toMatch(/status\??: number/)
  })

  it('dev-mode warn is emitted inside the validator catch', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': `
import { ApplicationRecord, model, Attr, Validates } from 'active-drizzle'
@model('loans')
export class Loan extends ApplicationRecord {
  static purpose = Attr.string({ validates: Validates.presence() })
}
` },
    })
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Loan.model.ts')],
    }
    const ctrl: CtrlMeta = {
      filePath: '/x.ctrl.ts', className: 'LoanController', basePath: '/loans',
      scopes: [], kind: 'crud', modelClass: 'Loan', mutations: [], actions: [],
      crudConfig: { get: { expose: ['id', 'purpose'], abilities: true }, update: { permit: ['purpose'] }, create: { permit: ['purpose'] } },
    } as CtrlMeta
    const out = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
      .find(f => f.filePath.includes('loan.gen'))!.content
    expect(out).toContain('threw client-side (treated as server-only)')
  })
})
