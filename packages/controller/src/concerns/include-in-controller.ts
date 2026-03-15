import {
  BEFORE_META, AFTER_META, ACTION_META,
  type HookEntry, type ActionEntry
} from '../metadata.js'
import type { ControllerConcern } from './define-controller-concern.js'

export const CONTROLLER_CONCERN_META = Symbol('active-drizzle:controller_concern_meta')

export interface ControllerConcernMeta {
  concerns: Array<{ name: string; config: any }>
}

export function includeInController<TConfig = void>(
  concern: ControllerConcern<TConfig>,
  ...args: TConfig extends void ? [] : [TConfig]
): ClassDecorator {
  return function (target: Function) {
    if (concern.__type !== 'controller_concern') {
      throw new Error(`@includeInController on ${target.name} received a non-controller concern "${concern.name}".`)
    }

    const config = args[0] as TConfig
    const def = concern.def

    if (def.configure) {
      def.configure(config)
    }

    // Store concern meta
    if (!Object.prototype.hasOwnProperty.call(target, CONTROLLER_CONCERN_META)) {
      Object.defineProperty(target, CONTROLLER_CONCERN_META, {
        value: { concerns: [] },
        writable: true,
        configurable: true,
      })
    }
    const meta = (target as any)[CONTROLLER_CONCERN_META] as ControllerConcernMeta
    meta.concerns.push({ name: def.name, config })

    // Check dependency chain
    if (def.requires?.length) {
      for (const req of def.requires) {
        if (!meta.concerns.some(c => c.name === req.name)) {
          throw new Error(
            `Concern "${def.name}" requires "${req.name}" to be @includeInController first. ` +
            `Because decorators evaluate bottom-up, place @includeInController(${req.name}) BELOW @includeInController(${def.name}).`
          )
        }
      }
    }

    // Store config for runtime access
    const ctor = target as any
    if (!ctor.__concern_config) ctor.__concern_config = {}
    ctor.__concern_config[def.name] = config

    // Inject before-hooks
    if (def.before?.length) {
      for (const hook of def.before) {
        const uniqueName = `__concern_before_${def.name}_${hook.method}`
        ;(target as any).prototype[uniqueName] = hook.fn

        if (!Object.prototype.hasOwnProperty.call(target, BEFORE_META)) {
          ;(target as any)[BEFORE_META] = []
        }
        const entry: HookEntry = {
          method: uniqueName,
          ...(hook.only ? { only: hook.only } : {}),
          ...(hook.except ? { except: hook.except } : {}),
        }
        ;(target as any)[BEFORE_META].push(entry)
      }
    }

    // Inject after-hooks
    if (def.after?.length) {
      for (const hook of def.after) {
        const uniqueName = `__concern_after_${def.name}_${hook.method}`
        ;(target as any).prototype[uniqueName] = hook.fn

        if (!Object.prototype.hasOwnProperty.call(target, AFTER_META)) {
          ;(target as any)[AFTER_META] = []
        }
        const entry: HookEntry = {
          method: uniqueName,
          ...(hook.only ? { only: hook.only } : {}),
          ...(hook.except ? { except: hook.except } : {}),
        }
        ;(target as any)[AFTER_META].push(entry)
      }
    }

    // Inject action routes
    if (def.actions?.length) {
      for (const actionDef of def.actions) {
        const uniqueName = `__concern_action_${def.name}_${actionDef.method}`
        ;(target as any).prototype[uniqueName] = actionDef.fn

        if (!Object.prototype.hasOwnProperty.call(target, ACTION_META)) {
          ;(target as any)[ACTION_META] = []
        }
        const entry: ActionEntry = {
          method: uniqueName,
          httpMethod: actionDef.httpMethod,
          load: actionDef.load ?? false,
          ...(actionDef.path ? { path: actionDef.path } : {}),
        }
        ;(target as any)[ACTION_META].push(entry)
      }
    }
  }
}
