import { registerHook } from './hooks.js'
import { MODEL_REGISTRY, transaction } from './boot.js'

export type HookCondition = string | (() => boolean)

export type HookOptions = {
  if?: HookCondition
  on?: 'create' | 'update'
}

/**
 * @model('table_name') — binds the class to a database table.
 * Sets _activeDrizzleTableName so ApplicationRecord.tableName returns it.
 * Also registers the class in MODEL_REGISTRY for STI subclass resolution.
 */
export function model(table: string): ClassDecorator {
  return (target: any) => {
    target._activeDrizzleTableName = table
    MODEL_REGISTRY[target.name] = target  // by class name (STI, polymorphic type resolution)
    MODEL_REGISTRY[table] = target         // by table name (association inference)
  }
}

/**
 * @scope — marks a static method as a chainable scope.
 * Consumed by codegen for type generation; no runtime effect needed.
 */
export function scope(_target: unknown, _key: string, _descriptor: PropertyDescriptor): void {}

/**
 * @computed — marks a static method as a computed scope (aggregate or derived data).
 * Consumed by codegen for type generation; no runtime effect needed.
 */
export function computed(_target: unknown, _key: string, _descriptor: PropertyDescriptor): void {}

// ── Lifecycle hooks ───────────────────────────────────────────────────────

export function beforeSave(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'beforeSave', String(key), options)
  }
}

export function afterSave(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'afterSave', String(key), options)
  }
}

export function beforeCreate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'beforeCreate', String(key), options)
  }
}

export function afterCreate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'afterCreate', String(key), options)
  }
}

export function beforeUpdate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'beforeUpdate', String(key), options)
  }
}

export function afterUpdate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'afterUpdate', String(key), options)
  }
}

export function beforeDestroy(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'beforeDestroy', String(key), options)
  }
}

export function afterDestroy(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'afterDestroy', String(key), options)
  }
}

/**
 * @afterCommit — fires after the surrounding transaction commits.
 * When not inside a transaction, fires immediately after save().
 */
export function afterCommit(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'afterCommit', String(key), options)
  }
}

/**
 * @transactional — wraps the decorated async method in an ApplicationRecord
 * transaction automatically. Any save/destroy calls inside are rolled back
 * together on error. Nesting is safe: inner @transactional methods reuse the
 * surrounding transaction context rather than opening a new one.
 *
 * @example
 *   @transactional
 *   async transferFunds(from: Account, to: Account, amount: number) {
 *     await from.update({ balance: from.balance - amount })
 *     await to.update({ balance: to.balance + amount })
 *   }
 */
export function transactional(
  _target: object,
  _key: string | symbol,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  const original = descriptor.value as (...args: unknown[]) => Promise<unknown>
  descriptor.value = function (this: unknown, ...args: unknown[]) {
    return transaction(() => original.apply(this, args))
  }
  return descriptor
}

/**
 * @memoize — caches the result of a getter per-instance, cleared on reload().
 * Codegen-only annotation for now; no runtime implementation.
 */
export function memoize(_target: unknown, _key: string, _descriptor: PropertyDescriptor): void {}

/**
 * @server — marks a method as backend-only; stripped from the isomorphic
 * Asset.Client frontend class by codegen.
 */
export function server(_target: unknown, _key: string, _descriptor: PropertyDescriptor): void {}

/**
 * @validate() — marks an instance method as a class-level synchronous validation.
 * The method runs during save() and can either:
 *   - Return a string error message (pushed to errors['base'])
 *   - Push directly to this.errors[field]
 *
 * @example
 *   @validate()
 *   checkDates() {
 *     if (this.startDate > this.endDate) return 'start must be before end'
 *   }
 */
export function validate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'validate', String(key), options)
  }
}

/**
 * @serverValidate() — asynchronous server-side validation (uniqueness checks, DB queries).
 * Runs during save() after all synchronous @validate() methods.
 */
export function serverValidate(options?: HookOptions): MethodDecorator {
  return (target: object, key: string | symbol) => {
    registerHook(target, 'serverValidate', String(key), options)
  }
}
