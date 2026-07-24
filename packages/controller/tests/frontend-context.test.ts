/**
 * @frontendContext — the fourth passenger on the envelope.
 *
 * Server-computed presenter context: declared ONCE on the door (or a
 * concern base class), computed once per request after @before hooks,
 * riding every envelope and index response beside abilities/can/version.
 * Keys never shadow — a duplicate is a teaching error, not an override.
 */
import { describe, it, expect } from 'vitest'
import { controller, crud, frontendContext } from '../src/decorators.js'
import { collectFrontendContext } from '../src/metadata.js'
import { buildRecordEnvelope, computeFrontendContext } from '../src/crud-handlers.js'

const RECORD = {
  id: 1, name: 'n',
  toJSON({ only }: { only: string[] }) {
    const o: any = {}
    for (const k of only) if (k in this) o[k] = (this as any)[k]
    return o
  },
}
const CONFIG: any = { get: { expose: ['name'], abilities: true }, update: { permit: ['name'] } }

describe('declaration + inheritance', () => {
  it('a concern (base class) contributes keys; the child ADDS its own', () => {
    @frontendContext({ userType: (_c, ctrl) => (ctrl.state.user.admin ? 'admin' : 'member') })
    class TeamScoped {}

    @controller('/deals')
    @frontendContext({ plan: (_c, ctrl) => ctrl.state.org.plan })
    class DealController extends TeamScoped {}

    const map = collectFrontendContext(DealController)
    expect(Object.keys(map).sort()).toEqual(['plan', 'userType'])
  })

  it('KEY SHADOWING BLOWS UP — child redeclaring a parent key names both classes', () => {
    @frontendContext({ userType: () => 'member' })
    class Base {}
    @frontendContext({ userType: () => 'admin' })
    class Child extends Base {}
    expect(() => collectFrontendContext(Child))
      .toThrow(/userType.*BOTH Base and Child/s)
  })

  it('two decorators on ONE class blow up at decoration time', () => {
    expect(() => {
      @frontendContext({ b: () => 2 })
      @frontendContext({ a: () => 1 })
      class Twice {}
      void Twice
    }).toThrow(/@frontendContext appears twice on Twice/)
  })
})

describe('computation — once per request, loud on failure', () => {
  @controller('/loans')
  @crud(class Loan {} as any, CONFIG)
  @frontendContext({
    userType: (_ctx: any, ctrl: any) => (ctrl.state.user.admin ? 'admin' : 'member'),
    orgName: (_ctx: any, ctrl: any) => ctrl.state.org.name,
  })
  class LoanController {}

  const ctrlFor = (state: any) =>
    Object.assign(Object.create(LoanController.prototype), { state })

  it('runs each function with (ctx, ctrl) and returns the bag', () => {
    const ctrl = ctrlFor({ user: { admin: true }, org: { name: 'Acme' } })
    expect(computeFrontendContext(ctrl, { userId: 9 }))
      .toEqual({ userType: 'admin', orgName: 'Acme' })
  })

  it('a door with NO declaration yields undefined — the envelope stays lean', () => {
    @controller('/plain')
    class PlainController {}
    const ctrl = Object.create(PlainController.prototype)
    expect(computeFrontendContext(ctrl, {})).toBeUndefined()
  })

  it('a throwing entry fails LOUD, naming the key, controller, and the likely fix', () => {
    const ctrl = ctrlFor({})   // state.user missing — the classic @before gap
    expect(() => computeFrontendContext(ctrl, {}))
      .toThrow(/@frontendContext 'userType' on LoanController threw[\s\S]*@before hooks/)
  })

  it('the envelope carries ctx beside abilities/can', () => {
    const ctrl = ctrlFor({ user: { admin: false }, org: { name: 'Acme' } })
    const env = buildRecordEnvelope(RECORD, { name: 'Loan' } as any, CONFIG, {}, ctrl)
    expect(env.abilities).toEqual({ name: 'edit' })
    expect(env.ctx).toEqual({ userType: 'member', orgName: 'Acme' })
  })

  it('an undeclared door ships NO ctx key at all (zero wire bytes)', () => {
    @controller('/bare')
    @crud(class Bare {} as any, CONFIG)
    class BareController {}
    const ctrl = Object.assign(Object.create(BareController.prototype), { state: {} })
    const env = buildRecordEnvelope(RECORD, { name: 'Bare' } as any, CONFIG, {}, ctrl)
    expect('ctx' in env).toBe(false)
  })
})
