import { describe, it, expect } from 'vitest'
import { defineControllerConcern, type ControllerConcern } from '../../src/concerns/define-controller-concern.js'
import { includeInController, CONTROLLER_CONCERN_META } from '../../src/concerns/include-in-controller.js'
import { BEFORE_META, ACTION_META } from '../../src/metadata.js'
import { Searchable } from '../../src/concerns/builtin/searchable.js'

// ── Basic factory tests ────────────────────────────────────────────────────────

describe('defineControllerConcern', () => {
  it('creates a concern with the correct type marker', () => {
    const concern = defineControllerConcern({ name: 'TestConcern' })
    expect(concern.__type).toBe('controller_concern')
    expect(concern.name).toBe('TestConcern')
  })

  it('stores the definition on the concern object', () => {
    const beforeFn = () => {}
    const concern = defineControllerConcern({
      name: 'MyHookConcern',
      before: [{ method: 'myHook', fn: beforeFn }]
    })
    expect(concern.def.before).toHaveLength(1)
    expect(concern.def.before![0].fn).toBe(beforeFn)
  })
})

// ── @includeInController decorator tests ────────────────────────────────────────

describe('@includeInController', () => {
  it('registers before-hook methods on the class prototype', () => {
    const hookFn = function (this: any) { return 'hooked' }
    const MyConcern = defineControllerConcern({
      name: 'MyConcern',
      before: [{ method: 'doSetup', fn: hookFn }]
    })

    @includeInController(MyConcern)
    class ProductController {}

    const prefix = `__concern_before_MyConcern_doSetup`
    expect(typeof (ProductController.prototype as any)[prefix]).toBe('function')
    expect((ProductController as any)[BEFORE_META]).toBeDefined()
    const entries = (ProductController as any)[BEFORE_META]
    expect(entries.some((e: any) => e.method === prefix)).toBe(true)
  })

  it('injects action routes on the class', () => {
    const actionFn = function (this: any, ctx: any) { return ctx }
    const ActionConcern = defineControllerConcern({
      name: 'ActionConcern',
      actions: [{ method: 'doAction', fn: actionFn, httpMethod: 'GET', path: '/custom' }]
    })

    @includeInController(ActionConcern)
    class UserController {}

    const prefix = `__concern_action_ActionConcern_doAction`
    expect(typeof (UserController.prototype as any)[prefix]).toBe('function')
    expect((UserController as any)[ACTION_META]).toBeDefined()
    const entries = (UserController as any)[ACTION_META]
    expect(entries.some((e: any) => e.method === prefix)).toBe(true)
  })

  it('stores concern metadata on the class', () => {
    const AnotherConcern = defineControllerConcern({ name: 'AnyConcern' })

    @includeInController(AnotherConcern)
    class PostController {}

    const meta = (PostController as any)[CONTROLLER_CONCERN_META]
    expect(meta).toBeDefined()
    expect(meta.concerns.some((c: any) => c.name === 'AnyConcern')).toBe(true)
  })
})

// ── Searchable concern ────────────────────────────────────────────────────────

describe('Searchable controller concern', () => {
  it('has correct name and type', () => {
    expect(Searchable.name).toBe('Searchable')
    expect(Searchable.__type).toBe('controller_concern')
  })

  it('configures with default values', () => {
    const config = Searchable.def.configure?.({})
    expect(config?.fields).toEqual(['title', 'name'])
    expect(config?.paramName).toBe('q')
    expect(config?.minLength).toBe(1)
  })

  it('configures with custom values', () => {
    const config = Searchable.def.configure?.({ fields: ['email', 'phone'], paramName: 'search' })
    expect(config?.fields).toEqual(['email', 'phone'])
    expect(config?.paramName).toBe('search')
  })

  it('injects a before-filter scoped only to "index" action', () => {
    expect(Searchable.def.before).toBeDefined()
    expect(Searchable.def.before![0].only).toEqual(['index'])
  })
})
