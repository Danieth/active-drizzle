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
  /**
   * Pass the focus event through — a blur into an element marked
   * `data-ad-cancel` skips the autosave commit (C10).
   */
  onBlur: (e?: { relatedTarget?: any }) => void
  /** IME guards — while composing, commit-on-change is suppressed (C11). */
  onCompositionStart: () => void
  onCompositionEnd: () => void
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
  state: 'ready' | 'saving' | 'saved' | 'error' | 'unauthenticated' | 'conflict' | 'pending' | 'waiting'
  /** True while this field's draft value differs from the server baseline — render an "unsaved" marker. */
  dirty: boolean
  /**
   * The server moved THIS field while you hold a different local value:
   * `value` is theirs, `at` is when (envelope updatedAt ?? version).
   * Present only during a live divergence — render an inline affordance
   * ("changed 30s ago → take it") and adopt via bind.onChange(elsewhere.value)
   * or session-level adoptIncoming. Absent = nothing moved under you.
   */
  elsewhere?: { value: any; at: string | number | null }
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

/**
 * The compile-time half of the presenter registry. Augment it with your
 * presenter names and the kind(s) they accept:
 *
 *   declare module '@active-drizzle/react' {
 *     interface AdPresenterKinds {
 *       moneyInput: 'money'
 *       moneyText: 'money'
 *       switch: 'boolean'
 *       badge: '*'                     // accepts every kind
 *     }
 *   }
 *
 * Generated typed handles then constrain `<loan.amount edit="…">` to
 * presenters whose kind matches the field — a wrong pairing is a COMPILE
 * error. Without augmentation the gate stays open (plain `string`), so
 * adoption is incremental and nothing breaks.
 */
export interface AdPresenterKinds {}

/**
 * Presenter names legal for a field of kind K:
 * exact kind matches, multi-kind unions containing K, and '*' presenters.
 * Ungated (string) until AdPresenterKinds is augmented.
 */
export type PresenterNameFor<K extends string> =
  keyof AdPresenterKinds extends never
    ? string
    : {
        [P in keyof AdPresenterKinds & string]:
          '*' extends AdPresenterKinds[P] ? P
          : K extends AdPresenterKinds[P] ? P
          : never
      }[keyof AdPresenterKinds & string]

const registry = new Map<string, PresenterDef>()
let kindDefaults: Record<string, { edit?: string; view?: string }> = {}

/**
 * Semantic kinds degrade to their base kind when nothing more specific is
 * registered: an 'email' field renders with the 'string' defaults until the
 * app registers an emailInput. Pretty presenters are one registration away;
 * zero registrations still work.
 */
const KIND_FALLBACKS: Record<string, string> = {
  email: 'string',
  url: 'string',
  uuid: 'string',
}

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
  const fallbackKind = kind ? KIND_FALLBACKS[kind] : undefined
  const defaults = kind
    ? { ...(fallbackKind ? kindDefaults[fallbackKind] : {}), ...(kindDefaults[kind] ?? {}) }
    : {}

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
    const fallback = KIND_FALLBACKS[kind]
    const matches = accepted.includes(kind) || accepted.includes('*')
      || (fallback !== undefined && accepted.includes(fallback))
    if (!matches) {
      throw new Error(
        `Presenter "${name}" serves kind ${accepted.map(k => `'${k}'`).join('|')} but field "${field}" is '${kind}'. ` +
        `Use a '${kind}' presenter here, or register one that serves it: registerPresenter('${name}', { kind: '${kind}', … }). ` +
        `To catch this at COMPILE time, augment AdPresenterKinds with your presenter names → kinds (LLM-GUIDE: presenters).`,
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
