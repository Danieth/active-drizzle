/**
 * The pipeline end to end on an empty directory: everything scaffolds,
 * all three laws verify, all four generated files emit, the report
 * narrates — and a second run is a no-op on user files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Project } from 'ts-morph'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPresenterPipeline } from '../../src/codegen/presenter-pipeline.js'

const PROJECT: any = {
  schema: { tables: {}, filePath: '/s.ts' },
  models: [{ className: 'Deal', fieldMeta: {
    name: { kind: 'string' }, amount: { kind: 'money' }, active: { kind: 'boolean' },
  } }],
}
const CTRL: any = { controllers: [{
  filePath: '/c.ts', className: 'DealController', basePath: '/deals',
  scopes: [{ field: 'teamId', resource: 'teams', paramName: 'teamId' }],
  kind: 'crud', modelClass: 'Deal', mutations: [], actions: [],
  frontendContext: [{ key: 'userType', type: 'string', owner: 'DealController' }],
}] }

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pline-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the presenter pipeline, empty dir → complete tree', () => {
  it('scaffolds, verifies all three laws, emits all four .gen files, reports', () => {
    const { report, written } = runPresenterPipeline(new Project(), PROJECT, CTRL, dir)
    // scaffolds (LAW 1 by construction) incl. the LAW-3-complete root layout
    expect(existsSync(join(dir, 'attr/money/index.tsx'))).toBe(true)
    expect(existsSync(join(dir, 'attr/boolean/index.tsx'))).toBe(true)
    expect(readFileSync(join(dir, 'context.ts'), 'utf8')).toContain(`consumes: ['label', 'errors', 'dirty', 'state', 'elsewhere']`)
    expect(existsSync(join(dir, 'models/Deal/form.tsx'))).toBe(true)
    // the generated four
    expect(written.sort()).toEqual(['_forms.gen.tsx', '_manifest.gen.json', '_pctx.gen.tsx', '_registry.gen.tsx'])
    const registry = readFileSync(join(dir, '.gen/_registry.gen.tsx'), 'utf8')
    expect(registry).toContain(`registerPresenter('moneyInput'`)
    expect(registry).toContain(`moneyInput: 'money'`)              // types beside runtime
    const formsIdx = readFileSync(join(dir, '.gen/_forms.gen.tsx'), 'utf8')
    expect(formsIdx).toContain('DealControllerForm')               // door resolved via ladder
    const manifest = JSON.parse(readFileSync(join(dir, '.gen/_manifest.gen.json'), 'utf8'))
    expect(manifest.kinds.money.usedBy).toEqual(['Deal.amount'])
    // the report narrates every stage
    expect(report).toMatch(/presenters ✓ 3 kinds/)
    expect(report).toMatch(/layouts    ✓ chrome coverage complete/)
    expect(report).toMatch(/context    ✓ 1 area/)
    expect(report).toMatch(/registry   ✓ 6 presenters, 1 door resolved/)
  })

  it('second run: user files untouched, laws still green (idempotent)', () => {
    runPresenterPipeline(new Project(), PROJECT, CTRL, dir)
    writeFileSync(join(dir, 'attr/money/index.tsx'), readFileSync(join(dir, 'attr/money/index.tsx'), 'utf8') + '\n// MINE\n')
    const second = runPresenterPipeline(new Project(), PROJECT, CTRL, dir)
    expect(readFileSync(join(dir, 'attr/money/index.tsx'), 'utf8')).toContain('// MINE')
    expect(second.report).toMatch(/presenters ✓ 3 kinds covered$/m)   // nothing regenerated
  })

  it('LAW 2 fires through the pipeline: client key colliding with server ctx', () => {
    runPresenterPipeline(new Project(), PROJECT, CTRL, dir)
    const ctx = readFileSync(join(dir, 'context.ts'), 'utf8')
      .replace('export default definePresenterContext({', "export default definePresenterContext({\n  userType: () => 'nope',")
    writeFileSync(join(dir, 'context.ts'), ctx)
    expect(() => runPresenterPipeline(new Project(), PROJECT, CTRL, dir))
      .toThrow(/'userType'[\s\S]*ALREADY server context[\s\S]*DealController/)
  })

  it('the forgotten-field law fires through the pipeline', () => {
    runPresenterPipeline(new Project(), PROJECT, CTRL, dir)
    const form = readFileSync(join(dir, 'models/Deal/form.tsx'), 'utf8')
      .replace(`export const covers = ['name', 'amount', 'active'] as const`,
               `export const covers = ['name', 'amount'] as const`)
    writeFileSync(join(dir, 'models/Deal/form.tsx'), form)
    expect(() => runPresenterPipeline(new Project(), PROJECT, CTRL, dir))
      .toThrow(/'active'[\s\S]*neither covered nor omitted/)
  })
})
