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

describe('registry errors are loud', () => {
  it('missing default edit presenter names the fix', () => {
    clearPresenters()
    registerPresenter('textView', { kind: '*', component: TextView })
    setDefaultPresenters({ string: { view: 'textView' } })
    const { handle: loan } = makeHandle()
    expect(() => render(<loan.amount edit />)).toThrow(/No edit presenter for "amount"/)
  })

  it('requires-gate dev backstop fires when meta is missing', () => {
    registerPresenter('thickInfo', { kind: '*', requires: ['info'], component: TextInput })
    const { handle: loan } = makeHandle()
    expect(() => render(<loan.amount edit="thickInfo" />)).toThrow(/requires meta 'info'/)
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

describe('409 conflict surfaces a message', () => {
  it('lands on base errors instead of failing silently', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: false, status: 409 }))
    const { handle: loan } = makeHandle({ submit: submitSpy })
    render(
      <loan.Form>
        <loan.amount edit />
        <loan.Submit>Save</loan.Submit>
        <loan.BaseErrors />
      </loan.Form>,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('changed by someone else')
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
    expect(submitSpy.mock.calls[0]![0]).toEqual({ data: { amount: '300000' }, version: 'v1' })
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
