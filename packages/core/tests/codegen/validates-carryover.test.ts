/**
 * Validates.* carryover to generated clients + shippability analysis.
 *
 * The contract:
 *   - Validators built from Validates.* ship to clients, with the import
 *     emitted precisely when used
 *   - Validators referencing anything ELSE foreign (app helpers) stay
 *     server-only — graceful degradation with a build WARNING, never a
 *     browser ReferenceError
 *   - Client _run passes (value, draft, field) inside try/catch, so a
 *     record-gate touching an unpermitted field degrades instead of crashing
 *   - Validates.email/url/uuid refine the field's kind for presenters
 */

import { describe, it, expect } from 'vitest'
import { createTestProject } from '../helpers/index.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

const usersSchema = `
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email'),
  website: text('website'),
  bio: text('bio'),
  age: integer('age'),
})
`

const userModel = `
import { ApplicationRecord, model, Attr, Validates } from 'active-drizzle'
import { customCheck } from '../helpers/custom.js'

@model('users')
export class User extends ApplicationRecord {
  static email = Attr.string({
    validates: [Validates.presence(), Validates.email()],
  })
  static website = Attr.string({ validates: Validates.url() })
  static age = Attr.integer({
    validates: Validates.numericality({ greaterThan: 0, if: (r: any) => r.isAdult() }),
  })
  static bio = Attr.string({
    validates: (v: any) => customCheck(v),   // app helper — NOT shippable
  })
}
`

function extract(modelSource = userModel) {
  const project = createTestProject({
    schema: usersSchema,
    models: { 'User.model.ts': modelSource },
  })
  return {
    project,
    meta: project.extractModel('User.model.ts'),
  }
}

// ── Analysis ─────────────────────────────────────────────────────────────────

describe('shippability analysis', () => {
  it('Validates-only validators are shippable and flagged usesValidates', () => {
    const { meta } = extract()
    expect(meta.propertyValidationAnalysis.email).toEqual({ usesValidates: true, foreignRefs: [] })
    expect(meta.propertyValidationAnalysis.website).toEqual({ usesValidates: true, foreignRefs: [] })
  })

  it('record-gates in options do not make a validator foreign', () => {
    const { meta } = extract()
    // if: (r) => r.isAdult() — r is a declared param, isAdult is a property name
    expect(meta.propertyValidationAnalysis.age!.foreignRefs).toEqual([])
  })

  it('app helpers are foreign — the validator stays server-only', () => {
    const { meta } = extract()
    expect(meta.propertyValidationAnalysis.bio!.foreignRefs).toEqual(['customCheck'])
  })

  it('foreign refs produce a build WARNING naming the culprit', () => {
    const { project } = extract()
    const diagnostics = project.validate()
    expect(
      diagnostics.some(d => d.severity === 'warning' && /'customCheck'.*server-only/.test(d.message)),
    ).toBe(true)
  })

  it('pure inline validators are shippable with no analysis noise', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('users')
export class User extends ApplicationRecord {
  static bio = Attr.string({ validates: (v: any) => (v && v.length > 500 ? 'too long' : null) })
}
`
    const { meta } = extract(src)
    expect(meta.propertyValidationAnalysis.bio).toEqual({ usesValidates: false, foreignRefs: [] })
  })
})

// ── Semantic kinds ───────────────────────────────────────────────────────────

describe('semantic kinds from Validates', () => {
  it('email/url refine fieldMeta.semantic', () => {
    const { meta } = extract()
    expect(meta.fieldMeta.email!.semantic).toBe('email')
    expect(meta.fieldMeta.website!.semantic).toBe('url')
    expect(meta.fieldMeta.age!.semantic).toBeNull()
  })
})

// ── Generated output ─────────────────────────────────────────────────────────

function generateController(modelSource = userModel): string {
  const project = createTestProject({
    schema: usersSchema,
    models: { 'User.model.ts': modelSource },
  })
  const projectMeta: ProjectMeta = {
    schema: project.extractSchema(),
    models: [project.extractModel('User.model.ts')],
  }
  const ctrl: CtrlMeta = {
    filePath: '/src/User.ctrl.ts',
    className: 'UserController',
    basePath: '/users',
    scopes: [],
    kind: 'crud',
    modelClass: 'User',
    mutations: [],
    actions: [],
    crudConfig: {
      get: { expose: ['id', 'email', 'website', 'bio', 'age'], abilities: true },
      update: { permit: ['email', 'website', 'bio', 'age'] },
      create: { permit: ['email', 'website', 'bio', 'age'] },
    },
  } as CtrlMeta
  const files = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
  return files.find(f => f.filePath.includes('user.gen'))!.content
}

describe('controller Client emission', () => {
  it('emits the Validates import exactly when shipped validators use it', () => {
    const out = generateController()
    expect(out).toMatch(/import \{ .*Validates.* \} from '@active-drizzle\/react'/)
    expect(out).toContain('Validates.email()')
  })

  it('foreign-ref validators are NOT emitted (customCheck never reaches the client)', () => {
    const out = generateController()
    expect(out).not.toContain('customCheck')
  })

  it('_run passes (value, draft, field) inside try/catch — graceful degradation', () => {
    const out = generateController()
    expect(out).toContain('fn(value, this, field)')
    expect(out).toContain('catch')
  })

  it('no Validates usage → no Validates import', () => {
    const src = `
import { ApplicationRecord, model, Attr } from 'active-drizzle'
@model('users')
export class User extends ApplicationRecord {
  static bio = Attr.string({ validates: (v: any) => (v ? null : 'required') })
}
`
    const out = generateController(src)
    expect(out).not.toMatch(/import \{ .*Validates/)
  })

  it('typed handle unions semantic and base kinds — both presenter families legal', () => {
    const out = generateController()
    expect(out).toContain(`email: TypedFieldComponent<'email' | 'string'>`)
    expect(out).toContain(`website: TypedFieldComponent<'url' | 'string'>`)
  })
})

// ── Attachments as first-class form fields ───────────────────────────────────

describe('attachment fields', () => {
  it('attachment meta + typed handle entries are emitted', () => {
    const project = createTestProject({
      schema: usersSchema,
      models: { 'User.model.ts': userModel },
    })
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('User.model.ts')],
    }
    const ctrl: CtrlMeta = {
      filePath: '/src/User.ctrl.ts',
      className: 'UserController',
      basePath: '/users',
      scopes: [],
      kind: 'crud',
      modelClass: 'User',
      mutations: [],
      actions: [],
      attachable: true,
      attachments: [
        { name: 'avatar', kind: 'one', accepts: 'image/*', maxSize: 5242880, access: 'public' },
        { name: 'documents', kind: 'many', accepts: 'application/pdf', maxSize: null as any, access: 'private', max: 5 },
      ],
      crudConfig: {
        get: { expose: ['id', 'email'], abilities: true },
        update: { permit: ['email'] },
        create: { permit: ['email'] },
      },
    } as CtrlMeta
    const files = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
    const out = files.find(f => f.filePath.includes('user.gen'))!.content

    // fieldMeta carries the upload contract
    expect(out).toContain(`avatar: { kind: 'attachmentOne', accepts: 'image/*', maxSize: 5242880, access: 'public' }`)
    expect(out).toContain(`documents: { kind: 'attachmentMany', accepts: 'application/pdf'`)
    // typed handle includes attachment fields
    expect(out).toContain(`avatar: TypedFieldComponent<'attachmentOne'>`)
    expect(out).toContain(`documents: TypedFieldComponent<'attachmentMany'>`)
  })
})
