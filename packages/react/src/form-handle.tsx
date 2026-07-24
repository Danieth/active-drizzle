/**
 * The form handle — `loan.amount` IS the component.
 *
 * Naming law (enforced by codegen collision checks):
 *   camelCase   → your fields:      <loan.amount edit />
 *   PascalCase  → components:       <loan.Form> <loan.Submit event="submit">
 *   $-prefixed  → framework API:    loan.$draft, loan.$errors, loan.$submit()
 *
 * JSX member expressions don't require capitalization, so a field handle is a
 * callable function component that also carries `.errors` / `.meta` / `.value`
 * for programmatic reads. Each field subscribes to ITS OWN slice of the
 * FormSession via useSyncExternalStore — a keystroke re-renders one field.
 */
import React, { createContext, useContext, useEffect, useState, useSyncExternalStore, Fragment, type FC, type ReactNode } from 'react'
import { FormSession, type SessionStatus } from './form-session.js'
import { parseControllerError } from './errors.js'
import { NestedArrayManager, NestedOneManager, type NestedChild } from './nested.js'
import { resolvePresenter, checkRequiredMeta, type PresenterBind, type PresenterProps } from './presenters.js'

/**
 * Context decides what COMMIT does — the presenter never knows:
 *   inside <Form>          → 'stage'     (batch; Submit sends the diff)
 *   inside <Form autosave> → 'autoflush' (whole-diff, validity-gated,
 *                            debounced flush — the object saves itself the
 *                            moment it's coherent and quiet)
 *   no Form at all         → 'autosave'  (single-field PATCH per commit — a
 *                            lone field commits itself; without a transport,
 *                            commits just stage)
 */
const FormModeContext = createContext<{ mode: 'stage' | 'autoflush'; debounceMs: number } | null>(null)

/** The enclosing Form's submit pipeline — Submit buttons route through it so onSuccess fires. */
const FormSubmitContext = createContext<((opts?: { event?: string }) => Promise<boolean>) | null>(null)

export interface FieldProps {
  /** absent → view · true → Attr/default edit presenter · string → named override. Never inferred. */
  edit?: boolean | string
  /** absent/bare → default view presenter · string → named override. */
  view?: boolean | string
  label?: string
  help?: string
  /** Passed through to the presenter via overrides — Tailwind/etc. just works. */
  className?: string
  /**
   * Field is WAITING on the backend while this predicate holds (a job, an
   * import, "report generating…"). The presenter renders with
   * state='waiting' (+ meta.pendingLabel) and its input disables. Pair
   * with a polling form (`poll: { every, until }`) so the wait resolves.
   */
  pendingIf?: (draft: any) => boolean
  /** Label shown by presenters while pendingIf holds. */
  pendingLabel?: string
  /** Extra props passed through to the presenter. */
  props?: Record<string, any>
}

export type FieldComponent = FC<FieldProps> & {
  readonly errors: string[]
  readonly meta: Record<string, any>
  readonly value: any
  readonly dirty: boolean
  readonly elsewhere: import('./form-session.js').IncomingChange | undefined
  readonly ability: 'edit' | 'view'
}

/** A child form handle: full field access plus its identity + Remove. */
export type NestedFormHandle = FormHandle & {
  key: string
  isNew: boolean
  Remove: FC<{ children?: ReactNode }>
}

/**
 * `loan.assets` — callable with a render-prop, plus programmatic access.
 * Keys are internal (id / ephemeral _key) — the caller never writes `key=`.
 */
export type ArrayFieldHandle = FC<{ children: (child: NestedFormHandle) => ReactNode }> & {
  forms: NestedFormHandle[]
  add: (defaults?: Record<string, any>) => void
  /** Reorder for drag-and-drop: wire your DnD lib's onDrop to move(key, toIndex). */
  move: (key: string, toIndex: number) => void
  /** Flat snapshot of visible rows — for compact custom widgets (e.g. reactions). */
  rows: Array<{ key: string; isNew: boolean; data: Record<string, any> }>
  /** Change fields on a row; instant when the parent is persisted, else staged. */
  patch: (key: string, data: Record<string, any>) => void
  /** Remove a row; instant delete when the parent is persisted, else staged. */
  remove: (key: string) => void
  /** True when writes hit the backend immediately (parent persisted + instant meta). */
  instant: boolean
  /** Subscribe to row changes (for custom widgets that read `rows`). */
  use: () => void
  Add: FC<{ defaults?: Record<string, any>; children?: ReactNode; className?: string }>
}

/**
 * `deal.brief` (hasOne) — callable with a render-prop over the SINGLE child
 * handle; renders nothing while no child exists. `Build` is the singular Add.
 */
export type OneFieldHandle = FC<{ children: (child: NestedFormHandle) => ReactNode }> & {
  /** The child form handle, or null when no child exists (or it was removed). */
  form: NestedFormHandle | null
  /** True when a live child exists. */
  exists: boolean
  /** Ensure the child exists (no-op when it already does). */
  build: (defaults?: Record<string, any>) => void
  /** Remove the child; persisted children require allowDestroy. */
  remove: () => void
  /** Subscribe to child changes (for custom widgets reading `form`/`exists`). */
  use: () => void
  Build: FC<{ defaults?: Record<string, any>; children?: ReactNode; className?: string }>
}

/**
 * The non-field surface of a handle — generated typed handles compose this
 * with per-field TypedFieldComponents:
 *
 *   type LoanFormHandle = FormHandleApi<LoanClient> &
 *     { amount: TypedFieldComponent<'money'>; status: TypedFieldComponent<'state'> }
 */
export interface FormHandleApi<T extends Record<string, any> = Record<string, any>> {
  $session: FormSession<T>
  $draft: T
  $errors: Record<string, string[]>
  $dirty: boolean
  $status: SessionStatus
  $submit: (opts?: { event?: string }) => Promise<boolean>
  $can: (event: string) => boolean
  /** The server's fresh envelope from a 409 — null when not in conflict. */
  $conflict: import('./form-session.js').ServerEnvelope | null
  /** Exit a conflict: 'reload' takes the server's truth, 'overwrite' resubmits yours. */
  $resolveConflict: (mode: 'reload' | 'overwrite') => Promise<boolean>
  Form: FC<{ children?: ReactNode; onSuccess?: () => void; autosave?: boolean | { debounceMs?: number }; className?: string }>
  Submit: FC<{ children?: ReactNode; event?: string; className?: string }>
  /** Floating save affordance: saving… / saved ✓ / unsaved / offline / error. */
  SaveStatus: FC<{ className?: string; labels?: Partial<Record<'saving' | 'saved' | 'unsaved' | 'offline' | 'error' | 'conflict' | 'idle', string>> }>
  BaseErrors: FC<{ className?: string }>
  /** Renders ONLY while the session is in 409 conflict — the render-prop
   *  receives resolve('reload' | 'overwrite'). Style it however; the
   *  machinery (withheld token, fresh envelope) is already armed. */
  Conflict: FC<{ children: (resolve: (mode: 'reload' | 'overwrite') => Promise<boolean>) => ReactNode; className?: string }>
  /** Declarative gate over the SAME mask the server enforces: `edit` reads
   *  the abilities verdict for a field, `action` the can-map verdict for a
   *  state event or @mutation. Never trusted — the server re-checks. */
  Can: FC<{ edit?: string; action?: string; not?: boolean; fallback?: ReactNode; children?: ReactNode }>
  /** "Changes have happened" — renders only when rehydrate() adopted
   *  changes from elsewhere. Render-prop gets the affected field names +
   *  dismiss; without children a minimal default notice renders. */
  Changes: FC<{ children?: (info: { fields: string[]; dismiss: () => void }) => ReactNode; className?: string }>
}

/** Field props narrowed by the field's kind — presenter names are gated. */
export interface TypedFieldProps<K extends string> {
  edit?: boolean | import('./presenters.js').PresenterNameFor<K>
  view?: boolean | import('./presenters.js').PresenterNameFor<K>
  label?: string
  help?: string
  className?: string
  pendingIf?: (draft: any) => boolean
  pendingLabel?: string
  props?: Record<string, any>
}

export type TypedFieldComponent<K extends string> = FC<TypedFieldProps<K>> & {
  readonly errors: string[]
  readonly meta: Record<string, any>
  readonly value: any
}

export type FormHandle<T extends Record<string, any> = Record<string, any>> = {
  [K in keyof T & string]: FieldComponent
} & FormHandleApi<T>

/**
 * One bad bulb must not black out the house. Every Field renders inside its
 * own boundary: wiring mistakes (unregistered presenter, kind mismatch,
 * missing required meta) and presenter render crashes surface as an inline
 * teaching chip on THAT field — console.error'd for the terminal — while
 * every other field keeps working. The chip carries the full fix text, so
 * the error is MORE visible than a dev-overlay crash, not less.
 */
class FieldBoundary extends React.Component<
  { field: string; children?: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  override componentDidCatch(error: Error): void {
    console.error(`[active-drizzle] field "${this.props.field}" failed to render:`, error)
  }
  override render(): ReactNode {
    if (this.state.error) {
      return (
        <span role="alert" data-ad-field-error={this.props.field}>
          ⚠ {this.props.field}: {this.state.error.message}
        </span>
      )
    }
    return this.props.children
  }
}

/**
 * The bind a VIEW-rendered presenter receives: writes are refused with a
 * teaching warn instead of silently corrupting the draft. Without this, a
 * misbehaving view presenter could stage values the server will strip —
 * leaving the form dirty-forever against a field nobody may edit.
 */
function inertBind(field: string): PresenterBind {
  const refuse = (): void => {
    console.warn(
      `[active-drizzle] view-rendered field "${field}" received a write — refused. ` +
      `Render it with \`edit\` (and ensure the server grants 'edit') to accept input.`,
    )
  }
  return {
    name: field,
    onChange: refuse,
    onCommit: refuse,
    onBlur: () => {},
    onCompositionStart: () => {},
    onCompositionEnd: () => {},
    disabled: true,
  }
}

/** Resolve per-discriminant copy: meta.copy = { by, [LABEL]: overrides }. */
function resolveCopy(meta: Record<string, any>, draft: any): Record<string, any> {
  const copy = meta?.copy
  if (!copy?.by) return meta
  const disc = draft?.[copy.by]
  const overrides = disc != null ? copy[String(disc)] : undefined
  return overrides ? { ...meta, ...overrides } : meta
}

/**
 * The full presenter-props escape hatch: everything a generated Field
 * assembles for its presenter, as a HOOK — so a portal, a joint field, an
 * adapter, or any novel composition renders against the real contract.
 * Commit routing follows the surrounding <Form> context exactly like a
 * generated Field (hooks read context from where they RUN, so a portal
 * keeps its owner form's semantics).
 */
export function useFieldProps(
  form: { $session: FormSession<any> } | FormSession<any>,
  field: string,
  opts: { mode?: 'edit' | 'view'; commit?: 'change' | 'blur'; overrides?: Record<string, any> } = {},
): PresenterProps {
  const session: FormSession<any> =
    (form as any)?.$session ?? (form as FormSession<any>)
  useSyncExternalStore(
    (cb) => session.subscribe(field, cb),
    () => session.fieldVersion(field),
    () => session.fieldVersion(field),
  )
  const formCtx = useContext(FormModeContext)
  const commitViaContext = (f: string): void => {
    if (formCtx?.mode === 'autoflush') {
      session.touch(f)
      session.requestAutoFlush(formCtx.debounceMs)
    } else {
      void session.commitField(f, formCtx ? 'stage' : 'autosave')
    }
  }
  const fieldMeta: Record<string, any> =
    ((session.draft as any)?.constructor?.fieldMeta as Record<string, any>) ?? {}
  if (
    Object.keys(fieldMeta).length > 0
    && !(field in fieldMeta)
    && !(session.draft != null && field in (session.draft as any))
  ) {
    console.warn(`[active-drizzle] useFieldProps: "${field}" is not a field on this session's draft or meta — check the name.`)
  }
  const meta = resolveCopy(fieldMeta[field] ?? {}, session.draft)
  const bind = buildFieldBind(session, {
    field,
    ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
    onCommit: commitViaContext,
  })
  const incoming = session.getIncomingFor(field)
  return {
    value: session.getValue(field),
    bind,
    meta,
    overrides: opts.overrides ?? {},
    mode: opts.mode ?? (session.canEdit(field) ? 'edit' : 'view'),
    draft: session.draft,
    errors: session.visibleErrors(field),
    state: session.fieldState(field) !== 'ready' ? session.fieldState(field) : session.getStatus(),
    dirty: session.fieldDirty(field),
    ...(incoming !== undefined ? { elsewhere: incoming } : {}),
  }
}

export interface BuildFieldBindOptions {
  field: string
  /** Column actually written (attachment fields write `<name>AssetId(s)`). */
  writeField?: string
  /** The presenter's natural commit moment (default 'blur'). */
  commit?: 'change' | 'blur'
  /** What COMMIT does. Default: stage only (the session accumulates the
   *  diff). Generated Fields pass their <Form>-context commit here; a
   *  custom composition may pass its own. */
  onCommit?: (field: string) => void
  /** Attachment value mapping (asset object(s) → id(s) on write). */
  attachment?: 'one' | 'many'
  /** Extra disable signal (e.g. pendingIf's waiting). */
  disabled?: boolean
}

/**
 * The PUBLIC bind builder — the exact contract generated Fields wire into
 * presenters, exported so novel compositions (portals, joint fields,
 * adapters, tests, storybooks) build against the REAL thing instead of a
 * hand-rolled imitation: IME guards, data-ad-cancel blur-skip, commit
 * staging, disable rules — all included.
 */
export function buildFieldBind(session: FormSession<any>, opts: BuildFieldBindOptions): PresenterBind {
  const { field } = opts
  const writeField = opts.writeField ?? field
  const commitMoment = opts.commit ?? 'blur'
  const onCommit = opts.onCommit ?? (() => { /* stage-only: the diff waits for submit/flush */ })
  return {
    name: field,
    onChange: (value: any) => {
      // The mask is enforced at the PEN, not just the server: a write to a
      // field this session may not edit is refused with a teaching warn.
      // (The server would strip it anyway — but silently staging it would
      // leave the draft diverged and the form dirty-forever.)
      if (!session.canEdit(writeField)) {
        console.warn(
          `[active-drizzle] write to "${writeField}" refused — this session's abilities mark it ` +
          `'${session.canView(writeField) ? 'view' : 'absent'}'. The server grants edit via permit/access.`,
        )
        return
      }
      const written = !opts.attachment ? value
        : opts.attachment === 'many'
          ? (Array.isArray(value) ? value.map((v: any) => v?.id ?? v) : value)
          : value?.id ?? value
      session.setValue(writeField, written)
      if (commitMoment === 'change' && !session.isComposing(field)) onCommit(writeField)
    },
    onCommit: () => onCommit(writeField),
    onBlur: (e?: { relatedTarget?: any }) => {
      // C10: blur fires before a Cancel button's click — a blur INTO an
      // element marked data-ad-cancel must not autosave first
      const cancelIntent = Boolean(
        e?.relatedTarget?.closest?.('[data-ad-cancel]') ?? e?.relatedTarget?.dataset?.adCancel,
      )
      if (cancelIntent) session.touch(writeField)
      else onCommit(writeField)
    },
    onCompositionStart: () => session.beginComposition(field),
    onCompositionEnd: () => {
      // C11: IME composition commits once, at composition end
      session.endComposition(field)
      if (commitMoment === 'change') onCommit(writeField)
    },
    disabled: Boolean(opts.disabled) || session.getStatus() === 'saving' || session.fieldState(field) === 'saving',
  }
}

/**
 * A @mutation action wired onto the handle — `<deal.Archive/>` renders from
 * this. Paramless actions are plain verdict-aware buttons; actions with
 * declared params render an implicit mini-form (scaffolding inputs) unless
 * the call site pre-supplies `fields` or takes the render-prop.
 */
export interface FormActionMeta {
  label?: string
  params?: string[]
  required?: string[]
  /** POST transport for this action — wired by codegen. */
  transport: (data?: Record<string, any>) => Promise<any>
  /** Post-success hook — codegen routes coherence invalidation here. */
  onSuccess?: (result: any) => void
}

export interface ActionRenderApi {
  run: (data?: Record<string, any>) => Promise<boolean>
  /** Server verdict (envelope can map); ungoverned sessions default to allow. */
  allowed: boolean
  /** WHY not, in the server's own words — null when allowed/unexplained. */
  why: string | null
  pending: boolean
  errors: Record<string, string[]> | null
  label: string
  params: string[]
}

/** One TRUE-CONFLICT entry in <handle.Changes>: the server's value for a
 *  field you hold differently, when it changed, and a one-call adopt. */
export interface ChangeEntry {
  field: string
  label: string
  value: any
  at: string | number | null
  adopt: () => void
}

export interface ChangesRenderApi {
  /** Fields ADOPTED from elsewhere (clean fields that tracked the server). */
  fields: string[]
  /** Fields the server moved under your dirty draft — with adopt(). */
  changes: ChangeEntry[]
  /** Take theirs for every standing change (releases the withheld token). */
  adoptAll: () => void
  /** Presentation-only: clears both notices; a real conflict still 409s. */
  dismiss: () => void
}

export interface ActionProps {
  /** Pre-supplied param values — renders a plain button even when params exist. */
  fields?: Record<string, any>
  className?: string
  children?: ReactNode | ((api: ActionRenderApi) => ReactNode)
}

export function createFormHandle<T extends Record<string, any>>(
  session: FormSession<T>,
  options: {
    fieldMeta?: Record<string, Record<string, any>>
    /** Extra members merged into the handle (used for nested child handles). */
    extras?: Record<string, any>
    /** Instant nested transports keyed by child resource (from the generated hook). */
    nestedTransports?: Record<string, import('./nested.js').NestedTransport>
    /** @mutation actions — PascalCase members become verdict-aware buttons/mini-forms. */
    actions?: Record<string, FormActionMeta>
  } = {},
): FormHandle<T> {
  const fieldMeta: Record<string, Record<string, any>> =
    options.fieldMeta
    ?? ((session.draft as any)?.constructor?.fieldMeta as Record<string, Record<string, any>>)
    ?? {}
  const nestedTransports = options.nestedTransports ?? {}

  const cache = new Map<string, any>()

  // ── Nested attribute arrays: meta kind 'nested' → ArrayFieldHandle ───────
  const makeArrayHandle = (name: string, meta: Record<string, any>): ArrayFieldHandle => {
    const childFields = (meta.fields ?? {}) as Record<string, Record<string, any>>
    const instantTransport = meta.instant && meta.resource ? nestedTransports[meta.resource] : undefined
    const manager = new NestedArrayManager(
      session,
      name,
      (session.draft as any)[name],
      {
        ...(meta.validate ? { validate: meta.validate } : {}),
        nestedKeys: Object.keys(childFields).filter(
          k => childFields[k]?.kind === 'nested' || childFields[k]?.kind === 'nestedOne',
        ),
        ...(meta.orderBy ? { positionField: meta.orderBy } : {}),
        ...(meta.allowDestroy !== undefined ? { allowDestroy: Boolean(meta.allowDestroy) } : {}),
        ...(instantTransport ? { instant: true, transport: instantTransport, foreignKey: meta.foreignKey } : {}),
      },
    )
    session.registerNested(name, manager)

    const childHandles = new Map<string, NestedFormHandle>()
    const childHandle = (child: NestedChild): NestedFormHandle => {
      let h = childHandles.get(child.key)
      if (h) return h
      const RemoveComponent: FC<{ children?: ReactNode; className?: string }> = ({ children, className }) => {
        if (manager.isLocked()) return null
        // Persisted rows only expose Remove when the model opted into
        // allow_destroy; new rows are always droppable (nothing to destroy)
        if (!child.isNew && !manager.allowDestroy) return null
        return (
          <button type="button" {...(className !== undefined ? { className } : {})} onClick={() => manager.remove(child.key)}>
            {children ?? 'Remove'}
          </button>
        )
      }
      RemoveComponent.displayName = `AdRemove(${child.key})`
      // Grandchild instant transports flow down too (a note's reactions)
      h = createFormHandle(child.session as FormSession<any>, {
        fieldMeta: (meta.fields ?? {}) as Record<string, Record<string, any>>,
        extras: { key: child.key, isNew: child.isNew, Remove: RemoveComponent },
        nestedTransports,
      }) as NestedFormHandle
      childHandles.set(child.key, h)
      return h
    }

    const ArrayComponent: FC<{ children: (child: NestedFormHandle) => ReactNode }> = ({ children }) => {
      useSyncExternalStore(
        (cb) => session.subscribe(name, cb),
        () => session.fieldVersion(name),
        () => session.fieldVersion(name),
      )
      return (
        <>
          {manager.visible().map(child => (
            <Fragment key={child.key}>{children(childHandle(child))}</Fragment>
          ))}
        </>
      )
    }
    ;(ArrayComponent as any).displayName = `AdArray(${name})`

    const AddComponent: FC<{ defaults?: Record<string, any>; children?: ReactNode; className?: string }> = ({ defaults, children, className }) => {
      // Subscribes so a post-save envelope that locks the array hides Add live
      useSyncExternalStore(
        (cb) => session.subscribe(name, cb),
        () => session.fieldVersion(name),
        () => session.fieldVersion(name),
      )
      if (manager.isLocked()) return null
      return (
        <button type="button" {...(className !== undefined ? { className } : {})} onClick={() => manager.add(defaults)}>
          {children ?? 'Add'}
        </button>
      )
    }
    AddComponent.displayName = `AdAdd(${name})`

    const arrayHandle = ArrayComponent as ArrayFieldHandle
    Object.defineProperties(arrayHandle, {
      forms: { get: () => manager.visible().map(childHandle) },
      rows: { get: () => manager.rows() },
      instant: { get: () => manager.isInstant() },
      add: { value: (defaults?: Record<string, any>) => { manager.add(defaults) } },
      patch: { value: (key: string, data: Record<string, any>) => { manager.patch(key, data) } },
      remove: { value: (key: string) => { manager.remove(key) } },
      move: { value: (key: string, toIndex: number) => { manager.move(key, toIndex) } },
      // A hook custom widgets call to re-render on row changes (reactions bar)
      use: { value: () => {
        useSyncExternalStore(
          (cb) => session.subscribe(name, cb),
          () => session.fieldVersion(name),
          () => session.fieldVersion(name),
        )
      } },
      Add: { value: AddComponent },
    })
    return arrayHandle
  }

  // ── Singular nested form: meta kind 'nestedOne' → OneFieldHandle ─────────
  const makeOneHandle = (name: string, meta: Record<string, any>): OneFieldHandle => {
    const childFields = (meta.fields ?? {}) as Record<string, Record<string, any>>
    const manager = new NestedOneManager(
      session,
      name,
      (session.draft as any)[name],
      {
        ...(meta.validate ? { validate: meta.validate } : {}),
        nestedKeys: Object.keys(childFields).filter(
          k => childFields[k]?.kind === 'nested' || childFields[k]?.kind === 'nestedOne',
        ),
        ...(meta.allowDestroy !== undefined ? { allowDestroy: Boolean(meta.allowDestroy) } : {}),
      },
    )
    session.registerNested(name, manager)

    const childHandles = new Map<string, NestedFormHandle>()
    const childHandle = (child: NestedChild): NestedFormHandle => {
      let h = childHandles.get(child.key)
      if (h) return h
      const RemoveComponent: FC<{ children?: ReactNode; className?: string }> = ({ children, className }) => {
        if (manager.isLocked()) return null
        if (!child.isNew && !manager.allowDestroy) return null
        return (
          <button type="button" {...(className !== undefined ? { className } : {})} onClick={() => manager.remove()}>
            {children ?? 'Remove'}
          </button>
        )
      }
      RemoveComponent.displayName = `AdRemove(${name})`
      h = createFormHandle(child.session as FormSession<any>, {
        fieldMeta: childFields,
        extras: { key: child.key, isNew: child.isNew, Remove: RemoveComponent },
        nestedTransports,
      }) as NestedFormHandle
      childHandles.set(child.key, h)
      return h
    }

    const OneComponent: FC<{ children: (child: NestedFormHandle) => ReactNode }> = ({ children }) => {
      useSyncExternalStore(
        (cb) => session.subscribe(name, cb),
        () => session.fieldVersion(name),
        () => session.fieldVersion(name),
      )
      const child = manager.current()
      if (!child) return null
      return <>{children(childHandle(child))}</>
    }
    ;(OneComponent as any).displayName = `AdOne(${name})`

    const BuildComponent: FC<{ defaults?: Record<string, any>; children?: ReactNode; className?: string }> = ({ defaults, children, className }) => {
      useSyncExternalStore(
        (cb) => session.subscribe(name, cb),
        () => session.fieldVersion(name),
        () => session.fieldVersion(name),
      )
      // Hidden while a child exists — there is only ever one to build
      if (manager.isLocked() || manager.current()) return null
      return (
        <button type="button" {...(className !== undefined ? { className } : {})} onClick={() => manager.build(defaults)}>
          {children ?? 'Add'}
        </button>
      )
    }
    BuildComponent.displayName = `AdBuild(${name})`

    const oneHandle = OneComponent as OneFieldHandle
    Object.defineProperties(oneHandle, {
      form: { get: () => { const c = manager.current(); return c ? childHandle(c) : null } },
      exists: { get: () => manager.current() !== null },
      build: { value: (defaults?: Record<string, any>) => { manager.build(defaults) } },
      remove: { value: () => { manager.remove() } },
      use: { value: () => {
        useSyncExternalStore(
          (cb) => session.subscribe(name, cb),
          () => session.fieldVersion(name),
          () => session.fieldVersion(name),
        )
      } },
      Build: { value: BuildComponent },
    })
    return oneHandle
  }

  const makeFieldComponent = (field: string): FieldComponent => {
    // A field whose visibility/lock/copy depends on OTHER fields (presentIf,
    // requiredIf, lockedIf, copy.by) must re-render when they change — it
    // subscribes to the session-wide channel. Plain fields subscribe only to
    // themselves, keeping keystrokes single-field re-renders.
    const staticMeta = fieldMeta[field] ?? {}
    // Association sugar: a 'ref' field is the FK column wearing the
    // association's name; a 'refMany' field is the habtm `<singular>Ids`
    // set. Value, writes, abilities mask, and errors all alias to the
    // underlying wire key (same trick as attachment `<name>AssetId` below)
    const aliasKey = staticMeta.kind === 'ref' && typeof staticMeta.fk === 'string' ? staticMeta.fk
      : staticMeta.kind === 'refMany' && typeof staticMeta.ids === 'string' ? staticMeta.ids
      : null
    const dataField = (aliasKey as string | null) ?? field
    const dependsOnOthers = Boolean(
      staticMeta.presentIf || staticMeta.requiredIf || staticMeta.lockedIf || staticMeta.copy,
    )

    const FieldInner: FC<FieldProps> = (props) => {
      // pendingIf reads OTHER fields at render time → session-wide channel,
      // same rule as presentIf/lockedIf (dynamic per call site)
      const channel = dependsOnOthers || props.pendingIf ? '*' : dataField
      useSyncExternalStore(
        (cb) => session.subscribe(channel, cb),
        () => session.fieldVersion(channel),
        () => session.fieldVersion(channel),
      )
      const formCtx = useContext(FormModeContext)
      // Route a commit by context: autoflush stages + schedules the whole-
      // diff flush; stage just stages; no Form → per-field autosave PATCH
      const commitViaContext = (f: string): void => {
        if (formCtx?.mode === 'autoflush') {
          session.touch(f)
          session.requestAutoFlush(formCtx.debounceMs)
        } else {
          void session.commitField(f, formCtx ? 'stage' : 'autosave')
        }
      }

      const rawMeta = fieldMeta[field] ?? {}
      let meta = resolveCopy(rawMeta, session.draft)

      // WAITING: the backend owns this field right now (job, import). The
      // presenter renders with state='waiting' + meta.pendingLabel; input
      // disables. A throwing predicate degrades to not-waiting.
      let waiting = false
      if (typeof props.pendingIf === 'function') {
        try { waiting = Boolean(props.pendingIf(session.draft)) } catch { waiting = false }
      }
      if (props.pendingLabel !== undefined) meta = { ...meta, pendingLabel: props.pendingLabel }

      // Attachment fields READ the loaded asset payload but WRITE the
      // `<name>AssetId(s)` column the controller actually permits — the
      // presenter deals in assets, the wire deals in ids, nobody wires it
      const isAttachment = meta.kind === 'attachmentOne' || meta.kind === 'attachmentMany'
      const writeField = !isAttachment ? dataField
        : meta.kind === 'attachmentOne' ? `${field}AssetId` : `${field}AssetIds`

      // Visibility: server mask first, then presentIf over the draft (C6:
      // hiding never loses the value — it lives on the draft, not here).
      // Attachments alias like ref fields do: the envelope's abilities key
      // the WRITE column (`logoAssetId`), the presenter wears the name —
      // either key grants visibility.
      if (!session.canView(dataField) && !(isAttachment && session.canView(writeField))) return null
      if (typeof meta.presentIf === 'function' && !meta.presentIf(session.draft)) return null

      const locked = typeof meta.lockedIf === 'function' && Boolean(meta.lockedIf(session.draft))
      // Bare `view` (JSX boolean true) means "the DEFAULT view presenter" —
      // symmetric with bare `edit`; only a STRING names an override
      const viewOverride = typeof props.view === 'string' ? props.view : undefined
      const resolved = resolvePresenter({
        field,
        kind: meta.kind ?? null,
        meta,
        ...(props.edit !== undefined ? { edit: props.edit } : {}),
        ...(viewOverride !== undefined ? { view: viewOverride } : {}),
        // Editability is judged on the column the server actually permits —
        // for attachments that is `<name>AssetId(s)`, never the display name
        canEdit: session.canEdit(isAttachment ? writeField : dataField),
        locked,
      })
      if (!resolved) return null
      checkRequiredMeta(resolved.name, resolved.def, field, meta)

      // One bind implementation for everyone — the same builder is exported
      // (buildFieldBind) so custom compositions share this exact contract.
      // View renders get an INERT bind: a view presenter has no pen, so it
      // cannot corrupt the draft no matter how it misbehaves.
      const bind: PresenterBind = resolved.mode === 'edit'
        ? buildFieldBind(session, {
            field: dataField,
            writeField,
            commit: resolved.def.commit ?? 'blur',
            onCommit: commitViaContext,
            ...(isAttachment ? { attachment: meta.kind === 'attachmentMany' ? 'many' as const : 'one' as const } : {}),
            disabled: waiting,
          })
        : inertBind(dataField)

      const overrides: Record<string, any> = { ...(props.props ?? {}) }
      if (props.label !== undefined) overrides.label = props.label
      if (props.help !== undefined) overrides.help = props.help
      if (props.className !== undefined) overrides.className = props.className

      const Component = resolved.def.component
      const incoming = session.getIncomingFor(dataField)
      return (
        <Component
          value={session.getValue(dataField)}
          bind={bind}
          meta={meta}
          overrides={overrides}
          mode={resolved.mode}
          draft={session.draft}
          errors={session.visibleErrors(dataField)}
          state={waiting ? 'waiting'
            : session.fieldState(dataField) !== 'ready' ? session.fieldState(dataField)
            : session.getStatus()}
          dirty={session.fieldDirty(dataField)}
          {...(incoming !== undefined ? { elsewhere: incoming } : {})}
        />
      )
    }
    FieldInner.displayName = `Field(${field})`

    const Field: FC<FieldProps> = (props) => (
      <FieldBoundary field={field}>
        <FieldInner {...props} />
      </FieldBoundary>
    )
    Field.displayName = `FieldGuard(${field})`

    Object.defineProperties(Field, {
      errors: { get: () => session.visibleErrors(dataField) },
      meta: { get: () => resolveCopy(fieldMeta[field] ?? {}, session.draft) },
      value: { get: () => session.getValue(dataField) },
      // Read parity with what the presenter receives — a footer counting
      // unsaved fields or a conflict summary reads the handle, not $session
      dirty: { get: () => session.fieldDirty(dataField) },
      elsewhere: { get: () => session.getIncomingFor(dataField) },
      ability: { get: () => (session.canEdit(dataField) ? 'edit' : 'view') as 'edit' | 'view' },
    })
    return Field as FieldComponent
  }

  // A typo'd member (`handle.naem`) — loud, visible, and helpful at FIRST
  // touch: console teaching error with did-you-mean, an inline chip when
  // rendered, and safe defaults for programmatic reads (no crashes deep in
  // someone's footer that counts dirty fields).
  const makeUnknownFieldComponent = (prop: string): FieldComponent => {
    const candidates = [
      ...Object.keys(fieldMeta),
      ...Object.keys((session.draft as any) ?? {}),
    ]
    const nearest = [...new Set(candidates)]
      .map(c => ({ c, d: editDistance(prop.toLowerCase(), c.toLowerCase()) }))
      .filter(x => x.d <= 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map(x => x.c)
    const hint = nearest.length
      ? `Did you mean ${nearest.map(n => `"${n}"`).join(' or ')}?`
      : `Declared fields: ${Object.keys(fieldMeta).slice(0, 8).join(', ')}${Object.keys(fieldMeta).length > 8 ? ', …' : ''}`
    const message = `"${prop}" is not a field on this form. ${hint}`
    console.error(`[active-drizzle] ${message}`)
    const Unknown: FC<FieldProps> = () => (
      <span role="alert" data-ad-unknown-field={prop}>⚠ {message}</span>
    )
    Unknown.displayName = `UnknownField(${prop})`
    Object.defineProperties(Unknown, {
      errors: { get: () => [] },
      meta: { get: () => ({}) },
      value: { get: () => undefined },
      dirty: { get: () => false },
      elsewhere: { get: () => undefined },
      ability: { get: () => 'view' as const },
    })
    return Unknown as FieldComponent
  }

  const FormComponent: FC<{ children?: ReactNode; onSuccess?: () => void; autosave?: boolean | { debounceMs?: number }; className?: string }> = ({ children, onSuccess, autosave, className }) => {
    const auto = Boolean(autosave)
    const debounceMs = typeof autosave === 'object' && autosave?.debounceMs !== undefined ? autosave.debounceMs : 400
    // Offline autosave: when connectivity returns, retry queued work.
    // The whole "orchestrator" — one listener, kept deliberately tiny.
    // Unmount also cancels any armed flush — no stale timers firing.
    useEffect(() => {
      if (!auto || typeof window === 'undefined') return
      const onOnline = () => void session.flushPending()
      window.addEventListener('online', onOnline)
      return () => {
        window.removeEventListener('online', onOnline)
        session.cancelAutoFlush()
      }
    }, [auto])

    const submitThroughForm = async (opts?: { event?: string }) => {
      const ok = await session.submit(opts ?? {})
      if (ok) onSuccess?.()
      return ok
    }
    return (
      <FormModeContext.Provider value={auto ? { mode: 'autoflush', debounceMs } : { mode: 'stage', debounceMs: 0 }}>
        <FormSubmitContext.Provider value={submitThroughForm}>
          <form
            {...(className !== undefined ? { className } : {})}
            onSubmit={(e) => {
              e.preventDefault()
              void submitThroughForm()
            }}
          >
            {children}
          </form>
        </FormSubmitContext.Provider>
      </FormModeContext.Provider>
    )
  }
  FormComponent.displayName = 'AdForm'

  const SubmitComponent: FC<{ children?: ReactNode; event?: string; className?: string }> = ({ children, event, className }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    // Inside a Form, route through its pipeline so onSuccess fires;
    // standalone buttons submit the session directly
    const formSubmit = useContext(FormSubmitContext)
    const status = session.getStatus()
    const saving = status === 'saving'
    // Event buttons carry the server's can verdict; plain submit only
    // disables while in flight
    const disabled = saving || (event !== undefined && !session.can(event))
    const doSubmit = formSubmit ?? ((opts?: { event?: string }) => session.submit(opts ?? {}))
    return (
      <button
        type="button"
        {...(className !== undefined ? { className } : {})}
        disabled={disabled}
        aria-busy={saving || undefined}
        data-status={status}
        onClick={() => void doSubmit(event !== undefined ? { event } : undefined)}
      >
        {children ?? 'Save'}
      </button>
    )
  }
  SubmitComponent.displayName = 'AdSubmit'

  /**
   * The floating save affordance — autosave forms have no Save button, so
   * THIS is how persistence stays legible: "Saving…" → "Saved ✓", with
   * distinct states for unsaved, offline-queued, and rejected work. Headless
   * beyond a default label set: style via className + [data-state], or
   * override labels per state.
   */
  const SaveStatusComponent: FC<{ className?: string; labels?: Partial<Record<'saving' | 'saved' | 'unsaved' | 'offline' | 'error' | 'conflict' | 'idle', string>> }> = ({ className, labels }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    const st = session.getStatus()
    const state: 'saving' | 'saved' | 'unsaved' | 'offline' | 'error' | 'conflict' | 'idle' =
      st === 'saving' ? 'saving'
      : st === 'conflict' ? 'conflict'
      : session.hasPending() ? 'offline'
      : st === 'error' || st === 'unauthenticated' ? 'error'
      : session.isDirty() ? 'unsaved'
      : session.getLastSavedAt() !== null ? 'saved'
      : 'idle'
    const DEFAULTS: Record<typeof state, string> = {
      saving: 'Saving…',
      saved: 'Saved ✓',
      unsaved: 'Unsaved changes',
      offline: 'Offline — changes queued',
      error: "Couldn't save",
      conflict: 'Changed elsewhere',
      idle: '',
    }
    const text = labels?.[state] ?? DEFAULTS[state]
    if (!text) return null
    return (
      <span role="status" data-state={state} {...(className !== undefined ? { className } : {})}>
        {text}
      </span>
    )
  }
  SaveStatusComponent.displayName = 'AdSaveStatus'

  const ConflictComponent: FC<{ children: (resolve: (mode: 'reload' | 'overwrite') => Promise<boolean>) => ReactNode; className?: string }> = ({ children, className }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    if (session.getStatus() !== 'conflict') return null
    return (
      <div role="alertdialog" {...(className !== undefined ? { className } : {})}>
        {children((mode) => session.resolveConflict(mode))}
      </div>
    )
  }
  ConflictComponent.displayName = 'AdConflict'

  // <deal.Can edit="amount"> / <deal.Can action="markWon" not fallback={…}> —
  // hide/swap UI from the envelope's own verdicts; zero hardcoded roles
  const CanComponent: FC<{ edit?: string; action?: string; not?: boolean; fallback?: ReactNode; children?: ReactNode | ((s: { allowed: boolean; why: string | null }) => ReactNode) }> = ({ edit, action, not, fallback, children }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    let allowed = true
    if (edit !== undefined) allowed = session.canEdit(edit)
    else if (action !== undefined) allowed = session.verdict(action)
    if (not) allowed = !allowed
    const why = action !== undefined ? session.whyNot(action) : null
    if (typeof children === 'function') return <>{children({ allowed, why })}</>
    return <>{allowed ? children : fallback ?? null}</>
  }
  CanComponent.displayName = 'AdCan'

  const ChangesComponent: FC<{ children?: (info: ChangesRenderApi) => ReactNode; className?: string }> = ({ children, className }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    const fields = session.getRecentChanges()
    // The floater's fat half: TRUE-CONFLICT fields with the server's value,
    // when it changed, and a per-field adopt — same map the `elsewhere`
    // presenter prop reads, so the two surfaces can never disagree
    const changes: ChangeEntry[] = Object.entries(session.getIncoming()).map(([field, inc]) => ({
      field,
      label: (fieldMeta[field]?.label as string | undefined) ?? field,
      value: inc.value,
      at: inc.at,
      adopt: () => session.adoptIncoming(field),
    }))
    const adoptAll = () => session.adoptAllIncoming()
    const dismiss = () => { session.dismissRecentChanges(); session.dismissIncoming() }
    if (!fields.length && !changes.length) return null
    if (children) {
      return <div role="status" data-ad-changes {...(className !== undefined ? { className } : {})}>{children({ fields, dismiss, changes, adoptAll })}</div>
    }
    return (
      <div role="status" data-ad-changes {...(className !== undefined ? { className } : {})}>
        {fields.length > 0 && <>Updated elsewhere: {fields.join(', ')}{' '}</>}
        {changes.map((c) => (
          <span key={c.field} data-ad-change={c.field}>
            {c.label} → {String(c.value)}{' '}
            <button type="button" onClick={c.adopt}>take theirs</button>{' '}
          </span>
        ))}
        {changes.length > 1 && <button type="button" onClick={adoptAll}>take all</button>}{' '}
        <button type="button" onClick={dismiss}>✕</button>
      </div>
    )
  }
  ChangesComponent.displayName = 'AdChanges'

  const BaseErrorsComponent: FC<{ className?: string }> = ({ className }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    const base = session.baseErrors()
    if (base.length === 0) return null
    return (
      <div role="alert" {...(className !== undefined ? { className } : {})}>
        {base.map((msg, i) => <p key={i}>{msg}</p>)}
      </div>
    )
  }
  BaseErrorsComponent.displayName = 'AdBaseErrors'

  // ── @mutation action components — the button IS a presenter ─────────────
  // Verdict-aware (envelope can map → greyed, server re-enforces at dispatch),
  // coherence-wired (onSuccess), and envelope-folding (a returned envelope
  // rehydrates the live session: fields, abilities, and verdicts re-mask).
  const makeActionComponent = (name: string, meta: FormActionMeta): FC<ActionProps> => {
    const label = meta.label ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
    const params = meta.params ?? []
    const Action: FC<ActionProps> = ({ fields, className, children }) => {
      useSyncExternalStore(
        (cb) => session.subscribe('*', cb),
        () => session.fieldVersion('*'),
        () => session.fieldVersion('*'),
      )
      const [pending, setPending] = useState(false)
      const [errors, setErrors] = useState<Record<string, string[]> | null>(null)
      const [values, setValues] = useState<Record<string, any>>({})
      const allowed = session.verdict(name)
      const why = session.whyNot(name)

      const run = async (data?: Record<string, any>): Promise<boolean> => {
        if (pending) return false
        setPending(true); setErrors(null)
        try {
          const res = await meta.transport(data)
          if (res && typeof res === 'object' && 'record' in res) session.rehydrate(res)
          meta.onSuccess?.(res)
          session.notifyAction(name, true)
          setValues({})
          return true
        } catch (e) {
          const parsed = parseControllerError(e)
          setErrors(parsed?.fields ?? { base: [parsed?.message ?? 'Action failed'] })
          session.notifyAction(name, false)
          return false
        } finally { setPending(false) }
      }

      if (typeof children === 'function') {
        return <>{(children as (api: ActionRenderApi) => ReactNode)({ run, allowed, pending, errors, label, params, why })}</>
      }

      // No declared params (or all pre-supplied) → plain verdict-aware button
      if (params.length === 0 || fields) {
        return (
          <span data-ad-action={name}>
            <button type="button" {...(className !== undefined ? { className } : {})}
              disabled={!allowed || pending}
              {...(!allowed && why ? { title: why } : {})}
              onClick={() => void run(fields)}>
              {children ?? label}
            </button>
            {errors && <span role="alert" data-ad-action-error="">{Object.values(errors).flat().join(' · ')}</span>}
          </span>
        )
      }

      // Declared params, nothing supplied → implicit mini-form. The inputs
      // are SCAFFOLDING (like unregistered filter presenters) — real apps
      // pre-supply `fields` or take the render-prop
      const baseMsgs = errors?.['base'] ?? []
      return (
        <span data-ad-action={name} data-ad-scaffold="" {...(className !== undefined ? { className } : {})}>
          {params.map((p) => (
            <label key={p}> {p}
              <input value={values[p] ?? ''} disabled={!allowed || pending}
                onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))} />
              {errors?.[p] && <span role="alert">{errors[p]!.join(', ')}</span>}
            </label>
          ))}
          <button type="button" disabled={!allowed || pending} onClick={() => void run(values)}>{label}</button>
          {baseMsgs.length > 0 && <span role="alert" data-ad-action-error="">{baseMsgs.join(' · ')}</span>}
        </span>
      )
    }
    Action.displayName = `AdAction(${name})`
    return Action
  }

  const target = {} as FormHandle<T>

  return new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined
      switch (prop) {
        // A civil primitive path — `${handle}` in a log must neither invoke
        // a component nor throw "cannot convert object to primitive"
        case 'toString': case 'toLocaleString': return () => '[FormHandle]'
        case 'valueOf': return () => '[FormHandle]'
        case '$session': return session
        case '$draft': return session.draft
        case '$errors': return session.allErrors()
        case '$dirty': return session.isDirty()
        case '$status': return session.getStatus()
        case '$submit': return (opts?: { event?: string }) => session.submit(opts)
        case '$can': return (event: string) => session.can(event)
        case '$conflict': return session.getConflict()
        case '$resolveConflict': return (mode: 'reload' | 'overwrite') => session.resolveConflict(mode)
        case 'Form': return FormComponent
        case 'Submit': return SubmitComponent
        case 'SaveStatus': return SaveStatusComponent
        case 'BaseErrors': return BaseErrorsComponent
        case 'Conflict': return ConflictComponent
        case 'Changes': return ChangesComponent
        case 'Can': return CanComponent
        // React/JS runtime probes that must not become field components.
        // Without this, `${handle}` would resolve toString to a Field and
        // invoke a React component as a plain function.
        case 'then': case 'toJSON': case '$$typeof':
        case 'constructor': case 'hasOwnProperty': case 'isPrototypeOf':
        case 'propertyIsEnumerable': case 'displayName':
          return undefined
      }
      if (options.extras && prop in options.extras) return options.extras[prop]
      // PascalCase @mutation members: <deal.Archive/> ← actions['archive']
      if (options.actions && /^[A-Z]/.test(prop)) {
        const actionName = prop[0]!.toLowerCase() + prop.slice(1)
        const actionMeta = options.actions[actionName]
        if (actionMeta) {
          let a = cache.get(prop)
          if (!a) { a = makeActionComponent(actionName, actionMeta); cache.set(prop, a) }
          return a
        }
      }
      if (prop.startsWith('$') || prop.startsWith('_')) return undefined
      // A member that is neither declared meta nor a draft key is a TYPO.
      // Generated typed handles catch this at compile; untyped handles get
      // the same protection at first touch — a did-you-mean chip instead of
      // a misleading "no view presenter for naem". Only enforced when the
      // handle HAS field meta (bare ad-hoc handles stay permissive).
      const declared = prop in fieldMeta
        || (session.draft != null && prop in (session.draft as any))
      if (!declared && Object.keys(fieldMeta).length > 0) {
        let unknown = cache.get(prop)
        if (!unknown) { unknown = makeUnknownFieldComponent(prop); cache.set(prop, unknown) }
        return unknown
      }
      let field = cache.get(prop)
      if (!field) {
        field = fieldMeta[prop]?.kind === 'nested'
          ? makeArrayHandle(prop, fieldMeta[prop]!)
          : fieldMeta[prop]?.kind === 'nestedOne'
          ? makeOneHandle(prop, fieldMeta[prop]!)
          : makeFieldComponent(prop)
        cache.set(prop, field)
      }
      return field
    },
  })
}

/** Tiny edit distance for did-you-mean (cap 2 — beyond that it's noise). */
function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}
