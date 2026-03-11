/**
 * Hook registration and execution primitives.
 *
 * Kept separate from decorators.ts so application-record.ts can import
 * runHooks without a circular dependency.
 */

export const HOOKS_KEY = Symbol('active-drizzle:hooks')

export type HookRegistration = {
  event: string
  method: string
  condition?: string | (() => boolean)
  on?: 'create' | 'update'
}

/**
 * Called inside each @beforeSave / @afterSave / etc. decorator to store
 * the hook registration on the class (not the prototype).
 */
export function registerHook(
  proto: object,
  event: string,
  method: string,
  options?: { if?: string | (() => boolean); on?: 'create' | 'update' },
): void {
  const ctor = (proto as any).constructor
  if (!Object.prototype.hasOwnProperty.call(ctor, HOOKS_KEY)) {
    Object.defineProperty(ctor, HOOKS_KEY, { value: [], writable: true, configurable: true })
  }
  const reg: HookRegistration = { event, method }
  if (options?.if !== undefined) reg.condition = options.if
  if (options?.on !== undefined) reg.on = options.on
  ;(ctor[HOOKS_KEY] as HookRegistration[]).push(reg)
}

/**
 * Walks the prototype chain and collects hooks from parent → child order,
 * so parent hooks always fire before child hooks.
 */
export function collectHooks(ctor: any): HookRegistration[] {
  const chain: HookRegistration[][] = []
  let current = ctor
  while (current && current !== Function.prototype) {
    if (Object.prototype.hasOwnProperty.call(current, HOOKS_KEY)) {
      chain.unshift(current[HOOKS_KEY] as HookRegistration[])
    }
    current = Object.getPrototypeOf(current)
  }
  return chain.flat()
}

/**
 * Executes all hooks for a given event on an instance.
 *
 * @param instance  The proxied ApplicationRecord instance.
 * @param event     e.g. 'beforeSave', 'afterSave', 'afterCommit'
 * @param isNew     true if the record has not yet been persisted (INSERT path)
 * @returns         false if a before-hook explicitly returned false (aborts save)
 */
export async function runHooks(instance: any, event: string, isNew: boolean): Promise<boolean> {
  for (const hook of collectHooks(instance.constructor)) {
    if (hook.event !== event) continue
    if (hook.on === 'create' && !isNew) continue
    if (hook.on === 'update' && isNew) continue

    if (hook.condition !== undefined) {
      let shouldRun: boolean
      if (typeof hook.condition === 'function') {
        shouldRun = Boolean(hook.condition.call(instance))
      } else {
        const condVal = (instance as any)[hook.condition]
        shouldRun = typeof condVal === 'function' ? Boolean(condVal()) : Boolean(condVal)
      }
      if (!shouldRun) continue
    }

    const method = (instance as any)[hook.method]
    if (typeof method !== 'function') continue

    const result = await method.call(instance)
    // A before-hook returning exactly `false` aborts the operation
    if (event.startsWith('before') && result === false) return false
  }
  return true
}
