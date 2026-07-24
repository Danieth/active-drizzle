/**
 * Folder context.ts — the NO-SHADOW law and the generated injection file.
 */
import { describe, it, expect } from 'vitest'
import {
  validatePresenterContexts, generatePresenterContextFile,
  type PresenterContextFile,
} from '../../src/codegen/presenter-context-generator.js'

const f = (area: string, keys: string[], filePath = `/app/presenters/${area ? area + '/' : ''}context.ts`): PresenterContextFile =>
  ({ filePath, area, keys })

describe('the no-shadow law', () => {
  it('root + disjoint areas pass; SIBLINGS may reuse a key', () => {
    expect(() => validatePresenterContexts(
      [f('', ['density']), f('models/Deal', ['stageColors']), f('models/Loan', ['stageColors'])],
      new Map(),
    )).not.toThrow()
  })

  it('a nested folder redeclaring an ANCESTOR key blows up naming both files', () => {
    expect(() => validatePresenterContexts(
      [f('', ['density']), f('models/Deal', ['density'])],
      new Map(),
    )).toThrow(/density[\s\S]*models\/Deal\/context\.ts SHADOWS[\s\S]*presenters\/context\.ts/)
  })

  it('deep nesting shadows through intermediate folders too', () => {
    expect(() => validatePresenterContexts(
      [f('models', ['palette']), f('models/Deal/forms', ['palette'])],
      new Map(),
    )).toThrow(/SHADOWS/)
  })

  it('a client key colliding with SERVER @frontendContext blows up with the lane rule', () => {
    expect(() => validatePresenterContexts(
      [f('', ['userType'])],
      new Map([['userType', 'AppDoor']]),
    )).toThrow(/'userType'[\s\S]*ALREADY server context[\s\S]*AppDoor[\s\S]*One fact, one lane/)
  })
})

describe('the generated injection file', () => {
  it('root mounts via <AppPresenterContext>; areas export for the registry; root keys REQUIRED', () => {
    const out = generatePresenterContextFile(
      [f('', ['density', 'theme']), f('models/Deal', ['stageColors'])],
      '/app/.gen/presenters/_pctx.gen.tsx',
    )
    expect(out).toContain(`import _ctx0 from '../../presenters/context.js'`)
    expect(out).toContain('PresenterContextProvider map={_ctx0}')
    expect(out).toContain(`'models/Deal': _ctx1`)
    expect(out).toContain(`density: ReturnType<(typeof _ctx0)['density']>`)  // REQUIRED — no '?'
    expect(out).not.toContain('density?:')
  })

  it('no root context.ts → provider is a passthrough, no augmentation', () => {
    const out = generatePresenterContextFile([f('models/Deal', ['x'])], '/app/.gen/presenters/_pctx.gen.tsx')
    expect(out).toContain('<>{children}</>')
    expect(out).not.toContain('declare module')
  })
})
