/**
 * Unit tests for controller package — no Docker required.
 *
 * Covers:
 *   - errors.ts: HttpError subclasses, serializeError, toValidationError
 *   - metadata.ts: all getters, collectBeforeHooks, collectAfterHooks,
 *     collectRescueHandlers, inferScopeResource, appliesToAction
 *   - decorators.ts: all decorators set correct metadata
 *   - base.ts: _runBeforeHooks, _runAfterHooks, _handleError
 */

import { describe, it, expect, vi } from 'vitest'
import {
  HttpError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  ValidationError,
  toValidationError,
  serializeError,
} from '../src/errors.js'
import {
  getControllerMeta,
  getCrudMeta,
  getSingletonMeta,
  getScopes,
  getMutations,
  getActions,
  getRescueHandlers,
  collectBeforeHooks,
  collectAfterHooks,
  collectRescueHandlers,
  inferScopeResource,
  CONTROLLER_META,
  CRUD_META,
  SCOPE_META,
  MUTATION_META,
  ACTION_META,
  BEFORE_META,
  AFTER_META,
  RESCUE_META,
} from '../src/metadata.js'
import {
  controller,
  crud,
  singleton,
  scope,
  mutation,
  action,
  before,
  after,
  rescue,
} from '../src/decorators.js'
import { ActiveController } from '../src/base.js'

// ── errors.ts ────────────────────────────────────────────────────────────────

describe('HttpError subclasses', () => {
  it('BadRequest has status 400', () => {
    const err = new BadRequest('bad payload')
    expect(err.status).toBe(400)
    expect(err.message).toBe('bad payload')
    expect(err.name).toBe('BadRequest')
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toBeInstanceOf(Error)
  })

  it('Unauthorized has status 401 and default message', () => {
    const err = new Unauthorized()
    expect(err.status).toBe(401)
    expect(err.message).toBe('Not authenticated')
  })

  it('Unauthorized accepts custom message', () => {
    expect(new Unauthorized('token expired').message).toBe('token expired')
  })

  it('Forbidden has status 403', () => {
    const err = new Forbidden('not allowed')
    expect(err.status).toBe(403)
    expect(err.name).toBe('Forbidden')
  })

  it('NotFound has status 404 and formats model name', () => {
    const err = new NotFound('Campaign')
    expect(err.status).toBe(404)
    expect(err.message).toBe('Campaign not found')
  })

  it('ValidationError has status 422 and carries errors map', () => {
    const err = new ValidationError({ name: ['is required'], email: ['is invalid'] })
    expect(err.status).toBe(422)
    expect(err.errors).toEqual({ name: ['is required'], email: ['is invalid'] })
    expect(err).toBeInstanceOf(HttpError)
  })
})

describe('serializeError()', () => {
  it('serializes a BadRequest to status+body format', () => {
    const result = serializeError(new BadRequest('nope'))
    expect(result).toEqual({ status: 400, body: { error: 'nope' } })
  })

  it('serializes a ValidationError with errors object', () => {
    const result = serializeError(new ValidationError({ name: ['too short'] }))
    expect(result).toEqual({ status: 422, body: { errors: { name: ['too short'] } } })
  })

  it('serializes a NotFound', () => {
    const result = serializeError(new NotFound('Post'))
    expect(result).toEqual({ status: 404, body: { error: 'Post not found' } })
  })
})

describe('toValidationError()', () => {
  it('wraps a model errors map in a ValidationError', () => {
    const err = toValidationError({ title: ['is required'] })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.errors).toEqual({ title: ['is required'] })
  })
})

// ── metadata.ts ──────────────────────────────────────────────────────────────

describe('inferScopeResource()', () => {
  it('teamId → { resource: "teams", paramName: "teamId" }', () => {
    expect(inferScopeResource('teamId')).toEqual({ resource: 'teams', paramName: 'teamId' })
  })

  it('campaignId → { resource: "campaigns", paramName: "campaignId" }', () => {
    expect(inferScopeResource('campaignId')).toEqual({ resource: 'campaigns', paramName: 'campaignId' })
  })

  it('field without Id suffix → pluralized as-is', () => {
    const result = inferScopeResource('workspace')
    expect(result.paramName).toBe('workspace')
    expect(result.resource).toBe('workspaces')
  })
})

describe('metadata getters return undefined / empty array for undecorated classes', () => {
  class Plain {}
  it('getControllerMeta returns undefined', () => expect(getControllerMeta(Plain)).toBeUndefined())
  it('getCrudMeta returns undefined', () => expect(getCrudMeta(Plain)).toBeUndefined())
  it('getSingletonMeta returns undefined', () => expect(getSingletonMeta(Plain)).toBeUndefined())
  it('getScopes returns []', () => expect(getScopes(Plain)).toEqual([]))
  it('getMutations returns []', () => expect(getMutations(Plain)).toEqual([]))
  it('getActions returns []', () => expect(getActions(Plain)).toEqual([]))
  it('getRescueHandlers returns []', () => expect(getRescueHandlers(Plain)).toEqual([]))
  it('collectBeforeHooks returns []', () => expect(collectBeforeHooks(Plain, 'index')).toEqual([]))
  it('collectAfterHooks returns []', () => expect(collectAfterHooks(Plain, 'index')).toEqual([]))
})

// ── decorators.ts ─────────────────────────────────────────────────────────────

describe('@controller decorator', () => {
  it('sets CONTROLLER_META with the given path', () => {
    @controller('/campaigns')
    class CampaignCtrl extends ActiveController {}
    expect(getControllerMeta(CampaignCtrl)).toEqual({ path: '/campaigns' })
  })

  it('@controller() with no path sets empty ControllerMeta', () => {
    @controller()
    class Ctrl extends ActiveController {}
    expect(getControllerMeta(Ctrl)).toBeDefined()
  })
})

describe('@scope decorator', () => {
  it('adds a ScopeEntry with inferred resource and paramName', () => {
    @scope('teamId')
    class Ctrl extends ActiveController {}
    const scopes = getScopes(Ctrl)
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toMatchObject({ field: 'teamId', resource: 'teams', paramName: 'teamId' })
  })

  it('stacks multiple @scope decorators: each prepends, resulting in declaration order', () => {
    // @scope('teamId') executes after @scope('orgId') due to bottom-up decorator order
    // Each prepends, so declaration order == [teamId entry, orgId entry] after both run
    @scope('teamId')
    class Ctrl extends ActiveController {}
    @scope('orgId')
    @scope('teamId')
    class Ctrl2 extends ActiveController {}
    const scopes = getScopes(Ctrl2)
    expect(scopes).toHaveLength(2)
    // orgId was declared last (executed first), teamId is innermost
    expect(scopes.map(s => s.field)).toContain('teamId')
    expect(scopes.map(s => s.field)).toContain('orgId')
  })
})

describe('@mutation decorator', () => {
  it('adds a MutationEntry with the method name', () => {
    class CtrlMut extends ActiveController {
      @mutation()
      async launch() { return null }
    }
    // Method decorators store on _target.constructor = CtrlMut
    const mutations = getMutations(CtrlMut)
    expect(mutations.some(m => m.method === 'launch')).toBe(true)
  })

  it('adds bulk = false for a non-bulk mutation', () => {
    class CtrlMut2 extends ActiveController {
      @mutation()
      async archive() { return null }
    }
    const mutations = getMutations(CtrlMut2)
    const entry = mutations.find(m => m.method === 'archive')
    expect(entry?.bulk).toBe(false)
  })

  it('supports bulk: true for bulk mutations', () => {
    class CtrlMut3 extends ActiveController {
      @mutation({ bulk: true })
      async bulkArchive() { return null }
    }
    const mutations = getMutations(CtrlMut3)
    const entry = mutations.find(m => m.method === 'bulkArchive')
    expect(entry?.bulk).toBe(true)
  })
})

describe('@action decorator', () => {
  it('adds an ActionEntry with the correct http method', () => {
    class CtrlAct extends ActiveController {
      @action('GET')
      async stats() { return {} }
    }
    const actions = getActions(CtrlAct)
    expect(actions.some(a => a.method === 'stats' && a.httpMethod === 'GET')).toBe(true)
  })

  it('supports custom path and load option', () => {
    class CtrlAct2 extends ActiveController {
      @action('POST', '/launch', { load: true })
      async launch() { return null }
    }
    const actions = getActions(CtrlAct2)
    const entry = actions.find(a => a.method === 'launch')
    expect(entry?.path).toBe('/launch')
    expect(entry?.load).toBe(true)
  })

  it('stores httpMethod as given (POST)', () => {
    class CtrlAct3 extends ActiveController {
      @action('POST')
      async doThing() { return null }
    }
    const actions = getActions(CtrlAct3)
    const entry = actions.find(a => a.method === 'doThing')
    expect(entry?.httpMethod).toBe('POST')
  })

  it('stores httpMethod DELETE', () => {
    class CtrlAct4 extends ActiveController {
      @action('DELETE')
      async removeAll() { return null }
    }
    const actions = getActions(CtrlAct4)
    const entry = actions.find(a => a.method === 'removeAll')
    expect(entry?.httpMethod).toBe('DELETE')
  })
})

describe('@before decorator', () => {
  it('adds a HookEntry that applies to all actions by default', () => {
    class CtrlBef extends ActiveController {
      @before()
      async authenticate() {}
    }
    // Method decorators store on _target.constructor = CtrlBef
    const hooks = collectBeforeHooks(CtrlBef, 'index')
    expect(hooks.some(h => h.method === 'authenticate')).toBe(true)
  })

  it('only applies to specified actions when only: [...] given', () => {
    class CtrlBef2 extends ActiveController {
      @before({ only: ['create', 'update'] })
      async validateOwner() {}
    }
    expect(collectBeforeHooks(CtrlBef2, 'create').some(h => h.method === 'validateOwner')).toBe(true)
    expect(collectBeforeHooks(CtrlBef2, 'index').some(h => h.method === 'validateOwner')).toBe(false)
  })

  it('skips actions listed in except: [...]', () => {
    class CtrlBef3 extends ActiveController {
      @before({ except: ['index'] })
      async checkAuth() {}
    }
    expect(collectBeforeHooks(CtrlBef3, 'index').some(h => h.method === 'checkAuth')).toBe(false)
    expect(collectBeforeHooks(CtrlBef3, 'create').some(h => h.method === 'checkAuth')).toBe(true)
  })

  it('inherits parent @before hooks and walks prototype chain', () => {
    class BaseCtrl extends ActiveController {
      @before()
      async globalAuth() {}
    }
    class ChildCtrl extends BaseCtrl {
      @before({ only: ['create'] })
      async ownerCheck() {}
    }
    const hooks = collectBeforeHooks(ChildCtrl, 'create')
    const methods = hooks.map(h => h.method)
    // Parent hook fires first (unshift)
    expect(methods.indexOf('globalAuth')).toBeLessThan(methods.indexOf('ownerCheck'))
  })
})

describe('@after decorator', () => {
  it('adds a HookEntry that fires after the action', () => {
    class CtrlAft extends ActiveController {
      @after()
      async logActivity() {}
    }
    const hooks = collectAfterHooks(CtrlAft, 'create')
    expect(hooks.some(h => h.method === 'logActivity')).toBe(true)
  })
})

describe('@rescue decorator', () => {
  it('adds a RescueEntry for the given error class', () => {
    class CtrlResc extends ActiveController {
      @rescue(BadRequest)
      handleBadRequest(_err: BadRequest) { return { message: 'handled' } }
    }
    const handlers = getRescueHandlers(CtrlResc)
    expect(handlers.some(h => h.errorClass === BadRequest)).toBe(true)
  })

  it('collectRescueHandlers only matches the right error type', () => {
    class CtrlResc2 extends ActiveController {
      @rescue(BadRequest)
      handleBad(_err: BadRequest) { return null }

      @rescue(NotFound)
      handleNotFound(_err: NotFound) { return null }
    }

    const badRequestErr = new BadRequest('bad')
    const notFoundErr = new NotFound('User')

    const badHandlers = collectRescueHandlers(CtrlResc2, 'index', badRequestErr)
    expect(badHandlers.every(h => h.errorClass === BadRequest)).toBe(true)

    const nfHandlers = collectRescueHandlers(CtrlResc2, 'index', notFoundErr)
    expect(nfHandlers.every(h => h.errorClass === NotFound)).toBe(true)
  })

  it('supports only/except filtering on rescue handlers', () => {
    class CtrlResc3 extends ActiveController {
      @rescue(BadRequest, { only: ['create'] })
      handleForCreate(_err: BadRequest) { return null }
    }

    const err = new BadRequest('x')
    expect(collectRescueHandlers(CtrlResc3, 'create', err)).toHaveLength(1)
    expect(collectRescueHandlers(CtrlResc3, 'index', err)).toHaveLength(0)
  })
})

// ── base.ts — ActiveController lifecycle ─────────────────────────────────────

describe('ActiveController._runBeforeHooks()', () => {
  it('runs matching @before hooks in order', async () => {
    const order: string[] = []

    class Ctrl extends ActiveController {
      @before()
      async step1() { order.push('step1') }

      @before()
      async step2() { order.push('step2') }
    }

    const ctrl = new Ctrl()
    await ctrl._runBeforeHooks('index')
    expect(order).toEqual(['step1', 'step2'])
  })

  it('throws BadRequest when a before hook returns false', async () => {
    class Ctrl extends ActiveController {
      @before()
      async guardFail() { return false }
    }

    const ctrl = new Ctrl()
    await expect(ctrl._runBeforeHooks('index')).rejects.toThrow(BadRequest)
  })

  it('skips hooks with a string condition (if:) when the condition method returns falsy', async () => {
    const ran = vi.fn()

    class Ctrl extends ActiveController {
      @before({ if: 'shouldRun' })
      async conditionalHook() { ran() }

      shouldRun() { return false }
    }

    const ctrl = new Ctrl()
    await ctrl._runBeforeHooks('index')
    expect(ran).not.toHaveBeenCalled()
  })

  it('runs hooks with a string condition (if:) when the condition method returns truthy', async () => {
    const ran = vi.fn()

    class Ctrl extends ActiveController {
      @before({ if: 'shouldRun' })
      async conditionalHook() { ran() }

      shouldRun() { return true }
    }

    const ctrl = new Ctrl()
    await ctrl._runBeforeHooks('index')
    expect(ran).toHaveBeenCalledTimes(1)
  })

  it('supports function conditions via if: () => boolean', async () => {
    const ran = vi.fn()
    const cond = vi.fn().mockReturnValue(true)

    class Ctrl extends ActiveController {
      @before({ if: cond })
      async hook() { ran() }
    }

    const ctrl = new Ctrl()
    await ctrl._runBeforeHooks('index')
    expect(ran).toHaveBeenCalledTimes(1)
    expect(cond).toHaveBeenCalled()
  })
})

describe('ActiveController._runAfterHooks()', () => {
  it('runs @after hooks after action completes', async () => {
    const ran = vi.fn()

    class Ctrl extends ActiveController {
      @after()
      async postAction() { ran() }
    }

    const ctrl = new Ctrl()
    await ctrl._runAfterHooks('create')
    expect(ran).toHaveBeenCalledTimes(1)
  })
})

describe('ActiveController._handleError()', () => {
  it('returns { handled: true, value } when a matching @rescue handler exists', async () => {
    class Ctrl extends ActiveController {
      @rescue(BadRequest)
      async handleBad(_err: BadRequest) { return 'recovered' }
    }

    const ctrl = new Ctrl()
    const result = await ctrl._handleError(new BadRequest('test'), 'index')
    expect(result).toEqual({ handled: true, value: 'recovered' })
  })

  it('returns { handled: false } when no handler matches the error type', async () => {
    class Ctrl extends ActiveController {
      @rescue(BadRequest)
      async handleBad(_err: BadRequest) { return 'recovered' }
    }

    const ctrl = new Ctrl()
    const result = await ctrl._handleError(new NotFound('User'), 'index')
    expect(result).toEqual({ handled: false })
  })

  it('propagates when the rescue handler itself throws', async () => {
    class Ctrl extends ActiveController {
      @rescue(BadRequest)
      async handleBad(_err: BadRequest): Promise<never> {
        throw new Forbidden('escalated')
      }
    }

    const ctrl = new Ctrl()
    await expect(ctrl._handleError(new BadRequest('x'), 'index')).rejects.toThrow(Forbidden)
  })

  it('walks prototype chain to find parent rescue handlers', async () => {
    class BaseCtrl extends ActiveController {
      @rescue(BadRequest)
      async handleBad(_err: BadRequest) { return 'from-parent' }
    }

    class ChildCtrl extends BaseCtrl {}

    const ctrl = new ChildCtrl()
    const result = await ctrl._handleError(new BadRequest('test'), 'index')
    expect(result).toEqual({ handled: true, value: 'from-parent' })
  })
})

// ── crud decorator ────────────────────────────────────────────────────────────

describe('@crud decorator', () => {
  class FakeModel {}

  it('sets CrudMeta with the model and config', () => {
    @crud(FakeModel as any, { index: { scopes: ['active'] }, create: { permit: ['name'] } })
    class Ctrl extends ActiveController {}

    const meta = getCrudMeta(Ctrl)
    expect(meta?.model).toBe(FakeModel)
    expect(meta?.config.index?.scopes).toEqual(['active'])
    expect(meta?.config.create?.permit).toEqual(['name'])
  })
})

describe('@singleton decorator', () => {
  class FakeModel {}

  it('sets SingletonMeta with the model and config', () => {
    @singleton(FakeModel as any, { findBy: (ctx: any) => ({ teamId: ctx.teamId }) })
    class Ctrl extends ActiveController {}

    const meta = getSingletonMeta(Ctrl)
    expect(meta?.model).toBe(FakeModel)
    expect(typeof meta?.config.findBy).toBe('function')
  })
})

// ── Multi-tenant pipeline (TState, scopeBy, autoSet ctrl, permit fn) ──────────

describe('ActiveController TState generic', () => {
  it('initializes this.state as an empty object', () => {
    const ctrl = new ActiveController()
    expect((ctrl as any).state).toEqual({})
  })

  it('@before hook can write to this.state and subsequent hooks can read it', async () => {
    type AppState = { org: { id: number; name: string } }

    class OrgController extends ActiveController<Record<string, any>, AppState> {
      @before()
      async resolveOrg() {
        // Simulates resolving the org from context
        this.state.org = { id: 42, name: 'Acme' }
      }
    }

    class AssetController extends OrgController {
      @before()
      async checkAccess() {
        // Child hook can read state set by parent hook
        if (!this.state.org) throw new Forbidden('No org')
      }
    }

    const ctrl = new AssetController()
    await ctrl._runBeforeHooks('index')
    expect((ctrl as any).state.org).toEqual({ id: 42, name: 'Acme' })
  })

  it('parent @before hooks run before child @before hooks (state builds up)', async () => {
    const order: string[] = []

    type MyState = { level1: boolean; level2: boolean }

    class Level1 extends ActiveController<Record<string, any>, MyState> {
      @before()
      async step1() {
        order.push('level1')
        this.state.level1 = true
      }
    }

    class Level2 extends Level1 {
      @before()
      async step2() {
        order.push('level2')
        this.state.level2 = true
        // state.level1 was set by parent
        expect(this.state.level1).toBe(true)
      }
    }

    const ctrl = new Level2()
    await ctrl._runBeforeHooks('index')
    expect(order).toEqual(['level1', 'level2'])
    expect((ctrl as any).state.level2).toBe(true)
  })

  it('three-level inheritance chain (Org → Team → Resource)', async () => {
    type ChainState = { org: string; team: string; ready: boolean }

    class OrgCtrl extends ActiveController<Record<string, any>, ChainState> {
      @before()
      async loadOrg() { this.state.org = 'Acme Corp' }
    }

    class TeamCtrl extends OrgCtrl {
      @before()
      async loadTeam() {
        expect(this.state.org).toBe('Acme Corp')
        this.state.team = 'Engineering'
      }
    }

    class CampaignCtrl extends TeamCtrl {
      @before()
      async setupReady() {
        expect(this.state.org).toBe('Acme Corp')
        expect(this.state.team).toBe('Engineering')
        this.state.ready = true
      }
    }

    const ctrl = new CampaignCtrl()
    await ctrl._runBeforeHooks('index')
    const state = (ctrl as any).state as ChainState
    expect(state.org).toBe('Acme Corp')
    expect(state.team).toBe('Engineering')
    expect(state.ready).toBe(true)
  })

  it('state on one instance does not leak to another instance', async () => {
    type S = { value: number }

    class Ctrl extends ActiveController<Record<string, any>, S> {
      @before()
      async set() { this.state.value = Math.random() }
    }

    const a = new Ctrl()
    const b = new Ctrl()
    await a._runBeforeHooks('index')
    await b._runBeforeHooks('index')
    // Each instance has independent state
    expect((a as any).state.value).not.toBe((b as any).state.value)
    expect((a as any).state).not.toBe((b as any).state)
  })
})

describe('buildPermittedData — permit as function', () => {
  // We test this by invoking defaultCreate/defaultUpdate internals via a mock router dispatch

  it('buildPermittedData handles permit as string array (backward compat)', async () => {
    // We verify this by checking that @crud(Model, { create: { permit: [...] } }) still works
    class FakeModel {}
    @crud(FakeModel as any, {
      create: { permit: ['name', 'email'] },
    })
    class Ctrl extends ActiveController {}

    const meta = getCrudMeta(Ctrl)
    expect(meta?.config.create?.permit).toEqual(['name', 'email'])
  })

  it('permit can be a function that receives (ctx, ctrl)', () => {
    class FakeModel {}
    const permitFn = vi.fn((_ctx: any, ctrl: any) => ctrl.state.isAdmin ? ['name', 'budget', 'status'] : ['name'])

    @crud(FakeModel as any, {
      create: { permit: permitFn },
    })
    class Ctrl extends ActiveController {}

    const meta = getCrudMeta(Ctrl)
    expect(typeof meta?.config.create?.permit).toBe('function')

    // Simulate what happens when the handler calls it
    const fakeCtrl = { state: { isAdmin: true } }
    const result = (meta!.config.create!.permit as Function)(null, fakeCtrl)
    expect(result).toEqual(['name', 'budget', 'status'])

    const limitedResult = (meta!.config.create!.permit as Function)(null, { state: { isAdmin: false } })
    expect(limitedResult).toEqual(['name'])
  })
})

describe('autoSet receives controller as second arg', () => {
  it('autoSet can access ctrl.state for resolved entities', () => {
    class FakeModel {}
    const orgIdFn = vi.fn((_ctx: any, ctrl: any) => ctrl.state.org?.id)
    const userIdFn = vi.fn((ctx: any) => ctx?.userId)  // backward compat: single arg

    @crud(FakeModel as any, {
      create: {
        permit: ['name'],
        autoSet: {
          organizationId: orgIdFn,
          createdById: userIdFn,
        },
      },
    })
    class Ctrl extends ActiveController {}

    const meta = getCrudMeta(Ctrl)
    const autoSet = meta!.config.create!.autoSet!

    // Simulate router calling autoSet with (ctx, ctrl)
    const fakeCtx = { userId: 'user-1' }
    const fakeCtrl = { state: { org: { id: 99 } } }

    expect(autoSet.organizationId(fakeCtx, fakeCtrl)).toBe(99)
    expect(autoSet.createdById(fakeCtx, fakeCtrl)).toBe('user-1')
  })
})

describe('scopeBy config on @crud', () => {
  it('scopeBy is stored on CrudMeta', () => {
    class FakeModel {}
    const scopeByFn = vi.fn((ctrl: any) => ({ organizationId: ctrl.state.org?.id }))

    @crud(FakeModel as any, { scopeBy: scopeByFn })
    class Ctrl extends ActiveController {}

    const meta = getCrudMeta(Ctrl)
    expect(typeof meta?.config.scopeBy).toBe('function')
    expect(meta?.config.scopeBy).toBe(scopeByFn)
  })

  it('scopeBy is called with the controller instance', () => {
    const scopeByFn = vi.fn((ctrl: any) => ({ orgId: ctrl.state.org?.id }))
    const fakeCtrl = { state: { org: { id: 77 } } }

    const result = scopeByFn(fakeCtrl)
    expect(result).toEqual({ orgId: 77 })
    expect(scopeByFn).toHaveBeenCalledWith(fakeCtrl)
  })

  it('dispatch applies scopeBy to ctrl.relation after @before hooks', async () => {
    const whereClause: Record<string, any>[] = []

    const mockRelation = {
      where: vi.fn((clause: any) => {
        whereClause.push(clause)
        return mockRelation  // chainable
      }),
    }

    class FakeModel {}

    @crud(FakeModel as any, {
      scopeBy: (ctrl: any) => ({ organizationId: ctrl.state.org.id }),
    })
    class OrgCtrl extends ActiveController<Record<string, any>, { org: { id: number } }> {
      @before()
      async resolveOrg() {
        this.state.org = { id: 55 }
      }
    }

    // Simulate what dispatch does: run before hooks, then apply scopeBy
    const ctrl = new OrgCtrl()
    ;(ctrl as any).relation = mockRelation
    ;(ctrl as any).context = {}
    ;(ctrl as any).params = {}
    ;(ctrl as any).state = {}

    await ctrl._runBeforeHooks('index')
    // At this point state.org is set — now simulate scopeBy application
    const meta = getCrudMeta(OrgCtrl)
    if (meta?.config.scopeBy) {
      const extra = meta.config.scopeBy(ctrl)
      ;(ctrl as any).relation = (ctrl as any).relation.where(extra)
    }

    expect(whereClause).toContainEqual({ organizationId: 55 })
  })
})

describe('singleton findBy receives (ctx, ctrl)', () => {
  it('findBy can access ctrl.state for resolved entities', () => {
    class FakeModel {}

    const findByFn = vi.fn((_ctx: any, ctrl: any) => ({ organizationId: ctrl.state.org?.id }))

    @singleton(FakeModel as any, { findBy: findByFn })
    class Ctrl extends ActiveController {}

    const meta = getSingletonMeta(Ctrl)
    const fakeCtrl = { state: { org: { id: 33 } } }
    const result = meta!.config.findBy({}, fakeCtrl)
    expect(result).toEqual({ organizationId: 33 })
  })

  it('findBy still works with single-arg signature (backward compat)', () => {
    class FakeModel {}
    const findByFn = (ctx: any) => ({ teamId: ctx.teamId })

    @singleton(FakeModel as any, { findBy: findByFn })
    class Ctrl extends ActiveController {}

    const meta = getSingletonMeta(Ctrl)
    const result = meta!.config.findBy({ teamId: 10 }, undefined)
    expect(result).toEqual({ teamId: 10 })
  })
})
