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
import React, { createContext, useContext, useEffect, useSyncExternalStore, Fragment, type FC, type ReactNode } from 'react'
import { FormSession, type SessionStatus } from './form-session.js'
import { NestedArrayManager, type NestedChild } from './nested.js'
import { resolvePresenter, checkRequiredMeta, type PresenterBind } from './presenters.js'

/**
 * Context decides what COMMIT does — the presenter never knows:
 *   inside <Form>          → 'stage'    (batch; Submit sends the diff)
 *   inside <Form autosave> → 'autosave' (single-field PATCH per commit)
 *   no Form at all         → 'autosave' by definition (the handle owns the
 *                            transport; without one, commits just stage)
 */
const FormModeContext = createContext<'stage' | 'autosave' | null>(null)

/** The enclosing Form's submit pipeline — Submit buttons route through it so onSuccess fires. */
const FormSubmitContext = createContext<((opts?: { event?: string }) => Promise<boolean>) | null>(null)

export interface FieldProps {
  /** absent → view · true → Attr/default edit presenter · string → named override. Never inferred. */
  edit?: boolean | string
  /** string → named view presenter override. */
  view?: string
  label?: string
  help?: string
  /** Passed through to the presenter via overrides — Tailwind/etc. just works. */
  className?: string
  /** Extra props passed through to the presenter. */
  props?: Record<string, any>
}

export type FieldComponent = FC<FieldProps> & {
  readonly errors: string[]
  readonly meta: Record<string, any>
  readonly value: any
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
  Form: FC<{ children?: ReactNode; onSuccess?: () => void; autosave?: boolean }>
  Submit: FC<{ children?: ReactNode; event?: string }>
  BaseErrors: FC
}

/** Field props narrowed by the field's kind — presenter names are gated. */
export interface TypedFieldProps<K extends string> {
  edit?: boolean | import('./presenters.js').PresenterNameFor<K>
  view?: import('./presenters.js').PresenterNameFor<K>
  label?: string
  help?: string
  className?: string
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

/** Resolve per-discriminant copy: meta.copy = { by, [LABEL]: overrides }. */
function resolveCopy(meta: Record<string, any>, draft: any): Record<string, any> {
  const copy = meta?.copy
  if (!copy?.by) return meta
  const disc = draft?.[copy.by]
  const overrides = disc != null ? copy[String(disc)] : undefined
  return overrides ? { ...meta, ...overrides } : meta
}

export function createFormHandle<T extends Record<string, any>>(
  session: FormSession<T>,
  options: {
    fieldMeta?: Record<string, Record<string, any>>
    /** Extra members merged into the handle (used for nested child handles). */
    extras?: Record<string, any>
    /** Instant nested transports keyed by child resource (from the generated hook). */
    nestedTransports?: Record<string, import('./nested.js').NestedTransport>
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
        nestedKeys: Object.keys(childFields).filter(k => childFields[k]?.kind === 'nested'),
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

  const makeFieldComponent = (field: string): FieldComponent => {
    // A field whose visibility/lock/copy depends on OTHER fields (presentIf,
    // requiredIf, lockedIf, copy.by) must re-render when they change — it
    // subscribes to the session-wide channel. Plain fields subscribe only to
    // themselves, keeping keystrokes single-field re-renders.
    const staticMeta = fieldMeta[field] ?? {}
    const dependsOnOthers = Boolean(
      staticMeta.presentIf || staticMeta.requiredIf || staticMeta.lockedIf || staticMeta.copy,
    )
    const channel = dependsOnOthers ? '*' : field

    const Field: FC<FieldProps> = (props) => {
      useSyncExternalStore(
        (cb) => session.subscribe(channel, cb),
        () => session.fieldVersion(channel),
        () => session.fieldVersion(channel),
      )
      const contextMode = useContext(FormModeContext)
      const commitMode: 'stage' | 'autosave' = contextMode ?? 'autosave'

      const rawMeta = fieldMeta[field] ?? {}
      const meta = resolveCopy(rawMeta, session.draft)

      // Visibility: server mask first, then presentIf over the draft (C6:
      // hiding never loses the value — it lives on the draft, not here)
      if (!session.canView(field)) return null
      if (typeof meta.presentIf === 'function' && !meta.presentIf(session.draft)) return null

      const locked = typeof meta.lockedIf === 'function' && Boolean(meta.lockedIf(session.draft))
      const resolved = resolvePresenter({
        field,
        kind: meta.kind ?? null,
        meta,
        ...(props.edit !== undefined ? { edit: props.edit } : {}),
        ...(props.view !== undefined ? { view: props.view } : {}),
        canEdit: session.canEdit(field),
        locked,
      })
      if (!resolved) return null
      checkRequiredMeta(resolved.name, resolved.def, field, meta)

      // Attachment fields READ the loaded asset payload but WRITE the
      // `<name>AssetId(s)` column the controller actually permits — the
      // presenter deals in assets, the wire deals in ids, nobody wires it
      const isAttachment = meta.kind === 'attachmentOne' || meta.kind === 'attachmentMany'
      const writeField = !isAttachment ? field
        : meta.kind === 'attachmentOne' ? `${field}AssetId` : `${field}AssetIds`

      const commitMoment = resolved.def.commit ?? 'blur'
      const bind: PresenterBind = {
        name: field,
        onChange: (value: any) => {
          // Presenters may pass an asset object/array or raw id(s)
          const written = !isAttachment ? value
            : Array.isArray(value) ? value.map((v: any) => v?.id ?? v)
            : value?.id ?? value
          session.setValue(writeField, written)
          // Discrete inputs (toggle/select) commit on change — instant
          // autosave in autosave contexts, staged + errors-visible otherwise
          if (commitMoment === 'change') void session.commitField(writeField, commitMode)
        },
        onCommit: () => void session.commitField(writeField, commitMode),
        onBlur: (e?: { relatedTarget?: any }) => {
          // C10: blur fires before a Cancel button's click — a blur INTO an
          // element marked data-ad-cancel must not autosave first
          const cancelIntent = Boolean(
            e?.relatedTarget?.closest?.('[data-ad-cancel]') ?? e?.relatedTarget?.dataset?.adCancel,
          )
          if (cancelIntent) session.touch(writeField)
          else void session.commitField(writeField, commitMode)
        },
        onCompositionStart: () => session.beginComposition(field),
        onCompositionEnd: () => {
          // C11: IME composition commits once, at composition end
          session.endComposition(field)
          if (commitMoment === 'change') void session.commitField(field, commitMode)
        },
        disabled: session.getStatus() === 'saving' || session.fieldState(field) === 'saving',
      }

      const overrides: Record<string, any> = { ...(props.props ?? {}) }
      if (props.label !== undefined) overrides.label = props.label
      if (props.help !== undefined) overrides.help = props.help
      if (props.className !== undefined) overrides.className = props.className

      const Component = resolved.def.component
      return (
        <Component
          value={session.getValue(field)}
          bind={bind}
          meta={meta}
          overrides={overrides}
          mode={resolved.mode}
          draft={session.draft}
          errors={session.visibleErrors(field)}
          state={session.fieldState(field) !== 'ready' ? session.fieldState(field) : session.getStatus()}
        />
      )
    }
    Field.displayName = `Field(${field})`

    Object.defineProperties(Field, {
      errors: { get: () => session.visibleErrors(field) },
      meta: { get: () => resolveCopy(fieldMeta[field] ?? {}, session.draft) },
      value: { get: () => session.getValue(field) },
    })
    return Field as FieldComponent
  }

  const FormComponent: FC<{ children?: ReactNode; onSuccess?: () => void; autosave?: boolean; className?: string }> = ({ children, onSuccess, autosave, className }) => {
    // Offline autosave: when connectivity returns, retry any queued deltas.
    // The whole "orchestrator" — one listener, kept deliberately tiny.
    useEffect(() => {
      if (!autosave || typeof window === 'undefined') return
      const onOnline = () => void session.flushPending()
      window.addEventListener('online', onOnline)
      return () => window.removeEventListener('online', onOnline)
    }, [autosave])

    const submitThroughForm = async (opts?: { event?: string }) => {
      const ok = await session.submit(opts ?? {})
      if (ok) onSuccess?.()
      return ok
    }
    return (
      <FormModeContext.Provider value={autosave ? 'autosave' : 'stage'}>
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
        case 'Form': return FormComponent
        case 'Submit': return SubmitComponent
        case 'BaseErrors': return BaseErrorsComponent
        // React/JS runtime probes that must not become field components.
        // Without this, `${handle}` would resolve toString to a Field and
        // invoke a React component as a plain function.
        case 'then': case 'toJSON': case '$$typeof':
        case 'constructor': case 'hasOwnProperty': case 'isPrototypeOf':
        case 'propertyIsEnumerable': case 'displayName':
          return undefined
      }
      if (options.extras && prop in options.extras) return options.extras[prop]
      if (prop.startsWith('$') || prop.startsWith('_')) return undefined
      let field = cache.get(prop)
      if (!field) {
        field = fieldMeta[prop]?.kind === 'nested'
          ? makeArrayHandle(prop, fieldMeta[prop]!)
          : makeFieldComponent(prop)
        cache.set(prop, field)
      }
      return field
    },
  })
}
