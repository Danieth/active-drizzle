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
import React, { useSyncExternalStore, type FC, type ReactNode } from 'react'
import { FormSession, type SessionStatus } from './form-session.js'
import { resolvePresenter, checkRequiredMeta, type PresenterBind } from './presenters.js'

export interface FieldProps {
  /** absent → view · true → Attr/default edit presenter · string → named override. Never inferred. */
  edit?: boolean | string
  /** string → named view presenter override. */
  view?: string
  label?: string
  help?: string
  /** Extra props passed through to the presenter. */
  props?: Record<string, any>
}

export type FieldComponent = FC<FieldProps> & {
  readonly errors: string[]
  readonly meta: Record<string, any>
  readonly value: any
}

export type FormHandle<T extends Record<string, any> = Record<string, any>> = {
  [K in keyof T & string]: FieldComponent
} & {
  $session: FormSession<T>
  $draft: T
  $errors: Record<string, string[]>
  $dirty: boolean
  $status: SessionStatus
  $version: string | null
  $submit: (opts?: { event?: string }) => Promise<boolean>
  $can: (event: string) => boolean
  Form: FC<{ children?: ReactNode; onSuccess?: () => void }>
  Submit: FC<{ children?: ReactNode; event?: string }>
  BaseErrors: FC
}

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
  options: { fieldMeta?: Record<string, Record<string, any>> } = {},
): FormHandle<T> {
  const fieldMeta: Record<string, Record<string, any>> =
    options.fieldMeta
    ?? ((session.draft as any)?.constructor?.fieldMeta as Record<string, Record<string, any>>)
    ?? {}

  const cache = new Map<string, any>()

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

      const commitMoment = resolved.def.commit ?? 'blur'
      const bind: PresenterBind = {
        name: field,
        onChange: (value: any) => {
          session.setValue(field, value)
          // Discrete inputs (toggle/select) commit on change — errors become
          // visible immediately, and autosave contexts will PATCH here (M4)
          if (commitMoment === 'change') session.touch(field)
        },
        onCommit: () => session.touch(field),
        onBlur: () => session.touch(field),
        disabled: session.getStatus() === 'saving',
      }

      const overrides: Record<string, any> = { ...(props.props ?? {}) }
      if (props.label !== undefined) overrides.label = props.label
      if (props.help !== undefined) overrides.help = props.help

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
          state={session.getStatus()}
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

  const FormComponent: FC<{ children?: ReactNode; onSuccess?: () => void }> = ({ children, onSuccess }) => (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void session.submit().then((ok) => { if (ok) onSuccess?.() })
      }}
    >
      {children}
    </form>
  )
  FormComponent.displayName = 'AdForm'

  const SubmitComponent: FC<{ children?: ReactNode; event?: string }> = ({ children, event }) => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    // Event buttons carry the server's can verdict; plain submit only
    // disables while in flight
    const disabled = session.getStatus() === 'saving' || (event !== undefined && !session.can(event))
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => void session.submit(event !== undefined ? { event } : {})}
      >
        {children ?? 'Save'}
      </button>
    )
  }
  SubmitComponent.displayName = 'AdSubmit'

  const BaseErrorsComponent: FC = () => {
    useSyncExternalStore(
      (cb) => session.subscribe('*', cb),
      () => session.fieldVersion('*'),
      () => session.fieldVersion('*'),
    )
    const base = session.baseErrors()
    if (base.length === 0) return null
    return (
      <div role="alert">
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
        case '$session': return session
        case '$draft': return session.draft
        case '$errors': return session.allErrors()
        case '$dirty': return session.isDirty()
        case '$status': return session.getStatus()
        case '$version': return session.getVersion()
        case '$submit': return (opts?: { event?: string }) => session.submit(opts)
        case '$can': return (event: string) => session.can(event)
        case 'Form': return FormComponent
        case 'Submit': return SubmitComponent
        case 'BaseErrors': return BaseErrorsComponent
        // React/JS runtime probes that must not become field components
        case 'then': case 'toJSON': case '$$typeof': return undefined
      }
      if (prop.startsWith('$') || prop.startsWith('_')) return undefined
      let field = cache.get(prop)
      if (!field) {
        field = makeFieldComponent(prop)
        cache.set(prop, field)
      }
      return field
    },
  })
}
