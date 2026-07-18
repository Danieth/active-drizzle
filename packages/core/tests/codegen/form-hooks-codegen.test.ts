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

  it('wires useEditForm: GET envelope → session → handle; PATCH diff + version + _event', () => {
    const out = generate()
    expect(out).toContain('export function useLoanEditForm(id: number)')
    expect(out).toContain('abilities: payload.abilities ?? null')
    expect(out).toContain('can: payload.can ?? null')
    expect(out).toContain(`data: _event ? { ...data, _event } : data`)
    expect(out).toContain('...(version ? { version } : {})')
    expect(out).toContain('qc.invalidateQueries')
    expect(out).toContain(`fieldMeta: (LoanClient as any).fieldMeta`)
  })

  it('wires useNewForm with a defaults draft and create transport', () => {
    const out = generate()
    expect(out).toContain('export function useLoanNewForm()')
    expect(out).toContain(`mode: 'new'`)
    expect(out).toContain('client.loans.create')
  })

  it('maps transport failures to the SubmitResult contract (422/401/403/409)', () => {
    const out = generate()
    expect(out).toContain('parsed?.isValidation ? 422')
    expect(out).toContain(`parsed?.code === 'CONFLICT' ? 409`)
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
  static notes = hasMany('notes', { acceptsNested: true, order: { position: 'asc' } })
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
    const ctrl: CtrlMeta = {
      filePath: '/src/Deal.ctrl.ts', className: 'DealController', basePath: '/deals',
      scopes: [], kind: 'crud', modelClass: 'Deal', mutations: [], actions: [],
      crudConfig: {
        get: { expose: ['id', 'name'], abilities: true, include: ['notes'] },
        update: { permit: ['name'] }, create: { permit: ['name'] },
      },
    } as CtrlMeta
    const out = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
      .find(f => f.filePath.includes('deal.gen'))!.content

    expect(out).toContain(`notes: { kind: 'nested', orderBy: 'position', fields: {`)
    expect(out).toContain(`body: { kind: 'string', label: "Note" }`)
    expect(out).toContain(`position: { kind: 'integer' }`)
  })
})
