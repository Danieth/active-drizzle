import { describe, it, expect } from 'vitest'
import { include, CONCERN_META } from '../../src/concerns/include.js'
import { defineModelConcern } from '../../src/concerns/define-model-concern.js'
import { collectHooks, HOOKS_KEY } from '../../src/runtime/hooks.js'

describe('@include decorator', () => {
  it('applies basic methods and getters to the prototype', () => {
    const TestConcern = defineModelConcern({
      name: 'TestConcern',
      methods: {
        hello() { return 'world' }
      },
      getters: {
        greeting() { return 'hi' }
      }
    })

    @include(TestConcern)
    class TestClass {}

    const instance = new TestClass() as any
    expect(instance.hello()).toBe('world')
    expect(instance.greeting).toBe('hi')
  })

  it('applies scopes as static methods', () => {
    const ScopeConcern = defineModelConcern({
      name: 'Scope',
      scopes: {
        active: (q: any) => q.where('active', true)
      }
    })

    @include(ScopeConcern)
    class ScopedClass {}

    const ctor = ScopedClass as any
    expect(typeof ctor.active).toBe('function')
  })

  it('runs concern callbacks BEFORE class callbacks', () => {
    const Tracker = defineModelConcern({
      name: 'Tracker',
      callbacks: {
        beforeSave: function() { return 'tracked' }
      }
    })

    class RawClass {}
    // Need to register our own hook to test ordering
    if (!(RawClass as any)[HOOKS_KEY]) Object.defineProperty(RawClass, HOOKS_KEY, { value: [], writable: true })
    ;(RawClass as any)[HOOKS_KEY].push({ event: 'beforeSave', method: 'ownMethod' })

    // Apply include after standard hooks are registered
    include(Tracker)(RawClass)

    const hooks = collectHooks(RawClass)
    expect(hooks.length).toBe(2)
    // Concern hooks should be unshifted
    expect(hooks[0].event).toBe('beforeSave')
    expect(hooks[0].method.startsWith('__concern_callback_Tracker_beforeSave')).toBe(true)
    expect(hooks[1].method).toBe('ownMethod')
  })

  it('throws an error if a requires dependency is missing', () => {
    const DepA = defineModelConcern({ name: 'DepA' })
    const DepB = defineModelConcern({ name: 'DepB', requires: [DepA] })

    expect(() => {
      @include(DepB)
      class BadClass {}
    }).toThrow(/requires "DepA" to be @include'd first/)

    expect(() => {
      @include(DepB)
      @include(DepA)
      class GoodClass {}
    }).not.toThrow()
  })

  it('throws when method names conflict', () => {
    const Conflicter = defineModelConcern({
      name: 'Conflicter',
      methods: { collision() {} }
    })

    expect(() => {
      @include(Conflicter)
      class CollisionClass {
        collision() {}
      }
    }).toThrow(/already exists/)
  })

  it('stores and provides configuration', () => {
    const Configurable = defineModelConcern<{ testBool: boolean }>({
      name: 'Configurable',
      configure: opts => opts,
      methods: {
        getConf() {
          return this.constructor.__concern_config.Configurable.testBool
        }
      }
    })

    @include(Configurable, { testBool: true })
    class ConfigClass {}

    const inst = new ConfigClass() as any
    expect(inst.getConf()).toBe(true)
  })
})
