/**
 * Resolving a model class's declared name.
 *
 * `class User { static name = Attr.string() }` is legal and common — but the
 * static field shadows the class's built-in `.name` with an Attr config object,
 * so `User.name` is no longer a string. Static fields initialize before class
 * decorators run, so `@model` cannot capture the name ahead of the shadowing.
 *
 * Worse, esbuild (used by Vite and tsup) lowers decorated classes to anonymous
 * class expressions (`let User = class extends ApplicationRecord {}`) with
 * static fields applied afterward — so the declared name survives in neither
 * `.name` nor the class's source text. In that case we derive the conventional
 * class name from the table name (`deals` → `Deal`), which is exactly the value
 * STI type columns and polymorphic *Type columns hold. Models with
 * unconventional table names can pass `@model(table, { className })`.
 *
 * This module is import-cycle-safe: it depends on nothing.
 */

const CLASS_NAME_SOURCE = /^\s*(?:class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/

/** Naive singularizer — mirrors the association-inference rules. */
function _singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** `shadow_users` → `ShadowUser` */
function _classify(table: string): string {
  return _singularize(table)
    .split(/[_-]/)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join('')
}

/**
 * Returns the class name a model was declared with, even when a
 * `static name = Attr…` field shadows `.name`.
 *
 * Resolution order:
 *   1. `_activeDrizzleClassName` stamped on the class itself by `@model`
 *      (own property only — subclasses must not inherit the parent's name)
 *   2. `.name` when it is still a non-empty string (nothing shadowed it)
 *   3. The identifier parsed out of the class's own source text (tsc output
 *      keeps it; esbuild output does not)
 *   4. The conventional name derived from the table name (`deals` → `Deal`)
 *
 * Returns '' for non-function inputs so `if (!modelClassName(x))` guards work.
 */
export function modelClassName(cls: unknown): string {
  if (typeof cls !== 'function') return ''
  const c = cls as any
  if (Object.prototype.hasOwnProperty.call(c, '_activeDrizzleClassName')) {
    return c._activeDrizzleClassName
  }
  if (typeof c.name === 'string' && c.name !== '') return c.name
  const match = CLASS_NAME_SOURCE.exec(Function.prototype.toString.call(cls))
  if (match && match[1] !== 'extends' && match[1] !== 'implements') return match[1]!
  return typeof c._activeDrizzleTableName === 'string' ? _classify(c._activeDrizzleTableName) : 'Model'
}
