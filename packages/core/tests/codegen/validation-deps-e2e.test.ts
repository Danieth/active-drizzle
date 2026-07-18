/**
 * Validation-deps pipeline — end-to-end proofs.
 *
 * The dep-inference ENGINE is unit-tested in validation-deps.test.ts.
 * These tests prove the WIRES: real model source → extractor → validator →
 * generators, asserting the fail-closed, projection-scoped shipping contract:
 *
 *   1. Extractor: @validate bodies land on meta with the right
 *      validationDeps / validationDepsSource / validationDepsError
 *   2. Validator: unprovable deps and declared-subset violations are HARD
 *      errors (the build fails) — never silent
 *   3. Generators: a validator ships to a controller Client iff its deps fit
 *      that controller's projection (borrower vs admin), and never when its
 *      body calls methods the Client won't have
 */

import { describe, it, expect } from 'vitest'
import { createTestProject, expectErrors } from '../helpers/index.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const loansSchema = `
import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'

export const loans = pgTable('loans', {
  id: serial('id').primaryKey(),
  amount: integer('amount'),
  adminCap: integer('admin_cap'),
  purpose: text('purpose'),
})
`

/** Model with one clean multi-field validator. */
const loanModelClean = `
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  @validate()
  checkCap() {
    if (this.amount != null && this.adminCap != null && this.amount > this.adminCap) {
      return 'amount exceeds the admin cap'
    }
    return null
  }
}
`

/** Model whose validator body defeats static analysis (computed access). */
const loanModelUnanalyzable = `
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  @validate()
  checkDynamic() {
    const key = 'amount' + ''
    return (this as any)[key] > 0 ? null : 'bad'
  }
}
`

/** Same unanalyzable body, rescued by the declared-deps escape hatch. */
const loanModelDeclaredDeps = `
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  @validate({ deps: ['amount'] })
  checkDynamic() {
    const key = 'amount' + ''
    return (this as any)[key] > 0 ? null : 'bad'
  }
}
`

/** Declared deps that MISS a field the body provably reads. */
const loanModelDeclaredMissing = `
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  @validate({ deps: ['amount'] })
  checkCap() {
    return this.amount != null && this.adminCap != null && this.amount > this.adminCap
      ? 'over cap'
      : null
  }
}
`

/** Validator that calls a sibling helper — deps recurse through the call. */
const loanModelSiblingHelper = `
import { ApplicationRecord, model, validate } from 'active-drizzle'

@model('loans')
export class Loan extends ApplicationRecord {
  @validate()
  checkWithHelper() {
    return this.capExceeded() ? 'amount exceeds the admin cap' : null
  }

  capExceeded() {
    return this.amount != null && this.adminCap != null && this.amount > this.adminCap
  }
}
`

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
    crudConfig: {
      create: { permit },
      update: { permit },
    },
  } as CtrlMeta
}

function reactFileFor(
  modelSource: string,
  controllers: CtrlMeta[],
): Record<string, string> {
  const project = createTestProject({
    schema: loansSchema,
    models: { 'Loan.model.ts': modelSource },
  })
  const projectMeta: ProjectMeta = {
    schema: project.extractSchema(),
    models: [project.extractModel('Loan.model.ts')],
  }
  const ctrlProject: CtrlProjectMeta = { controllers }
  const files = generateReactHooks(ctrlProject, projectMeta, '/out')
  return Object.fromEntries(files.map(f => [f.filePath, f.content]))
}

// ── 1. Extractor E2E ─────────────────────────────────────────────────────────

describe('extractor wires @validate deps onto meta', () => {
  it('infers deps from a clean multi-field body', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelClean },
    })
    const meta = project.extractModel('Loan.model.ts')
    const method = meta.instanceMethods.find(m => m.name === 'checkCap')!

    expect(method.isValidation).toBe(true)
    expect(method.validationDeps).toEqual(['adminCap', 'amount']) // sorted
    expect(method.validationDepsSource).toBe('inferred')
    expect(method.validationDepsError).toBeUndefined()
  })

  it('refuses an unanalyzable body with a validationDepsError', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelUnanalyzable },
    })
    const method = project
      .extractModel('Loan.model.ts')
      .instanceMethods.find(m => m.name === 'checkDynamic')!

    expect(method.validationDeps).toBeUndefined()
    expect(method.validationDepsError).toMatch(/can't infer deps/)
  })

  it('accepts declared deps as the escape hatch for unanalyzable bodies', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelDeclaredDeps },
    })
    const method = project
      .extractModel('Loan.model.ts')
      .instanceMethods.find(m => m.name === 'checkDynamic')!

    expect(method.validationDeps).toEqual(['amount'])
    expect(method.validationDepsSource).toBe('declared')
    expect(method.validationDepsError).toBeUndefined()
  })

  it('rejects declared deps that miss an inferred field (declared ⊉ inferred)', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelDeclaredMissing },
    })
    const method = project
      .extractModel('Loan.model.ts')
      .instanceMethods.find(m => m.name === 'checkCap')!

    expect(method.validationDeps).toBeUndefined()
    expect(method.validationDepsError).toMatch(/missing inferred fields.*adminCap/)
  })

  it('recurses through sibling helper calls when inferring', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelSiblingHelper },
    })
    const method = project
      .extractModel('Loan.model.ts')
      .instanceMethods.find(m => m.name === 'checkWithHelper')!

    expect(method.validationDeps).toEqual(['adminCap', 'amount'])
    expect(method.validationDepsError).toBeUndefined()
  })
})

// ── 2. Validator E2E — unprovable deps fail the build ────────────────────────

describe('validator turns unprovable deps into hard errors', () => {
  it('an unanalyzable @validate body is a build error', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelUnanalyzable },
    })
    const diagnostics = project.validate()
    const depErrors = diagnostics.filter(
      d => d.severity === 'error' && /can't infer deps/.test(d.message),
    )
    expect(depErrors.length).toBeGreaterThan(0)
  })

  it('declared-deps-missing-inferred-field is a build error', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelDeclaredMissing },
    })
    const diagnostics = project.validate()
    expect(
      diagnostics.some(d => d.severity === 'error' && /missing inferred fields/.test(d.message)),
    ).toBe(true)
  })

  it('a clean model produces no dep diagnostics', () => {
    const project = createTestProject({
      schema: loansSchema,
      models: { 'Loan.model.ts': loanModelClean },
    })
    const diagnostics = project.validate()
    expect(diagnostics.filter(d => /deps/.test(d.message))).toHaveLength(0)
  })
})

// ── 3. Generator E2E — ship by projection, fail-closed ───────────────────────

describe('controller Clients ship validators by projection', () => {
  it('borrower Client (permit: amount) OMITS the cap check; admin Client includes it', () => {
    const files = reactFileFor(loanModelClean, [
      makeCtrl('BorrowerLoanController', ['amount']),
      makeCtrl('AdminLoanController', ['amount', 'adminCap']),
    ])

    const borrower = Object.entries(files).find(([p]) => p.toLowerCase().includes('borrower'))![1]
    const admin = Object.entries(files).find(([p]) => p.toLowerCase().includes('admin'))![1]

    // Admin projection covers {amount, adminCap} → validator ships
    expect(admin).toContain('amount exceeds the admin cap')
    // Borrower projection lacks adminCap → validator must NOT ship
    expect(borrower).not.toContain('amount exceeds the admin cap')
  })

  it('declared-deps validator ships when the declared deps fit the projection', () => {
    const files = reactFileFor(loanModelDeclaredDeps, [
      makeCtrl('BorrowerLoanController', ['amount']),
    ])
    // Validator bodies are inlined anonymously — assert on the body content
    const borrower = Object.entries(files).find(([p]) => p.toLowerCase().includes('borrower'))![1]
    expect(borrower).toContain(`'amount' + ''`)
  })

  it('expose is the ceiling: a validator reading a VIEW-ONLY field still ships when expose covers it', () => {
    // Decision 1a.1 — data availability, not editability, is the boundary.
    // Borrower can only EDIT amount, but can SEE adminCap (view) → the cap
    // rule runs client-side because the draft carries both fields.
    const ctrl = makeCtrl('BorrowerLoanController', ['amount'])
    ;(ctrl as any).crudConfig.get = { expose: ['id', 'amount', 'adminCap'], abilities: true }
    const files = reactFileFor(loanModelClean, [ctrl])
    const borrower = Object.entries(files).find(([p]) => p.toLowerCase().includes('borrower'))![1]
    expect(borrower).toContain('amount exceeds the admin cap')
  })

  it('sibling-helper validator NEVER ships to a controller Client (method unavailable there)', () => {
    // Even the admin projection covers the deps — but the emitted Client has no
    // capExceeded() method, so shipping the body would throw in the browser.
    // Fail-closed: server-side only.
    const files = reactFileFor(loanModelSiblingHelper, [
      makeCtrl('AdminLoanController', ['amount', 'adminCap']),
    ])
    const admin = Object.entries(files).find(([p]) => p.toLowerCase().includes('admin'))![1]
    expect(admin).not.toContain('capExceeded')
    expect(admin).not.toContain('amount exceeds the admin cap')
  })
})
