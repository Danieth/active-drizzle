import { ModelConcern, ModelConcernDef } from './define-model-concern.js'
import { HOOKS_KEY, HookRegistration } from '../runtime/hooks.js'

export const CONCERN_META = Symbol('active-drizzle:concern_meta')

export interface ConcernMeta {
  concerns: Array<{
    name: string
    config: any
    def: ModelConcernDef<any>
  }>
}

function getConcernMeta(target: any): ConcernMeta {
  if (!Object.prototype.hasOwnProperty.call(target, CONCERN_META)) {
    Object.defineProperty(target, CONCERN_META, {
      value: { concerns: [] },
      writable: true,
      configurable: true,
    })
  }
  return target[CONCERN_META]
}

function applySoftDeleteOverride(target: any) {
  const originalDestroy = target.prototype.destroy

  target.prototype.destroy = async function () {
    await this.update({ deletedAt: new Date() })
  }

  target.prototype.hardDestroy = async function () {
    return originalDestroy.call(this)
  }
}

function registerConcernCallbacks(target: any, concernName: string, callbacks: NonNullable<ModelConcernDef['callbacks']>) {
  if (!Object.prototype.hasOwnProperty.call(target, HOOKS_KEY)) {
    Object.defineProperty(target, HOOKS_KEY, { value: [], writable: true, configurable: true })
  }

  const hooksArray = target[HOOKS_KEY] as HookRegistration[]
  const toUnshift: HookRegistration[] = []

  for (const [event, fns] of Object.entries(callbacks)) {
    if (!fns) continue
    const fnArray = Array.isArray(fns) ? fns : [fns]
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]
      if (typeof fn !== 'function') continue
      
      // Attach the callback to the prototype with a unique name so `runHooks` can find it
      const uniqueName = `__concern_callback_${concernName}_${event}_${i}`
      target.prototype[uniqueName] = fn

      toUnshift.push({ event, method: uniqueName })
    }
  }

  hooksArray.unshift(...toUnshift)
}

function registerDefaultScope(target: any, name: string, fn: (q: any) => any) {
  if (!Object.prototype.hasOwnProperty.call(target, '__defaultScopes')) {
    Object.defineProperty(target, '__defaultScopes', { value: new Map(), writable: true, configurable: true })
  }
  target.__defaultScopes.set(name, fn)
}

export function include<TConfig = void>(
  concern: ModelConcern<TConfig>,
  ...args: TConfig extends void ? [] : [TConfig]
): ClassDecorator {
  return function (target: Function) {
    if (concern.__type !== 'model_concern') {
      throw new Error(`@include on ${target.name} received a non-model concern "${concern.name}".`)
    }

    const config = args[0] as TConfig
    const def = concern.def

    if (def.configure) {
      def.configure(config)
    }

    const meta = getConcernMeta(target)

    if (def.requires?.length) {
      for (const req of def.requires) {
        if (!meta.concerns.some(c => c.name === req.name)) {
          throw new Error(
            `Concern "${def.name}" requires "${req.name}" to be @include'd first. ` +
            `Because decorators evaluate bottom-up, you must place @include(${req.name}) BELOW @include(${def.name}) on ${target.name}.`
          )
        }
      }
    }

    meta.concerns.push({ name: def.name, config, def })

    // Store config for runtime access
    const ctor = target as any
    if (!ctor.__concern_config) ctor.__concern_config = {}
    ctor.__concern_config[def.name] = config

    // Apply instance methods
    if (def.methods) {
      for (const [name, fn] of Object.entries(def.methods)) {
        if (target.prototype.hasOwnProperty(name)) {
          throw new Error(
            `Concern "${def.name}" defines method "${name}" but it already exists on ${target.name}. ` +
            `Rename one to avoid conflicts.`
          )
        }
        target.prototype[name] = fn
      }
    }

    // Apply getters
    if (def.getters) {
      for (const [name, fn] of Object.entries(def.getters)) {
        if (target.prototype.hasOwnProperty(name)) {
          throw new Error(
            `Concern "${def.name}" defines getter "${name}" but a property already exists on ${target.name}.`
          )
        }
        Object.defineProperty(target.prototype, name, {
          get: fn,
          configurable: true,
        })
      }
    }

    // Apply static scopes
    if (def.scopes) {
      for (const [name, fn] of Object.entries(def.scopes)) {
        if (ctor.hasOwnProperty(name)) {
          throw new Error(
            `Concern "${def.name}" defines scope "${name}" but it already exists on ${target.name}.`
          )
        }
        ctor[name] = fn
      }
    }

    // Apply default scope
    if (def.defaultScope) {
      registerDefaultScope(target, def.name, def.defaultScope)
    }

    // Apply callbacks
    if (def.callbacks) {
      registerConcernCallbacks(target, def.name, def.callbacks)
    }

    // Apply associations
    if (def.associations) {
      for (const [name, assoc] of Object.entries(def.associations)) {
        ctor[name] = assoc
      }
    }

    // Apply overrides
    if (def.overrides?.destroy === 'soft') {
      applySoftDeleteOverride(target)
    }
  }
}
