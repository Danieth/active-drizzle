/**
 * Slice 5: forms/shows scaffolds, the covers/omits laws, and the
 * OUTWARD-walking resolution ladder — static, never a runtime search.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Project } from 'ts-morph'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bulbFieldsOf, scaffoldModelForms, scanFormManifest, validateFormManifest,
  resolveLadder, generateFormsIndex,
} from '../../src/codegen/presenter-forms.js'

const PROJECT: any = {
  schema: { tables: {}, filePath: '/s.ts' },
  models: [{ className: 'Deal', fieldMeta: {
    name: { kind: 'string' }, amount: { kind: 'money' },
    stage: { kind: 'state' }, notes: { kind: 'nested' },
  } }],
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pforms-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('form/show scaffolds', () => {
  it('generates composition + manifest; keeps user files forever', () => {
    const res = scaffoldModelForms(PROJECT, dir, ['Deal'])
    expect(res.created).toContain('models/Deal/form.tsx')
    const form = readFileSync(join(dir, 'models/Deal/form.tsx'), 'utf8')
    expect(form).toContain(`export const covers = ['name', 'amount', 'stage']`)  // nested excluded
    expect(form).toContain('<deal.amount edit />')
    expect(form).toContain('SCAFFOLD — yours now')
    writeFileSync(join(dir, 'models/Deal/form.tsx'), '// MINE')
    const again = scaffoldModelForms(PROJECT, dir, ['Deal'])
    expect(readFileSync(join(dir, 'models/Deal/form.tsx'), 'utf8')).toBe('// MINE')
    expect(again.kept).toContain('models/Deal/form.tsx')
  })
})

describe('the covers/omits laws', () => {
  const FIELDS = ['name', 'amount', 'stage']
  const manifest = (covers: string[], omits: string[] = []) =>
    ({ filePath: '/p/models/Deal/form.tsx', covers, omits })

  it('a FORGOTTEN field explodes with both fixes; explicit omit passes', () => {
    expect(() => validateFormManifest(manifest(['name', 'amount']), FIELDS, 'form'))
      .toThrow(/'stage'[\s\S]*neither covered nor omitted[\s\S]*covers[\s\S]*omits/)
    expect(() => validateFormManifest(manifest(['name', 'amount'], ['stage']), FIELDS, 'form'))
      .not.toThrow()
  })

  it('a typo teaches with did-you-mean; covers∩omits explodes; shows may subset', () => {
    expect(() => validateFormManifest(manifest(['naem', 'amount', 'stage']), FIELDS, 'form'))
      .toThrow(/'naem' is not a field[\s\S]*did you mean 'name'/)
    expect(() => validateFormManifest(manifest(['name', 'amount', 'stage'], ['stage']), FIELDS, 'form'))
      .toThrow(/BOTH covers and omits/)
    expect(() => validateFormManifest(manifest(['name']), FIELDS, 'show')).not.toThrow()
  })

  it('scanFormManifest reads the exported arrays through `as const`', () => {
    scaffoldModelForms(PROJECT, dir, ['Deal'])
    const m = scanFormManifest(new Project(), join(dir, 'models/Deal/form.tsx'))
    expect(m.covers).toEqual(['name', 'amount', 'stage'])
    expect(m.omits).toEqual([])
    expect(() => validateFormManifest(m, bulbFieldsOf(PROJECT, 'Deal'), 'form')).not.toThrow()
  })
})

describe('the resolution ladder — outward walk, statically resolved', () => {
  it('most-nested door dir wins → parent door → model → null', () => {
    const mk = (p: string) => { mkdirSync(join(dir, dirnameOf(p)), { recursive: true }); writeFileSync(join(dir, p), '// x') }
    const dirnameOf = (p: string) => p.split('/').slice(0, -1).join('/')

    mk('models/Deal/form.tsx')
    expect(resolveLadder(dir, ['Teams', 'Deals'], 'Deal', 'form.tsx')).toContain('models/Deal/form.tsx')
    mk('controllers/Teams/form.tsx')
    expect(resolveLadder(dir, ['Teams', 'Deals'], 'Deal', 'form.tsx')).toContain('controllers/Teams/form.tsx')
    mk('controllers/Teams/Deals/form.tsx')
    expect(resolveLadder(dir, ['Teams', 'Deals'], 'Deal', 'form.tsx')).toContain('controllers/Teams/Deals/form.tsx')
    expect(resolveLadder(dir, ['Teams', 'Deals'], 'Deal', 'show.tsx')).toBeNull()
  })

  it('_forms.gen.tsx exports the STATIC resolution per door, deduping imports', () => {
    scaffoldModelForms(PROJECT, dir, ['Deal'])
    const out = generateFormsIndex(
      [
        { controller: 'DealController', segments: ['Deals'], model: 'Deal' },
        { controller: 'AdminDealController', segments: ['Admin', 'Deals'], model: 'Deal' },
      ],
      dir,
    )
    expect(out).toContain(`export const DealControllerForm = _c0`)
    expect(out).toContain(`export const AdminDealControllerForm = _c0`)   // same file → one import
    expect(out).toContain(`export const DealControllerShow`)
    expect(out).toContain(`models/Deal/form.js'`)
  })
})
