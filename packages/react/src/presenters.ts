/**
 * Presenter registry — the headless plugin layer.
 *
 * ActiveDrizzle ships ZERO presenters: the socket, never the bulbs. Your app
 * (or a UI-kit package) registers components against names; fields resolve
 * through a deterministic ladder. Presenters are dumb: they receive value,
 * bind, meta, and render — every behavior (staging, autosave, optimistic
 * writes) lives in FormSession, written once.
 *
 *   registerPresenter('moneyInput', {
 *     kind: 'money',
 *     commit: 'blur',                  // discrete inputs use 'change'
 *     requires: ['label'],             // meta this presenter needs to render
 *     component: MoneyInput,
 *   })
 *
 *   setDefaultPresenters({
 *     money: { edit: 'moneyInput', view: 'moneyText' },
 *     boolean: { edit: 'switch', view: 'check' },
 *   })
 *
 * Resolution for `<loan.amount edit />`:
 *   call-site name → Attr `presenters:` meta → app kind-default → error.
 * No silent framework fallback exists. `edit` is never inferred.
 */
import type { ComponentType } from 'react'

export interface PresenterBind {
  name: string
  onChange: (value: any) => void
  /** The presenter's natural commit moment fires this (blur for text, change for toggles). */
  onCommit: () => void
  onBlur: () => void
  disabled: boolean
}

export interface PresenterProps<V = any> {
  value: V
  bind: PresenterBind
  /** Field meta from the backend Attr — label/help/info/copy-resolved/kind/your keys. */
  meta: Record<string, any>
  /** Call-site overrides win over meta (label, help, arbitrary props). */
  overrides: Record<string, any>
  mode: 'edit' | 'view'
  /** The ENTIRE projected draft — safe by construction (unexposed fields don't exist). */
  draft: any
  errors: string[]
  state: 'ready' | 'saving' | 'saved' | 'error' | 'unauthenticated'
}

export interface PresenterDef {
  /** Attr kind(s) this presenter accepts — wrong pairing is a dev-time error. */
  kind: string | string[]
  /** Meta keys this presenter refuses to render without. */
  requires?: string[]
  /** Natural commit moment. Discrete inputs: 'change'. Continuous: 'blur' (default). */
  commit?: 'change' | 'blur'
  component: ComponentType<PresenterProps>
}

const registry = new Map<string, PresenterDef>()
let kindDefaults: Record<string, { edit?: string; view?: string }> = {}

export function registerPresenter(name: string, def: PresenterDef): void {
  registry.set(name, def)
}

/** App-registered per-kind defaults. AD itself registers NONE. */
export function setDefaultPresenters(defaults: Record<string, { edit?: string; view?: string }>): void {
  kindDefaults = { ...kindDefaults, ...defaults }
}

export function getPresenter(name: string): PresenterDef | undefined {
  return registry.get(name)
}

/** Test/HMR reset. */
export function clearPresenters(): void {
  registry.clear()
  kindDefaults = {}
}

export interface ResolvedPresenter {
  name: string
  def: PresenterDef
  mode: 'edit' | 'view'
}

/**
 * The resolution ladder for one rendered field. Returns null when the field
 * renders nothing. Throws descriptive errors for wiring mistakes — these are
 * developer errors, not runtime conditions to swallow.
 */
export function resolvePresenter(opts: {
  field: string
  kind: string | null
  meta: Record<string, any>
  /** Call-site `edit` prop: absent → view; true → declared/default edit; string → named. */
  edit?: boolean | string
  /** Call-site `view` prop: string → named. */
  view?: string
  canEdit: boolean
  locked: boolean
}): ResolvedPresenter | null {
  const { field, kind, meta } = opts
  const metaPresenters = (meta?.presenters ?? {}) as { edit?: string; view?: string }
  const defaults = kind ? (kindDefaults[kind] ?? {}) : {}

  // Edit path — only when the call site opted in AND the mask/lock allow it
  if (opts.edit !== undefined && opts.edit !== false && opts.canEdit && !opts.locked) {
    const name = typeof opts.edit === 'string'
      ? opts.edit
      : metaPresenters.edit ?? defaults.edit
    if (!name) {
      throw new Error(
        `No edit presenter for "${field}": pass edit="name", set presenters.edit on the Attr, or setDefaultPresenters({ ${kind ?? '<kind>'}: { edit } })`,
      )
    }
    return { name, def: lookup(name, field, kind), mode: 'edit' }
  }

  // View path
  const name = opts.view ?? metaPresenters.view ?? defaults.view
  if (!name) {
    throw new Error(
      `No view presenter for "${field}": pass view="name", set presenters.view on the Attr, or setDefaultPresenters({ ${kind ?? '<kind>'}: { view } })`,
    )
  }
  return { name, def: lookup(name, field, kind), mode: 'view' }
}

function lookup(name: string, field: string, kind: string | null): PresenterDef {
  const def = registry.get(name)
  if (!def) {
    throw new Error(`Presenter "${name}" (field "${field}") is not registered — registerPresenter('${name}', …)`)
  }
  if (kind) {
    const accepted = Array.isArray(def.kind) ? def.kind : [def.kind]
    if (!accepted.includes(kind) && !accepted.includes('*')) {
      throw new Error(
        `Presenter "${name}" accepts kind ${accepted.map(k => `'${k}'`).join('|')} but field "${field}" is '${kind}'`,
      )
    }
  }
  return def
}

/** Dev backstop for the `requires` gate (the compile-time gate lands with typed codegen). */
export function checkRequiredMeta(name: string, def: PresenterDef, field: string, meta: Record<string, any>): void {
  for (const key of def.requires ?? []) {
    const present = meta?.[key] !== undefined || meta?.meta?.[key] !== undefined
    if (!present) {
      throw new Error(
        `Presenter "${name}" requires meta '${key}', but field "${field}" doesn't declare it — add ${key}: … to the Attr`,
      )
    }
  }
}
