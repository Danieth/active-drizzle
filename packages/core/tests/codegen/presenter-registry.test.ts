/**
 * Slice 2: _registry.gen — folder placement IS the declaration; defaults
 * by export-name convention; types beside runtime from ONE scan; the
 * teaching error when a kind has no resolvable default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Project } from 'ts-morph'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanKindModules, generatePresenterRegistryFromDir } from '../../src/codegen/presenter-registry.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'preg-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function kindFile(kind: string, src: string): { kind: string; filePath: string } {
  const d = join(dir, 'attr', kind)
  mkdirSync(d, { recursive: true })
  const filePath = join(d, 'index.tsx')
  writeFileSync(filePath, src)
  return { kind, filePath }
}

const MONEY = `
export function MoneyInput(p: any) { return null }
export function MoneyCompact(p: any) { return null }
export function MoneyText(p: any) { return null }
const helper = 1
export const notAComponent = 2
`
const BOOL = `
export const Switch = (p: any) => null
export function BoolText(p: any) { return null }
`

describe('the generated registry', () => {
  it('registers EVERY exported component under the folder kind; variants first-class', () => {
    const files = [kindFile('money', MONEY), kindFile('boolean', BOOL)]
    const project = new Project({ useInMemoryFileSystem: false })
    const { content, report } = generatePresenterRegistryFromDir(project, dir, files)

    expect(content).toContain(`registerPresenter('moneyInput', { kind: 'money', component: MoneyInput as any })`)
    expect(content).toContain(`registerPresenter('moneyCompact', { kind: 'money'`)   // variant registered too
    expect(content).not.toContain('notAComponent')                                    // lowercase export skipped
    // discrete kind → commit:'change' at birth
    expect(content).toContain(`registerPresenter('switch', { kind: 'boolean', commit: 'change'`)
    // defaults by convention: first *Input → edit, first *Text → view
    expect(content).toContain(`'money': { edit: 'moneyInput', view: 'moneyText' }`)
    expect(content).toContain(`'boolean': { edit: 'switch', view: 'boolText' }`)
    // the compile gate emitted from the SAME scan
    expect(content).toContain(`moneyCompact: 'money'`)
    expect(content).toContain(`switch: 'boolean'`)
    expect(report).toContain('5 presenters across 2 kinds')
  })

  it('explicit `defaults` export overrides the convention by name', () => {
    const files = [kindFile('money', MONEY + `\nexport const defaults = { edit: 'MoneyCompact' }\n`)]
    const project = new Project()
    const { content } = generatePresenterRegistryFromDir(project, dir, files)
    expect(content).toContain(`'money': { edit: 'moneyCompact', view: 'moneyText' }`)
  })

  it('a kind with NO resolvable default is a teaching error listing exports', () => {
    const files = [kindFile('weird', `export function Thing(p: any) { return null }`)]
    const project = new Project()
    expect(() => generatePresenterRegistryFromDir(project, dir, files))
      .toThrow(/attr\/weird[\s\S]*Exports found: Thing[\s\S]*\*Input\/\*Editor/)
  })

  it('scan reads defaults + components without executing app code', () => {
    const files = [kindFile('money', MONEY)]
    const project = new Project()
    const scans = scanKindModules(project, files)
    expect(scans[0]!.components).toEqual(['MoneyInput', 'MoneyCompact', 'MoneyText'])
  })
})
