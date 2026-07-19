/**
 * Presenter testing kit — REAL sessions, arrangeable states.
 *
 * A presenter catalog/storybook should exercise the actual contract (IME
 * guards, cancel-blur skip, commit staging, disable rules), not a
 * hand-rolled imitation of it. These fixtures build genuine FormSessions
 * and arrange each narration state on them:
 *
 *   const fx = fieldStateFixtures({ amount: { kind: 'money', label: 'Amount' } }, 'amount')
 *   <MyMoneyInput {...fx.dirty} />       // every story = real props, real bind
 */
import { FormSession, type ServerEnvelope } from './form-session.js'
import { buildFieldBind, type BuildFieldBindOptions } from './form-handle.js'
import type { PresenterProps } from './presenters.js'

export interface CreateTestSessionOptions {
  values?: Record<string, any>
  mode?: 'edit' | 'new'
  abilities?: Record<string, 'edit' | 'view'> | null
  can?: Record<string, boolean> | null
  version?: string | null
  submit?: ConstructorParameters<typeof FormSession>[0]['submit']
}

/** A REAL FormSession over plain values — the same object generated hooks build. */
export function createTestSession(
  fieldMeta: Record<string, Record<string, any>>,
  opts: CreateTestSessionOptions = {},
): FormSession<any> {
  const draft: Record<string, any> = { id: 1, ...(opts.values ?? {}) }
  // stamp fieldMeta where useFieldProps finds it on generated Clients
  Object.defineProperty(draft, 'constructor', {
    value: { fieldMeta }, writable: true, configurable: true,
  })
  return new FormSession({
    draft,
    mode: opts.mode ?? 'edit',
    abilities: opts.abilities === undefined ? null : opts.abilities,
    can: opts.can === undefined ? null : opts.can,
    version: opts.version === undefined ? '1000' : opts.version,
    ...(opts.submit ? { submit: opts.submit } : {}),
  })
}

/** Assemble real PresenterProps from a session — headless (no React). */
export function buildTestProps(
  session: FormSession<any>,
  fieldMeta: Record<string, Record<string, any>>,
  field: string,
  bindOpts: Partial<BuildFieldBindOptions> = {},
): PresenterProps {
  const incoming = session.getIncomingFor(field)
  return {
    value: session.getValue(field),
    bind: buildFieldBind(session, { field, ...bindOpts }),
    meta: fieldMeta[field] ?? {},
    overrides: {},
    mode: session.canEdit(field) ? 'edit' : 'view',
    draft: session.draft,
    errors: session.visibleErrors(field),
    state: session.fieldState(field) !== 'ready' ? session.fieldState(field) : session.getStatus(),
    dirty: session.fieldDirty(field),
    ...(incoming !== undefined ? { elsewhere: incoming } : {}),
  }
}

export type FieldStateName =
  | 'ready' | 'dirty' | 'saving' | 'saved' | 'error' | 'pending' | 'waiting' | 'conflict' | 'elsewhere' | 'view'

/**
 * One fixture per presenter state, each a REAL session arranged into that
 * state — the catalog walks these and every story is honest.
 */
export function fieldStateFixtures(
  fieldMeta: Record<string, Record<string, any>>,
  field: string,
  values: Record<string, any> = {},
): Record<FieldStateName, { session: FormSession<any>; props: PresenterProps }> {
  const make = (arrange: (s: FormSession<any>) => void, bindOpts: Partial<BuildFieldBindOptions> = {}) => {
    const session = createTestSession(fieldMeta, { values })
    arrange(session)
    return { session, props: buildTestProps(session, fieldMeta, field, bindOpts) }
  }
  const dirtyValue = values[field] != null ? `${values[field]}!` : 'edited'
  return {
    ready:   make(() => {}),
    dirty:   make(s => s.setValue(field, dirtyValue)),
    saving:  make(s => (s as any)._primeFieldState(field, 'saving')),
    saved:   make(s => (s as any)._primeFieldState(field, 'saved')),
    error:   make(s => {
      s.setValue(field, dirtyValue)
      ;(s as any)._primeFieldState(field, 'error')
    }),
    pending: make(s => (s as any)._primeFieldState(field, 'pending')),
    waiting: make(() => {}, { disabled: true }),   // pendingIf semantics: bind disables; story sets state below
    conflict: make(s => (s as any)._primeStatus('conflict')),
    elsewhere: make(s => {
      s.setValue(field, dirtyValue)
      s.rehydrate({
        record: { id: 1, [field]: 'theirs', updatedAt: '2026-01-01T00:00:00Z', updatedByName: 'Mel' },
        version: '2000',
      } as ServerEnvelope)
    }),
    view: make(() => {}),
  }
}
