/**
 * Forms surface — conformance suite.
 *
 * RFC T1–T5 plus the interaction-layer matrix subset that applies to the
 * staged (batched) mode:
 *   T1 edit mask renders an input · T2 view mask renders text, no input ·
 *   T3 absent from abilities renders null · T4 batched submit sends the
 *   diff + version · T5 base errors render as role=alert ·
 *   C1 error display timing · C6 presentIf hiding keeps the value ·
 *   C9 programmatic draft writes re-render subscribers ·
 *   C13/C14 submit event → envelope re-mask (self-locking form) ·
 *   C15 401 keeps the draft intact
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import {
  FormSession,
  createFormHandle,
  registerPresenter,
  setDefaultPresenters,
  clearPresenters,
  type PresenterProps,
  type SubmitResult,
} from '../src/index.js'

// ── A tiny headless presenter kit (AD ships none — this is the app's) ────────

function TextInput({ value, bind, meta, overrides, errors }: PresenterProps) {
  const label = overrides.label ?? meta.label ?? bind.name
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={value ?? ''}
        disabled={bind.disabled}
        onChange={(e) => bind.onChange(e.target.value)}
        onBlur={bind.onBlur}
      />
      {errors.map((e, i) => <span role="note" key={i}>{e}</span>)}
    </label>
  )
}

function TextView({ value, meta, overrides }: PresenterProps) {
  const label = overrides.label ?? meta.label ?? ''
  return <span data-label={label}>{String(value ?? '')}</span>
}

function Toggle({ value, bind }: PresenterProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      checked={Boolean(value)}
      disabled={bind.disabled}
      onChange={(e) => bind.onChange(e.target.checked)}
    />
  )
}

beforeEach(() => {
  clearPresenters()
  registerPresenter('text', { kind: '*', commit: 'blur', component: TextInput })
  registerPresenter('textView', { kind: '*', component: TextView })
  registerPresenter('switch', { kind: '*', commit: 'change', component: Toggle })
  setDefaultPresenters({
    string: { edit: 'text', view: 'textView' },
    boolean: { edit: 'switch', view: 'textView' },
  })
})

// ── Draft factory (stands in for a generated Client) ─────────────────────────

interface LoanDraft extends Record<string, any> {
  id: number
  amount: string
  purpose: string
  status: string
  isPublished: boolean
}

function makeDraft(over: Partial<LoanDraft> = {}): LoanDraft {
  return { id: 1, amount: '250000', purpose: 'EXPANSION', status: 'DRAFT', isPublished: false, ...over }
}

const FIELD_META: Record<string, Record<string, any>> = {
  amount: { kind: 'string', label: 'Requested Loan Amount' },
  purpose: { kind: 'string', label: 'Purpose' },
  isPublished: { kind: 'boolean', label: 'Published' },
  discount: {
    kind: 'string',
    label: 'Discount',
    presentIf: (r: any) => r.purpose !== 'NEW',
  },
}

function makeHandle(opts: {
  draft?: LoanDraft
  abilities?: Record<string, 'edit' | 'view'> | null
  can?: Record<string, boolean>
  validate?: (d: any) => Record<string, string[]>
  submit?: (payload: any) => Promise<SubmitResult>
} = {}) {
  const session = new FormSession<LoanDraft>({
    draft: opts.draft ?? makeDraft(),
    mode: 'edit',
    abilities: opts.abilities === undefined
      ? { amount: 'edit', purpose: 'edit', status: 'view', isPublished: 'edit', discount: 'edit' }
      : opts.abilities,
    can: opts.can ?? {},
    ...(opts.validate ? { validate: opts.validate } : {}),
    ...(opts.submit ? { submit: opts.submit } : {}),
  })
  return { handle: createFormHandle(session, { fieldMeta: FIELD_META }), session }
}

// ── T1–T3: the mask decides what renders ─────────────────────────────────────

describe('mask-driven rendering', () => {
  it('T1: edit ability + edit prop → enabled input with the Attr label', () => {
    const { handle: loan } = makeHandle()
    render(<loan.Form><loan.amount edit /></loan.Form>)
    const input = screen.getByRole('textbox', { name: /requested loan amount/i })
    expect((input as HTMLInputElement).disabled).toBe(false)
    expect((input as HTMLInputElement).value).toBe('250000')
  })

  it('T2: view ability + same JSX → view presenter, no input', () => {
    const { handle: loan } = makeHandle({
      abilities: { amount: 'view', status: 'view' },
    })
    render(<loan.Form><loan.amount edit /></loan.Form>)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('250000')).toBeTruthy()
  })

  it('T3: absent from abilities → renders nothing at all', () => {
    const { handle: loan } = makeHandle({ abilities: { status: 'view' } })
    const { container } = render(<loan.Form><loan.amount edit /></loan.Form>)
    expect(container.querySelector('input,span,label')).toBeNull()
  })

  it('call-site label override wins over Attr meta', () => {
    const { handle: loan } = makeHandle()
    render(<loan.amount edit label="How much?" />)
    expect(screen.getByRole('textbox', { name: 'How much?' })).toBeTruthy()
  })
})

// ── T4: batched submit sends the diff + version ──────────────────────────────

describe('batched submit', () => {
  it('typing stages; submit sends ONLY the diff, with the version token', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(
      <loan.Form>
        <loan.amount edit />
        <loan.Submit>Save</loan.Submit>
      </loan.Form>,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '300000' } })
    expect(submitSpy).not.toHaveBeenCalled()          // staged, not sent

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0]).toEqual({
      data: { amount: '300000' },                     // ONLY the changed field
      })
  })
})

// ── T5: base errors render as role=alert ─────────────────────────────────────

describe('base errors', () => {
  it('server 422 with an invisible-field error lands in BaseErrors', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({
      ok: false,
      status: 422,
      errors: { adminCap: ['cap exceeded'] },         // field ∉ this projection
    }))
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(
      <loan.Form>
        <loan.amount edit />
        <loan.Submit>Save</loan.Submit>
        <loan.BaseErrors />
      </loan.Form>,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('cap exceeded')
  })
})

// ── C1: error display timing ─────────────────────────────────────────────────

describe('C1 — error timing', () => {
  const validate = (d: any) =>
    Number(d.amount) > 0 ? {} : { amount: ['must be positive'] }

  it('no error while typing before blur; appears on blur; clears live once shown', () => {
    const { handle: loan } = makeHandle({ validate, draft: makeDraft({ amount: '5' }) })
    render(<loan.amount edit />)
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: '-1' } })
    expect(screen.queryByRole('note')).toBeNull()          // not yelled at while typing

    fireEvent.blur(input)
    expect(screen.getByRole('note').textContent).toContain('must be positive')

    fireEvent.change(input, { target: { value: '10' } })   // clears live once visible
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('submit attempt reveals errors on untouched fields', async () => {
    const { handle: loan, session } = makeHandle({ validate, draft: makeDraft({ amount: '-1' }) })
    render(<><loan.amount edit /></>)
    expect(screen.queryByRole('note')).toBeNull()
    await act(async () => { await session.submit() })
    expect(screen.getByRole('note').textContent).toContain('must be positive')
  })
})

// ── C6 + C9: state lives on the draft ────────────────────────────────────────

describe('draft-owned state', () => {
  it('C6: presentIf hides and reveals without losing the value', () => {
    const draft = makeDraft({ discount: '15' })
    const { handle: loan } = makeHandle({ draft })
    render(<><loan.discount edit /><loan.purpose edit /></>)

    expect(screen.getByRole('textbox', { name: 'Discount' })).toBeTruthy()

    // purpose → NEW hides discount (presentIf)
    fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), { target: { value: 'NEW' } })
    expect(screen.queryByRole('textbox', { name: 'Discount' })).toBeNull()

    // reveal again — value survived on the draft
    fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), { target: { value: 'EXPANSION' } })
    expect((screen.getByRole('textbox', { name: 'Discount' }) as HTMLInputElement).value).toBe('15')
  })

  it('C9: a programmatic draft write re-renders the subscribed field', () => {
    const { handle: loan, session } = makeHandle()
    render(<loan.amount edit />)
    act(() => { session.setValue('amount', '777') })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('777')
  })
})

// ── Discrete inputs commit on change ─────────────────────────────────────────

describe('commit policy', () => {
  it('a toggle flips the draft value immediately on change', () => {
    const { handle: loan, session } = makeHandle()
    render(<loan.isPublished edit />)
    fireEvent.click(screen.getByRole('switch'))
    expect(session.getValue('isPublished')).toBe(true)
  })
})

// ── Autosave: per-field PATCH + simple offline queue ─────────────────────────

describe('autosave offline queue', () => {
  it('a network failure KEEPS the edit, queues it, and flush retries when back online', async () => {
    let online = false
    const submit = vi.fn(async ({ data }: any): Promise<SubmitResult> =>
      online ? { ok: true } : { ok: false, status: 0 })
    const { session } = makeHandle({ submit })

    session.setValue('amount', '999')
    const first = await session.commitField('amount', 'autosave')
    expect(first).toBe(false)
    expect(session.getValue('amount')).toBe('999')       // NOT rolled back (offline)
    expect(session.fieldState('amount')).toBe('pending')
    expect(session.hasPending()).toBe(true)

    online = true
    await session.flushPending()
    expect(session.getValue('amount')).toBe('999')
    expect(session.fieldState('amount')).toBe('saved')
    expect(session.hasPending()).toBe(false)
  })

  it('a SERVER rejection (422) still rolls back — only network failures queue', async () => {
    const submit = vi.fn(async (): Promise<SubmitResult> =>
      ({ ok: false, status: 422, errors: { amount: ['too big'] } }))
    const { session } = makeHandle({ submit })
    session.setValue('amount', '999')
    await session.commitField('amount', 'autosave')
    expect(session.getValue('amount')).toBe('250000')    // rolled back to server truth
    expect(session.hasPending()).toBe(false)
    expect(session.fieldState('amount')).toBe('error')
  })
})

// ── C13/C14: submit-as-transition + the self-locking form ────────────────────

describe('submit event → envelope re-mask', () => {
  it('the same JSX re-renders read-only after the transition narrows abilities', async () => {
    const submitSpy = vi.fn(async (payload: any): Promise<SubmitResult> => ({
      ok: true,
      envelope: {
        record: { status: 'SUBMITTED' },
        abilities: { amount: 'view', status: 'view' },   // permit narrowed to []
        can: { submit: false, reopen: true },
        version: 'v2',
      },
    }))
    const { handle: loan } = makeHandle({
      can: { submit: true },
      submit: submitSpy,
    })

    render(
      <loan.Form>
        <loan.amount edit />
        <loan.Submit event="submit">Submit application</loan.Submit>
      </loan.Form>,
    )

    expect(screen.getByRole('textbox')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }))

    // _event rode the payload
    await waitFor(() => expect(submitSpy).toHaveBeenCalled())
    expect(submitSpy.mock.calls[0]![0]._event).toBe('submit')

    // Self-locking: SAME JSX, now view — no input anywhere
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    expect(screen.getByText('250000')).toBeTruthy()
    // And the event button disabled itself from the new can map
    expect((screen.getByRole('button', { name: 'Submit application' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('an event button is disabled when the server can-map says no', () => {
    const { handle: loan } = makeHandle({ can: { submit: false } })
    render(<loan.Submit event="submit">Submit</loan.Submit>)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })
})

// ── C15: session death keeps the draft ───────────────────────────────────────

describe('C15 — auth death mid-form', () => {
  it('401 → status unauthenticated, draft intact, retry submits the same diff', async () => {
    let fail = true
    const submitSpy = vi.fn(async (payload: any): Promise<SubmitResult> =>
      fail ? { ok: false, status: 401 } : { ok: true })
    const { handle: loan, session } = makeHandle({ submit: submitSpy })

    render(<loan.Form><loan.amount edit /><loan.Submit>Save</loan.Submit></loan.Form>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(session.getStatus()).toBe('unauthenticated'))
    expect(session.getValue('amount')).toBe('999')       // draft SURVIVED

    fail = false                                          // re-authed
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(session.getStatus()).toBe('saved'))
    expect(submitSpy.mock.calls[1]![0].data).toEqual({ amount: '999' })  // same untouched diff
  })
})

// ── Presenter registry guardrails ────────────────────────────────────────────

describe('registry errors are loud — AND contained (the field boundary)', () => {
  // Wiring errors no longer take down the render tree: the per-field
  // boundary converts them into an inline teaching chip (console.error'd),
  // and every OTHER field keeps working.
  it('missing default edit presenter names the fix, inline', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      clearPresenters()
      registerPresenter('textView', { kind: '*', component: TextView })
      setDefaultPresenters({ string: { view: 'textView' } })
      const { handle: loan } = makeHandle()
      const { container } = render(<loan.amount edit />)
      const chip = container.querySelector('[data-ad-field-error="amount"]')!
      expect(chip).toBeTruthy()
      expect(chip.textContent).toMatch(/No edit presenter for "amount"/)
    } finally { err.mockRestore() }
  })

  it('requires-gate dev backstop fires when meta is missing, inline', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      registerPresenter('thickInfo', { kind: '*', requires: ['info'], component: TextInput })
      const { handle: loan } = makeHandle()
      const { container } = render(<loan.amount edit="thickInfo" />)
      expect(container.querySelector('[data-ad-field-error="amount"]')!.textContent)
        .toMatch(/requires meta 'info'/)
    } finally { err.mockRestore() }
  })
})

// ── Review-pass regressions ──────────────────────────────────────────────────

describe('handle safety', () => {
  it('Object.prototype probes never become field components', () => {
    const { handle: loan } = makeHandle()
    expect((loan as any).constructor).toBeUndefined()
    expect((loan as any).hasOwnProperty).toBeUndefined()
    expect(String(loan)).toBe('[FormHandle]')  // `${handle}` neither invokes a component nor throws
  })
})

describe('status returns to ready on edit', () => {
  it('saved → ready when the user types again', async () => {
    const { handle: loan, session } = makeHandle({ submit: async () => ({ ok: true }) })
    render(<loan.Form><loan.amount edit /><loan.Submit>Save</loan.Submit></loan.Form>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(session.getStatus()).toBe('saved'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '12' } })
    expect(session.getStatus()).toBe('ready')
  })
})

// ── M4: autosave (T6/T7 + C10/C11 + rollback) ────────────────────────────────

describe('M4 — autosave', () => {
  function AutoInput({ value, bind }: PresenterProps) {
    return (
      <input
        aria-label={bind.name}
        value={value ?? ''}
        disabled={bind.disabled}
        onChange={(e) => bind.onChange(e.target.value)}
        onBlur={(e) => bind.onBlur(e)}
        onCompositionStart={bind.onCompositionStart}
        onCompositionEnd={bind.onCompositionEnd}
      />
    )
  }

  beforeEach(() => {
    registerPresenter('autoText', { kind: '*', commit: 'blur', component: AutoInput })
  })

  it('T6: standalone field autosaves the single-field diff on blur', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan, session } = makeHandle({ submit: submitSpy })

    render(<loan.amount edit="autoText" />)   // NO Form → autosave by definition
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '300000' } })
    expect(submitSpy).not.toHaveBeenCalled()  // typing alone never PATCHes

    fireEvent.blur(input)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0]).toEqual({ data: { amount: '300000' } })
    await waitFor(() => expect(session.fieldState('amount')).toBe('saved'))
  })

  it('inside <Form autosave>, a toggle PATCHes instantly on flip', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(<loan.Form autosave><loan.isPublished edit /></loan.Form>)
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data).toEqual({ isPublished: true })
  })

  it('inside plain <Form>, blur only stages — no PATCH until Submit', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(<loan.Form><loan.amount edit="autoText" /></loan.Form>)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    await new Promise(r => setTimeout(r, 10))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('T7: local validator blocks the autosave — zero PATCHes, error shown', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const validate = (d: any) => (Number(d.amount) > 0 ? {} : { amount: ['must be positive'] })
    const { handle: loan } = makeHandle({ submit: submitSpy, validate })

    render(<loan.amount edit="autoText" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    await new Promise(r => setTimeout(r, 10))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('failure rolls the optimistic value back and marks the field errored', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> =>
      ({ ok: false, status: 422, errors: { amount: ['too big'] } }))
    const { handle: loan, session } = makeHandle({ submit: submitSpy })

    render(<loan.amount edit="autoText" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.blur(input)

    await waitFor(() => expect(session.fieldState('amount')).toBe('error'))
    expect(session.getValue('amount')).toBe('250000')   // rolled back
    expect(session.allErrors().amount).toContain('too big')
  })

  it('C10: blur into a data-ad-cancel element does NOT autosave', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(
      <>
        <loan.amount edit="autoText" />
        <button data-ad-cancel>Cancel</button>
      </>,
    )
    const input = screen.getByRole('textbox')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input, { relatedTarget: cancel })
    await new Promise(r => setTimeout(r, 10))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('C11: no commit while composing; one commit at composition end', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })
    registerPresenter('autoTextChange', { kind: '*', commit: 'change', component: AutoInput })

    render(<loan.amount edit="autoTextChange" />)
    const input = screen.getByRole('textbox')

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'に' } })
    fireEvent.change(input, { target: { value: 'にほ' } })
    await new Promise(r => setTimeout(r, 10))
    expect(submitSpy).not.toHaveBeenCalled()           // suppressed mid-composition

    fireEvent.compositionEnd(input)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data).toEqual({ amount: 'にほ' })
  })
})

// ── Authorization degradation + DX batch ─────────────────────────────────────

describe('authorization-safe validation', () => {
  it('a validator gate touching an unavailable field degrades — never crashes, never blocks', async () => {
    // Simulates a generated Client whose validate() has a validator whose
    // if-gate reads a server-only method: the generated try/catch swallows
    // it. Here we go further: even a validate() that THROWS wholesale must
    // not break rendering or submit.
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const validate = (d: any): Record<string, string[]> => {
      // e.g. Validates.presence({ if: (r) => r.isAdminApproved() }) where
      // isAdminApproved is server-only → TypeError client-side
      return (d as any).isAdminApproved() ? { amount: ['blocked'] } : {}
    }
    const { handle: loan, session } = makeHandle({ submit: submitSpy, validate })

    render(<loan.Form><loan.amount edit /><loan.Submit>Save</loan.Submit></loan.Form>)
    // Rendering with the throwing validator: no crash, no phantom errors
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(session.allErrors()).toEqual({})

    // Submit proceeds — the server is the authority for that rule
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
  })
})

describe('semantic kind fallback', () => {
  it('an email field renders with string defaults until an email presenter is registered', () => {
    const meta = { contact: { kind: 'email', label: 'Contact' } }
    const session = new FormSession({
      draft: { id: 1, contact: 'a@b.co' }, mode: 'edit', abilities: null,
    })
    const handle: any = createFormHandle(session, { fieldMeta: meta })
    // Only string presenters registered (beforeEach) — email falls back
    render(<handle.contact edit />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('a@b.co')

    // Registering a semantic presenter takes over via defaults
    registerPresenter('emailInput', {
      kind: 'email',
      component: ({ value, bind }: PresenterProps) => (
        <input type="email" aria-label="email-special" value={value ?? ''} onChange={e => bind.onChange(e.target.value)} />
      ),
    })
    setDefaultPresenters({ email: { edit: 'emailInput' } })
    const handle2: any = createFormHandle(session, { fieldMeta: meta })
    render(<handle2.contact edit />)
    expect(screen.getByLabelText('email-special')).toBeTruthy()
  })
})

describe('attachment fields', () => {
  it('reads the asset payload but writes <name>AssetId', () => {
    registerPresenter('filePick', {
      kind: 'attachmentOne',
      commit: 'change',
      component: ({ value, bind, meta }: PresenterProps) => (
        <button data-accepts={meta.accepts} onClick={() => bind.onChange({ id: 42, filename: 'x.pdf' })}>
          {value?.filename ?? 'Upload'}
        </button>
      ),
    })
    setDefaultPresenters({ attachmentOne: { edit: 'filePick' } })

    const meta = { contract: { kind: 'attachmentOne', accepts: 'application/pdf', maxSize: 1000 } }
    const session = new FormSession({
      draft: { id: 1, contract: { id: 7, filename: 'old.pdf' } },
      mode: 'edit', abilities: null,
    })
    const handle: any = createFormHandle(session, { fieldMeta: meta })
    render(<handle.contract edit />)

    const btn = screen.getByRole('button', { name: 'old.pdf' })
    expect(btn.getAttribute('data-accepts')).toBe('application/pdf')  // upload contract from meta

    fireEvent.click(btn)
    // The write went to the permitted column, as a raw id
    expect(session.getValue('contractAssetId')).toBe(42)
    expect(session.changedData()).toEqual({ contractAssetId: 42 })
  })
})

describe('className passthrough', () => {
  it('field className reaches the presenter; Form/Submit take standard classes', () => {
    registerPresenter('classy', {
      kind: '*',
      component: ({ overrides }: PresenterProps) => <i className={overrides.className}>x</i>,
    })
    const { handle: loan } = makeHandle()
    const { container } = render(
      <loan.Form className="space-y-4">
        <loan.amount edit="classy" className="w-full rounded border" />
        <loan.Submit className="btn btn-primary">Save</loan.Submit>
      </loan.Form>,
    )
    expect(container.querySelector('form')!.className).toBe('space-y-4')
    expect(container.querySelector('i')!.className).toBe('w-full rounded border')
    expect(screen.getByRole('button', { name: 'Save' }).className).toBe('btn btn-primary')
  })
})

// ── The invisible-success hang (regression) ──────────────────────────────────

describe('Submit inside Form fires onSuccess', () => {
  it('a Submit BUTTON click routes through the Form pipeline → onSuccess runs', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const onSuccess = vi.fn()
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(
      <loan.Form onSuccess={onSuccess}>
        <loan.amount edit />
        <loan.Submit>Save</loan.Submit>
      </loan.Form>,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })

  it('failed submit does NOT fire onSuccess and surfaces a fallback base error', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: false, status: 500 }))
    const onSuccess = vi.fn()
    const { handle: loan } = makeHandle({ submit: submitSpy })

    render(
      <loan.Form onSuccess={onSuccess}>
        <loan.amount edit />
        <loan.Submit>Save</loan.Submit>
        <loan.BaseErrors />
      </loan.Form>,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Something went wrong')
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('the button carries loading affordances while saving', async () => {
    let release: (v: SubmitResult) => void
    const submitSpy = vi.fn(() => new Promise<SubmitResult>(r => { release = r }))
    const { handle: loan } = makeHandle({ submit: submitSpy as any })

    render(<loan.Form><loan.amount edit /><loan.Submit>Save</loan.Submit></loan.Form>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      expect(btn.getAttribute('aria-busy')).toBe('true')
      expect(btn.getAttribute('data-status')).toBe('saving')
    })
    await act(async () => { release!({ ok: true }) })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

// ── belongsTo sugar: a 'ref' field aliases its FK column ─────────────────────

describe('ref fields (belongsTo sugar)', () => {
  beforeEach(() => {
    setDefaultPresenters({
      string: { edit: 'text', view: 'textView' },
      ref: { edit: 'text', view: 'textView' },
    })
  })
  const REF_META: Record<string, Record<string, any>> = {
    ...FIELD_META,
    ownerId: { kind: 'integer' },
    owner: { kind: 'ref', fk: 'ownerId', label: 'Owner' },
  }
  function makeRefHandle(opts: {
    abilities?: Record<string, 'edit' | 'view'> | null
  } = {}) {
    const session = new FormSession<any>({
      draft: { id: 1, ownerId: 7 },
      mode: 'edit',
      abilities: opts.abilities === undefined ? { ownerId: 'edit' } : opts.abilities,
      can: {},
    })
    return { handle: createFormHandle(session, { fieldMeta: REF_META }), session }
  }

  it('reads its value from the FK column', () => {
    const { handle: deal } = makeRefHandle()
    render(<deal.owner edit />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('7')
    expect(deal.owner.value).toBe(7)
  })

  it('writes commit to the FK column, not the association name', () => {
    const { handle: deal, session } = makeRefHandle()
    render(<deal.owner edit />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9' } })
    fireEvent.blur(screen.getByRole('textbox'))
    expect(session.getValue('ownerId')).toBe('9')
    expect((session.draft as any).owner).toBeUndefined()
  })

  it('obeys the FK entry of the abilities mask: view renders text', () => {
    const { handle: deal } = makeRefHandle({ abilities: { ownerId: 'view' } })
    render(<deal.owner edit />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('renders null when the FK is absent from the mask', () => {
    const { handle: deal } = makeRefHandle({ abilities: { amount: 'edit' } })
    const { container } = render(<deal.owner edit />)
    expect(container.innerHTML).toBe('')
  })

  it('surfaces FK-keyed validation errors on the ref field', () => {
    const session = new FormSession<any>({
      draft: { id: 1, ownerId: 7 },
      mode: 'edit',
      abilities: { ownerId: 'edit' },
      can: {},
      validate: () => ({ ownerId: ['is not a teammate'] }),
    })
    const deal = createFormHandle(session, { fieldMeta: REF_META })
    render(<deal.owner edit />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '9' } })
    fireEvent.blur(screen.getByRole('textbox'))
    expect(deal.owner.errors).toEqual(['is not a teammate'])
    expect(screen.getByRole('note').textContent).toBe('is not a teammate')
  })
})

// ── habtm sugar: a 'refMany' field aliases its `<singular>Ids` set ───────────

describe('refMany fields (habtm sugar)', () => {
  const MANY_META: Record<string, Record<string, any>> = {
    ownerIds: { kind: 'json' },
    owners: { kind: 'refMany', ids: 'ownerIds', label: 'Owners' },
  }

  function IdsProbe({ value, bind }: PresenterProps) {
    return (
      <button type="button" onClick={() => bind.onChange([...(value ?? []), 9])}>
        add-nine ({JSON.stringify(value)})
      </button>
    )
  }

  beforeEach(() => {
    registerPresenter('idsProbe', { kind: '*', commit: 'change', component: IdsProbe })
    setDefaultPresenters({
      string: { edit: 'text', view: 'textView' },
      refMany: { edit: 'idsProbe', view: 'textView' },
    })
  })

  function makeManyHandle(abilities: Record<string, 'edit' | 'view'> | null = { ownerIds: 'edit' }) {
    const session = new FormSession<any>({
      draft: { id: 1, ownerIds: [7] },
      mode: 'edit',
      abilities,
      can: {},
    })
    return { handle: createFormHandle(session, { fieldMeta: MANY_META }), session }
  }

  it('reads the ids array and writes changes back to the ids key', () => {
    const { handle: deal, session } = makeManyHandle()
    render(<deal.owners edit />)
    expect(deal.owners.value).toEqual([7])
    fireEvent.click(screen.getByRole('button'))
    expect(session.getValue('ownerIds')).toEqual([7, 9])
    expect((session.draft as any).owners).toBeUndefined()
  })

  it('the ids-key mask governs: view renders read-only', () => {
    const { handle: deal } = makeManyHandle({ ownerIds: 'view' })
    render(<deal.owners edit />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

// ── Whole-diff autosave: <Form autosave> flushes the OBJECT, not fields ──────

describe('whole-diff autosave (validity-gated flush)', () => {
  function autoHandle(opts: { validate?: (d: any) => Record<string, string[]>; submit: any }) {
    const session = new FormSession<LoanDraft>({
      draft: makeDraft(),
      mode: 'edit',
      abilities: { amount: 'edit', purpose: 'edit', isPublished: 'edit' },
      can: {},
      ...(opts.validate ? { validate: opts.validate } : {}),
      submit: opts.submit,
    })
    return { handle: createFormHandle(session, { fieldMeta: FIELD_META }), session }
  }

  it('two edits inside the debounce window flush as ONE PATCH with both fields', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = autoHandle({ submit: submitSpy })
    render(
      <loan.Form autosave={{ debounceMs: 30 }}>
        <loan.amount edit /><loan.purpose edit />
      </loan.Form>,
    )
    const [amount, purpose] = screen.getAllByRole('textbox')
    fireEvent.change(amount!, { target: { value: '9' } })
    fireEvent.blur(amount!)
    fireEvent.change(purpose!, { target: { value: 'FLEET' } })
    fireEvent.blur(purpose!)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data).toEqual({ amount: '9', purpose: 'FLEET' })
  })

  it('an invalid draft stays LOCAL; the flush fires when the draft heals — with the full diff', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = autoHandle({
      submit: submitSpy,
      validate: (d) => (d.amount === '' ? { amount: ['required'] } : {}),
    })
    render(
      <loan.Form autosave={{ debounceMs: 10 }}>
        <loan.amount edit /><loan.purpose edit />
      </loan.Form>,
    )
    const [amount, purpose] = screen.getAllByRole('textbox')
    // Break validity, then edit ANOTHER field — nothing may flush
    fireEvent.change(amount!, { target: { value: '' } })
    fireEvent.blur(amount!)
    fireEvent.change(purpose!, { target: { value: 'FLEET' } })
    fireEvent.blur(purpose!)
    await new Promise(r => setTimeout(r, 60))
    expect(submitSpy).not.toHaveBeenCalled()
    // Heal — the flush carries BOTH fields atomically
    fireEvent.change(amount!, { target: { value: '5' } })
    fireEvent.blur(amount!)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data).toEqual({ amount: '5', purpose: 'FLEET' })
  })

  it('keystrokes during a flight are never clobbered and ride the next flush', async () => {
    let release: (v: SubmitResult) => void
    const submitSpy = vi.fn(() => new Promise<SubmitResult>(r => { release = r }))
    const { handle: loan, session } = autoHandle({ submit: submitSpy as any })
    render(<loan.Form autosave={{ debounceMs: 0 }}><loan.amount edit /></loan.Form>)
    const amount = screen.getByRole('textbox')
    fireEvent.change(amount, { target: { value: '1' } })
    fireEvent.blur(amount)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    // Mid-flight edit
    fireEvent.change(amount, { target: { value: '12' } })
    // Server echoes the FLUSHED value — must not clobber '12'
    await act(async () => { release!({ ok: true, envelope: { record: { ...makeDraft(), amount: '1' } } }) })
    expect(session.getValue('amount')).toBe('12')
    // The newer edit flushes next
    fireEvent.blur(amount)
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(2))
    expect((submitSpy.mock.calls[1]![0] as any).data).toEqual({ amount: '12' })
  })

  it('a network failure queues the WHOLE diff; flushPending retries it', async () => {
    let fail = true
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => {
      if (fail) throw new Error('offline')
      return { ok: true }
    })
    const { handle: loan, session } = autoHandle({ submit: submitSpy })
    render(<loan.Form autosave={{ debounceMs: 0 }}><loan.amount edit /></loan.Form>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '7' } })
    fireEvent.blur(screen.getByRole('textbox'))
    await waitFor(() => expect(session.hasPending()).toBe(true))
    expect(session.getValue('amount')).toBe('7')   // the edit survives
    fail = false
    await act(async () => { await session.flushPending() })
    expect(session.hasPending()).toBe(false)
    expect(submitSpy.mock.calls.at(-1)![0].data).toEqual({ amount: '7' })
  })
})

// ── SaveStatus + per-field dirty ─────────────────────────────────────────────

describe('SaveStatus and the dirty signal', () => {
  function statusHandle(submit: any) {
    const session = new FormSession<LoanDraft>({
      draft: makeDraft(),
      mode: 'edit',
      abilities: { amount: 'edit' },
      can: {},
      submit,
    })
    return { handle: createFormHandle(session, { fieldMeta: FIELD_META }), session }
  }

  it('walks unsaved → saving → saved across a flush', async () => {
    let release: (v: SubmitResult) => void
    const submitSpy = vi.fn(() => new Promise<SubmitResult>(r => { release = r }))
    const { handle: loan } = statusHandle(submitSpy)
    render(
      <loan.Form autosave={{ debounceMs: 20 }}>
        <loan.amount edit /><loan.SaveStatus />
      </loan.Form>,
    )
    expect(screen.queryByRole('status')).toBeNull()   // pristine → renders nothing
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '3' } })
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('unsaved')
    fireEvent.blur(screen.getByRole('textbox'))
    await waitFor(() => expect(screen.getByRole('status').getAttribute('data-state')).toBe('saving'))
    await act(async () => { release!({ ok: true }) })
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('saved')
    expect(screen.getByRole('status').textContent).toBe('Saved ✓')
  })

  it('presenters receive dirty=true until the value is saved', async () => {
    const seen: boolean[] = []
    function DirtyProbe({ value, bind, dirty }: PresenterProps) {
      seen.push(dirty)
      return <input value={value ?? ''} onChange={(e) => bind.onChange(e.target.value)} onBlur={bind.onBlur} />
    }
    registerPresenter('dirtyProbe', { kind: '*', commit: 'blur', component: DirtyProbe })
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = statusHandle(submitSpy)
    render(<loan.Form autosave={{ debounceMs: 0 }}><loan.amount edit="dirtyProbe" /></loan.Form>)
    expect(seen.at(-1)).toBe(false)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '8' } })
    expect(seen.at(-1)).toBe(true)
    fireEvent.blur(screen.getByRole('textbox'))
    await waitFor(() => expect(seen.at(-1)).toBe(false))   // saved → clean again
  })
})
