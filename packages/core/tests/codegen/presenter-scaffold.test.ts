/**
 * Slice 1 of the presenter tree: LAW 1 by construction — every kind in
 * use gets a folder; existing files are NEVER touched; deletion while
 * in use comes back on the next run; the report names its work.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectKindsInUse, scaffoldPresenterTree } from '../../src/codegen/presenter-scaffold.js'

const PROJECT: any = {
  schema: { tables: {}, filePath: '/s.ts' },
  models: [
    { className: 'Deal', fieldMeta: {
      amount: { kind: 'money' }, name: { kind: 'string' },
      stage: { kind: 'state' }, notes: { kind: 'nested' },     // nested = not a bulb
      contact: { kind: 'string', semantic: 'email' },          // semantic wins
    } },
    { className: 'Invoice', fieldMeta: { total: { kind: 'money' } } },
  ],
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ptree-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('collectKindsInUse', () => {
  it('unions kinds across models, skips nested, honors semantic, names users', () => {
    const kinds = collectKindsInUse(PROJECT)
    expect(kinds.map(k => k.kind)).toEqual(['email', 'money', 'state', 'string'])
    const money = kinds.find(k => k.kind === 'money')!
    expect(money.usedBy).toEqual([
      { model: 'Deal', field: 'amount' },
      { model: 'Invoice', field: 'total' },
    ])
  })
})

describe('scaffoldPresenterTree — generate-then-keep', () => {
  it('creates a typed, self-registering bulb per kind + the root context.ts', () => {
    const res = scaffoldPresenterTree(PROJECT, dir)
    expect(existsSync(join(dir, 'attr/money/index.tsx'))).toBe(true)
    expect(existsSync(join(dir, 'context.ts'))).toBe(true)
    const money = readFileSync(join(dir, 'attr/money/index.tsx'), 'utf8')
    expect(money).toContain(`PresenterPropsFor<'money'>`)      // typed by kind
    expect(money).toContain('SCAFFOLD — yours now')            // ownership handoff
    expect(money).toContain('LAW 1')                            // teaches WHY it exists
    expect(res.report).toContain('4 kinds covered')
    expect(res.report).toMatch(/attr\/money.*Deal\.amount.*Invoice\.total/)
  })

  it('NEVER touches an existing file — user edits survive every rerun', () => {
    scaffoldPresenterTree(PROJECT, dir)
    writeFileSync(join(dir, 'attr/money/index.tsx'), '// MINE now')
    const res = scaffoldPresenterTree(PROJECT, dir)
    expect(readFileSync(join(dir, 'attr/money/index.tsx'), 'utf8')).toBe('// MINE now')
    expect(res.kept).toContain('money')
    expect(res.created.some(c => c.includes('money'))).toBe(false)
  })

  it('LAW 1 enforcement is REGENERATION: a deleted in-use folder comes back', () => {
    scaffoldPresenterTree(PROJECT, dir)
    rmSync(join(dir, 'attr/money'), { recursive: true })
    const res = scaffoldPresenterTree(PROJECT, dir)
    expect(existsSync(join(dir, 'attr/money/index.tsx'))).toBe(true)
    expect(res.created.some(c => c.includes('attr/money'))).toBe(true)
  })
})
