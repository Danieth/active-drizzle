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

/**
 * Kind → value/meta types. The FRAMEWORK types its own kinds (below);
 * apps augment AdKindShapes for custom kinds (defineAttrKind will emit
 * this). `registerPresenter` then checks the component against its
 * kind's value type — a money bulb typed for string is a red squiggle.
 */
export interface BuiltinKindShapes {
  string: { value: string | null }
  text: { value: string | null }
  email: { value: string | null }
  url: { value: string | null }
  uuid: { value: string | null }
  money: { value: number | null }
  percent: { value: number | null }
  bps: { value: number | null }
  multiple: { value: number | null }
  integer: { value: number | null }
  int: { value: number | null }
  decimal: { value: number | string | null }
  boolean: { value: boolean | null }
  date: { value: string | null }
  enum: { value: string | null }
  state: { value: string | null }
  json: { value: unknown }
}

/** App-augmented kind shapes (custom kinds) — wins over builtins. */
export interface AdKindShapes {}

export type KindValue<K extends string> =
  K extends keyof AdKindShapes ? (AdKindShapes[K] extends { value: infer V } ? V : any)
  : K extends keyof BuiltinKindShapes ? BuiltinKindShapes[K]['value']
  : any

/** The props a presenter for kind K receives — value TYPED by the kind. */
export type PresenterPropsFor<K extends string> = PresenterProps<KindValue<K>>

export interface PresenterProps<V = any> {
  value: V
  bind: PresenterBind
  /** Field meta from the backend Attr, CALL-SITE-MERGED: `<loan.amount
   *  label="X"/>` arrives as meta.label — read meta and overrides just
   *  work. (Resolution — kind, presenter names — always uses the pure
   *  Attr meta; a call site can't spoof those.) */
  meta: Record<string, any>
  /** The raw call-site overrides, pre-merge — for the rare presenter that
   *  must distinguish "Attr said" from "call site said". */
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
  /**
   * @frontendContext — server-computed, request-level facts from the door
   * (userType, plan, …), the same bag in EVERY presenter of the app.
   * Never fetched, never prop-drilled: computed once per request beside
   * abilities and delivered on the envelope. Always an object (empty on
   * ungoverned sessions) so `ctx.userType` never explodes.
   *
   * TYPED once codegen has run: the generated `_ctx.gen.ts` augments
   * AdFrontendCtx from your actual @frontendContext return types, so
   * `ctx.userType` autocompletes as `'admin' | 'member' | undefined` and a
   * typo is a red squiggle in every presenter at once.
   */
  ctx: FrontendCtx
}

/**
 * The compile-time half of @frontendContext. Codegen augments this from
 * the declared keys' REAL return types (`_ctx.gen.ts`); before the first
 * regen it stays empty and ctx degrades to Record<string, unknown> —
 * nothing to opt into, the vice closes on its own. Keys are optional
 * because a presenter can render under a door that declares none of them.
 */
export interface AdFrontendCtx {}

export type FrontendCtx = keyof AdFrontendCtx extends never
  ? Record<string, unknown>
  : AdFrontendCtx & Record<string, unknown>

export interface PresenterDef<K extends string = string> {
  /** Attr kind(s) this presenter accepts — wrong pairing is a dev-time error. */
  kind: K | K[]
  /** Meta keys this presenter refuses to render without. */
  requires?: string[]
  /** Natural commit moment. Discrete inputs: 'change'. Continuous: 'blur' (default). */
  commit?: 'change' | 'blur'
  /** Chrome responsibilities THIS BULB handles itself (LAW 3): a bare
   *  bulb under no consuming layout must handle the full required set —
   *  regen walks coverage and errors on gaps and double-claims. */
  handles?: import('./presenter-context.js').ChromeResponsibility[]
  component: ComponentType<PresenterPropsFor<K>>
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

/** Kinds whose inputs commit discretely — a toggle/select never blurs. */
const DISCRETE_KINDS = new Set(['boolean', 'enum', 'state'])

/**
 * LAYOUTS ARE CONTEXT (GOLDEN-RULE.md; DESIGN-presenter-tree §3): a
 * folder's context.ts declares its layout + consumed responsibilities;
 * the stack wraps every presenter beside/below. The transitional
 * registration API (registerPresenterLayout) was deleted per the spec —
 * see presenter-context.tsx for the stacking machinery.
 */
export type PresenterLayout = ComponentType<PresenterProps & { children?: import('react').ReactNode }>

export function registerPresenter<K extends string>(name: string, def: PresenterDef<K>): void {
  // The silent-never-saves trap: a discrete presenter left on the default
  // 'blur' commit only saves when the input blurs — which a toggle may
  // never do. Teach at REGISTRATION, not after a user's flip vanishes.
  const kinds = Array.isArray(def.kind) ? def.kind : [def.kind]
  if (def.commit !== 'change' && kinds.some(k => DISCRETE_KINDS.has(k))) {
    console.warn(
      `[active-drizzle] presenter "${name}" serves discrete kind(s) ` +
      `${kinds.filter(k => DISCRETE_KINDS.has(k)).join(', ')} without commit: 'change' — ` +
      `under autosave, a toggle that never blurs NEVER SAVES. Add commit: 'change' ` +
      `(or ignore this if the presenter genuinely commits on blur).`,
    )
  }
  registry.set(name, def as PresenterDef)
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
