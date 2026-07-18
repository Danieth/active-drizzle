/**
 * Attr presentational meta — extraction, validation gates, and emission.
 *
 * The meta contract: static data or build error. Labels/help/info are string
 * literals; the open `meta:` bag is literals-only; predicates are dep-inferred
 * arrow functions whose deps must be model fields (the role-in-model ban);
 * copy.by must name an enum/state discriminant with real labels.
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
  amount: integer('amount'),
  purpose: text('purpose'),
  facilityType: integer('facility_type'),
})
`

const richModel = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  static facilityType = Attr.enum({ TERM_LOAN: 0, REVOLVING_CREDIT: 1 } as const)

  static amount = Attr.money('amount', {
    label: 'Requested Loan Amount',
    help: 'Enter the total loan amount you are seeking.',
    info: 'This figure is shared with lenders after submission.',
    copy: {
      by: 'facilityType',
      REVOLVING_CREDIT: { label: 'Requested Facility Size' },
    },
    presenters: { view: 'moneyText', edit: 'moneyInput' },
    presentIf: (r: any) => r.purpose !== 'NEW',
    requiredIf: (r: any) => r.purpose !== 'NEW',
    meta: { icon: 'dollar', priority: 1, tags: ['financial', 'core'] },
  })
}
`

function projectFor(modelSource: string) {
  return createTestProject({ schema: loansSchema, models: { 'Loan.model.ts': modelSource } })
}

// ── Extraction ───────────────────────────────────────────────────────────────

describe('extractor: Attr meta → FieldMetaEntry', () => {
  it('lifts kind, label/help/info, copy, presenters, and the meta bag', () => {
    const meta = projectFor(richModel).extractModel('Loan.model.ts')
    const amount = meta.fieldMeta.amount!

    expect(amount.kind).toBe('money')
    expect(amount.label).toBe('Requested Loan Amount')
    expect(amount.help).toMatch(/total loan amount/)
    expect(amount.info).toMatch(/shared with lenders/)
    expect(amount.copy).toEqual({
      by: 'facilityType',
      overrides: { REVOLVING_CREDIT: { label: 'Requested Facility Size' } },
    })
    expect(amount.presenters).toEqual({ view: 'moneyText', edit: 'moneyInput' })
    expect(amount.extraSource).toContain(`icon: 'dollar'`)
    expect(amount.errors).toHaveLength(0)
  })

  it('infers predicate deps through the record param', () => {
    const amount = projectFor(richModel).extractModel('Loan.model.ts').fieldMeta.amount!
    expect(amount.presentIf).toMatchObject({ deps: ['purpose'], depsError: null })
    expect(amount.requiredIf).toMatchObject({ deps: ['purpose'], depsError: null })
    expect(amount.lockedIf).toBeNull()
  })

  it('records an error for a computed label', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
const LABEL = 'Amount'
@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', { label: LABEL })
}
`
    const amount = projectFor(src).extractModel('Loan.model.ts').fieldMeta.amount!
    expect(amount.errors.some(e => /label.*string literal/.test(e))).toBe(true)
  })

  it('rejects functions inside the open meta bag', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', { meta: { compute: () => 42 } })
}
`
    const amount = projectFor(src).extractModel('Loan.model.ts').fieldMeta.amount!
    expect(amount.errors.some(e => /static data/.test(e))).toBe(true)
  })
})

// ── Validator gates ──────────────────────────────────────────────────────────

describe('validator: meta build gates', () => {
  it('a clean rich model has no meta diagnostics', () => {
    const diagnostics = projectFor(richModel).validate()
    expect(diagnostics.filter(d => d.severity === 'error')).toHaveLength(0)
  })

  it('role-ish predicate dep (not a model field) is a hard error', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', {
    lockedIf: (r: any) => r.currentUserRole !== 'admin',
  })
}
`
    const diagnostics = projectFor(src).validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /role\/identity conditions belong on the controller/.test(d.message)),
    ).toBe(true)
  })

  it('copy.by naming a non-discriminant is a hard error', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', {
    copy: { by: 'purpose', SOMETHING: { label: 'x' } },
  })
}
`
    const diagnostics = projectFor(src).validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /not an enum\/state Attr/.test(d.message)),
    ).toBe(true)
  })

  it('copy override key that is not a label of the discriminant is a hard error', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('loans')
export class Loan extends ApplicationRecord {
  static facilityType = Attr.enum({ TERM_LOAN: 0 } as const)
  static amount = Attr.money('amount', {
    copy: { by: 'facilityType', NOT_A_LABEL: { label: 'x' } },
  })
}
`
    const diagnostics = projectFor(src).validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /unknown label 'NOT_A_LABEL'/.test(d.message)),
    ).toBe(true)
  })

  it('unprovable predicate is a hard error', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
declare function check(x: unknown): boolean
@model('loans')
export class Loan extends ApplicationRecord {
  static amount = Attr.money('amount', {
    presentIf: (r: any) => check(r),
  })
}
`
    const diagnostics = projectFor(src).validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /can't infer deps.*presentIf/.test(d.message)),
    ).toBe(true)
  })
})

// ── Emission ─────────────────────────────────────────────────────────────────

describe('generators: fieldMeta on Clients', () => {
  it('model Client carries static fieldMeta with predicates inlined', () => {
    const result = projectFor(richModel).run()
    const client = result.files['Loan.model.gen.ts']!

    expect(client).toContain('static fieldMeta = {')
    expect(client).toContain(`label: "Requested Loan Amount"`)
    expect(client).toContain(`"REVOLVING_CREDIT":{"label":"Requested Facility Size"}`)
    expect(client).toContain('presentIf: ((r: any) => r.purpose !== ')
    expect(client).toContain(`meta: { icon: 'dollar', priority: 1, tags: ['financial', 'core'] }`)
  })

  it('controller Client filters meta and predicates by projection', () => {
    const project = projectFor(richModel)
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Loan.model.ts')],
    }
    // amount permitted but NOT purpose → presentIf (deps: purpose) must not ship
    const ctrl: CtrlMeta = {
      filePath: '/src/Borrower.ctrl.ts',
      className: 'BorrowerLoanController',
      basePath: '/loans',
      scopes: [],
      kind: 'crud',
      modelClass: 'Loan',
      mutations: [],
      actions: [],
      crudConfig: { create: { permit: ['amount'] }, update: { permit: ['amount'] } },
    } as CtrlMeta
    const files = Object.fromEntries(
      generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
        .map(f => [f.filePath, f.content]),
    )
    const content = Object.entries(files).find(([p]) => p.toLowerCase().includes('borrower'))![1]

    expect(content).toContain(`label: "Requested Loan Amount"`) // static copy ships
    expect(content).not.toContain('presentIf')                  // purpose ∉ projection → omitted
  })
})
