/**
 * Attr.state codegen — extractor, validator, generators.
 *
 * Proves the machine travels: model source → StateMeta → .d.ts types,
 * schema.md docs, model Client can(), and controller Client can() with
 * projection-scoped, fail-closed guard shipping.
 */

import { describe, it, expect } from 'vitest'
import { createTestProject } from '../helpers/index.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

const loansSchema = `
import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

export const loans = pgTable('loans', {
  id: serial('id').primaryKey(),
  status: integer('status'),
  amount: integer('amount'),
  adminCap: integer('admin_cap'),
})
`

const loanModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  static status = Attr.state({
    states: { draft: 0, submitted: 1, approved: 2 } as const,
    initial: 'draft',
    transitions: {
      submit:  { from: ['draft'], to: 'submitted' },
      approve: { from: ['submitted'], to: 'approved', if: (r: any) => r.adminCap != null, message: 'needs a cap' },
      reopen:  { from: '*', to: 'draft' },
    },
  })
}
`

const loanModelUnprovableGuard = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

declare function externalCheck(x: unknown): boolean

@model('loans')
export class Loan extends ApplicationRecord {
  static status = Attr.state({
    states: { draft: 0, submitted: 1 } as const,
    transitions: {
      submit: { from: ['draft'], to: 'submitted', if: (r: any) => externalCheck(r) },
    },
  })
}
`

const loanModelDeclaredGuardDeps = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

declare function externalCheck(x: unknown): boolean

@model('loans')
export class Loan extends ApplicationRecord {
  static status = Attr.state({
    states: { draft: 0, submitted: 1 } as const,
    transitions: {
      submit: { from: ['draft'], to: 'submitted', if: (r: any) => externalCheck(r), deps: ['amount'] },
    },
  })
}
`

function projectFor(modelSource: string) {
  return createTestProject({
    schema: loansSchema,
    models: { 'Loan.model.ts': modelSource },
  })
}

// ── Extractor ────────────────────────────────────────────────────────────────

describe('extractor: Attr.state → StateMeta', () => {
  it('extracts states, initial, and the transition graph', () => {
    const meta = projectFor(loanModel).extractModel('Loan.model.ts')
    expect(meta.states).toHaveLength(1)

    const st = meta.states[0]!
    expect(st.propertyName).toBe('status')
    expect(st.values).toEqual({ draft: 0, submitted: 1, approved: 2 })
    expect(st.initial).toBe('draft')

    const events = Object.fromEntries(st.transitions.map(t => [t.event, t]))
    expect(events.submit).toMatchObject({ from: ['draft'], to: 'submitted', guardSource: null })
    expect(events.approve).toMatchObject({ to: 'approved', message: 'needs a cap' })
    expect(events.reopen).toMatchObject({ from: '*', to: 'draft' })
  })

  it('infers guard deps through the predicate walker', () => {
    const st = projectFor(loanModel).extractModel('Loan.model.ts').states[0]!
    const approve = st.transitions.find(t => t.event === 'approve')!
    expect(approve.guardDeps).toEqual(['adminCap'])
    expect(approve.guardDepsError).toBeNull()
  })

  it('refuses an unprovable guard (record escapes to external fn)', () => {
    const st = projectFor(loanModelUnprovableGuard).extractModel('Loan.model.ts').states[0]!
    const submit = st.transitions.find(t => t.event === 'submit')!
    expect(submit.guardDeps).toBeNull()
    expect(submit.guardDepsError).toMatch(/can't infer deps/)
  })

  it('accepts declared deps as the guard escape hatch', () => {
    const st = projectFor(loanModelDeclaredGuardDeps).extractModel('Loan.model.ts').states[0]!
    const submit = st.transitions.find(t => t.event === 'submit')!
    expect(submit.guardDeps).toEqual(['amount'])
    expect(submit.guardDepsError).toBeNull()
  })

  it('recognizes Attr.enum as an enum declaration (README dialect)', () => {
    const enumModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  static kind = Attr.enum({ small: 0, large: 1 } as const)
}
`
    const meta = projectFor(enumModel).extractModel('Loan.model.ts')
    expect(meta.enums).toContainEqual({ propertyName: 'kind', values: { small: 0, large: 1 } })
  })
})

// ── Validator ────────────────────────────────────────────────────────────────

describe('validator: state machine build gates', () => {
  it('unprovable guard without declared deps is a hard error', () => {
    const diagnostics = projectFor(loanModelUnprovableGuard).validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /can't infer deps/.test(d.message)),
    ).toBe(true)
  })

  it('declared guard deps silence the error', () => {
    const diagnostics = projectFor(loanModelDeclaredGuardDeps).validate()
    expect(diagnostics.filter(d => /can't infer deps/.test(d.message))).toHaveLength(0)
  })

  it('a clean machine produces no state diagnostics', () => {
    const diagnostics = projectFor(loanModel).validate()
    expect(diagnostics.filter(d => /Attr\.state/.test(d.message))).toHaveLength(0)
  })
})

// ── Generators: types + docs + model Client ──────────────────────────────────

describe('generators: .d.ts, schema.md, model Client', () => {
  it('emits label-union field, can/advance, per-event methods in .d.ts', () => {
    const result = projectFor(loanModel).run()
    const dts = result.files['Loan.model.types.gen.d.ts']!

    expect(dts).toContain(`status: 'draft' | 'submitted' | 'approved' | null`)
    expect(dts).toContain(`can(event: 'submit' | 'approve' | 'reopen'): boolean`)
    expect(dts).toContain(`advance(event: 'submit' | 'approve' | 'reopen'): Promise<boolean>`)
    expect(dts).toContain('canSubmit(): boolean')
    expect(dts).toContain('submit(): boolean')
    expect(dts).toContain('isDraft(): boolean')
  })

  it('documents the machine in schema.md', () => {
    const result = projectFor(loanModel).run()
    const docs = result.files['.active-drizzle/schema.md']!
    expect(docs).toContain('### State Machines')
    expect(docs).toContain('`submit`:')
    expect(docs).toContain('(initial: `draft`)')
  })

  it('model Client gets can() with from-checks and provable guards inlined', () => {
    const result = projectFor(loanModel).run()
    const client = result.files['Loan.model.gen.ts']!

    expect(client).toContain('can(event: string): boolean')
    // approve guard reads adminCap — a model column → provable → inlined
    expect(client).toContain('adminCap != null')
    // wildcard reopen has no from-check
    expect(client).toMatch(/if \(event === 'reopen'\) return true/)
  })
})

// ── Controller Clients: projection-scoped can() ──────────────────────────────

describe('controller Client can() ships guards by projection, fail-closed', () => {
  function makeCtrl(className: string, permit: string[]): CtrlMeta {
    return {
      filePath: `/src/${className}.ctrl.ts`,
      className,
      basePath: '/loans',
      scopes: [],
      kind: 'crud',
      modelClass: 'Loan',
      mutations: [],
      actions: [],
      crudConfig: { create: { permit }, update: { permit } },
    } as CtrlMeta
  }

  function generate(controllers: CtrlMeta[]): Record<string, string> {
    const project = projectFor(loanModel)
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Loan.model.ts')],
    }
    const ctrlProject: CtrlProjectMeta = { controllers }
    return Object.fromEntries(
      generateReactHooks(ctrlProject, projectMeta, '/out').map(f => [f.filePath, f.content]),
    )
  }

  it('admin projection (includes adminCap) inlines the approve guard', () => {
    const files = generate([makeCtrl('AdminLoanController', ['amount', 'adminCap', 'status'])])
    const admin = Object.entries(files).find(([p]) => p.toLowerCase().includes('admin'))![1]
    expect(admin).toContain('statusIsDraft()')
    expect(admin).toContain(`if (event === 'approve')`)
    expect(admin).toContain('adminCap != null')
  })

  it('borrower projection (no adminCap) fail-closes the approve guard to false', () => {
    const files = generate([makeCtrl('BorrowerLoanController', ['amount', 'status'])])
    const borrower = Object.entries(files).find(([p]) => p.toLowerCase().includes('borrower'))![1]
    // The from-check survives; the unprovable-for-this-projection guard is `false`
    const approveLine = borrower.split('\n').find(l => l.includes(`if (event === 'approve')`))!
    expect(approveLine).toContain('&& false')
    expect(approveLine).not.toContain('adminCap != null')
  })
})
