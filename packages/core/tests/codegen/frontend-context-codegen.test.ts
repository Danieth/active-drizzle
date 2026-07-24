/**
 * @frontendContext, the TYPED half: the extractor derives each key's REAL
 * return type from the checker (concern inheritance included), bad choices
 * die at regen with the fix in the message, and the react generator emits
 * ONE merged AdFrontendCtx augmentation — `ctx.userType` autocompletes as
 * 'admin' | 'member' in every presenter, before any request is ever made.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractControllers } from '../../src/codegen/controller-extractor.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlProjectMeta } from '../../src/codegen/controller-types.js'

function extract(src: string) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: false } })
  project.createSourceFile('/src/deal.ctrl.ts', src)
  return extractControllers(project, ['/src/deal.ctrl.ts'])
}

describe('extractor: checker-derived types, concern inheritance included', () => {
  it('literal unions type themselves; a concern contributes typed keys to the child', () => {
    const meta = extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any

      @frontendContext({ userType: (ctx: any, ctrl: any) => ctrl.state.user.admin ? 'admin' : 'member' })
      class TeamScoped {}

      @controller('/deals')
      @frontendContext({
        plan: (_c: any, ctrl: any) => String(ctrl.state.org.plan),
        seatCount: () => 3,
      })
      class DealController extends TeamScoped {}
    `)
    const fc = meta.controllers.find(c => c.className === 'DealController')!.frontendContext!
    const byKey = Object.fromEntries(fc.map(e => [e.key, e]))
    expect(byKey.userType!.type).toBe('"admin" | "member"')
    expect(byKey.userType!.owner).toBe('TeamScoped')          // inherited, attributed
    expect(byKey.plan!.type).toBe('string')
    expect(byKey.seatCount!.type).toBe('number')               // widened — plain data
  })

  it('ASYNC blows up with the @before redirection', () => {
    expect(() => extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any
      @controller()
      @frontendContext({ userType: async () => 'admin' })
      class C {}
    `)).toThrow(/'userType' on C is ASYNC[\s\S]*@before hook/)
  })

  it('a FUNCTION value blows up; a Date blows up with the serialize fix', () => {
    expect(() => extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any
      @controller()
      @frontendContext({ fmt: () => (v: number) => String(v) })
      class C {}
    `)).toThrow(/'fmt' on C returns a FUNCTION/)
    expect(() => extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any
      @controller()
      @frontendContext({ since: () => new Date() })
      class C {}
    `)).toThrow(/'since' on C returns a Date[\s\S]*toISOString/)
  })

  it('a class-instance return names the invisible type', () => {
    expect(() => extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any
      class OrgSettings { theme!: string }
      @controller()
      @frontendContext({ settings: () => new OrgSettings() })
      class C {}
    `)).toThrow(/client can't see the type 'OrgSettings'/)
  })

  it('a non-function value blows up (constants cannot ride)', () => {
    expect(() => extract(`
      declare function frontendContext(m: any): any
      declare function controller(p?: string): any
      @controller()
      @frontendContext({ version: 7 })
      class C {}
    `)).toThrow(/'version' on C is not a function/)
  })
})

describe('generator: ONE merged augmentation, cross-door conflicts teach', () => {
  const ctrl = (className: string, fc: Array<{ key: string; type: string; owner: string }>): any => ({
    filePath: `/src/${className}.ctrl.ts`, className, basePath: '/x',
    scopes: [], kind: 'plain', mutations: [], actions: [], frontendContext: fc,
  })

  it('emits _ctx.gen.ts with optional keys, sorted, owners documented', () => {
    const project: CtrlProjectMeta = { controllers: [
      ctrl('DealController', [
        { key: 'userType', type: `"admin" | "member"`, owner: 'TeamScoped' },
        { key: 'plan', type: 'string', owner: 'DealController' },
      ]),
      ctrl('InvoiceController', [
        { key: 'userType', type: `"admin" | "member"`, owner: 'TeamScoped' },   // same fact, same type — merges
      ]),
    ] }
    const files = generateReactHooks(project, null, '/out')
    const ctx = files.find(f => f.filePath.endsWith('_ctx.gen.ts'))!
    expect(ctx).toBeDefined()
    expect(ctx.content).toContain(`declare module '@active-drizzle/react'`)
    expect(ctx.content).toContain(`userType?: "admin" | "member"`)
    expect(ctx.content).toContain(`plan?: string`)
    expect(ctx.content).toMatch(/From @frontendContext on TeamScoped/)
  })

  it('SAME key, DIFFERENT types across doors → teaching error naming both', () => {
    const project: CtrlProjectMeta = { controllers: [
      ctrl('DealController', [{ key: 'plan', type: 'string', owner: 'DealController' }]),
      ctrl('InvoiceController', [{ key: 'plan', type: 'number', owner: 'InvoiceController' }]),
    ] }
    expect(() => generateReactHooks(project, null, '/out'))
      .toThrow(/'plan' has TWO types[\s\S]*DealController[\s\S]*InvoiceController[\s\S]*concern/)
  })

  it('no declarations anywhere → no _ctx.gen.ts at all', () => {
    const project: CtrlProjectMeta = { controllers: [ctrl('PlainController', [])] }
    const files = generateReactHooks(project, null, '/out')
    expect(files.some(f => f.filePath.endsWith('_ctx.gen.ts'))).toBe(false)
  })
})
