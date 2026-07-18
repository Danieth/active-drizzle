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
  version?: string | null
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
    version: opts.version ?? 'v1',
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
      version: 'v1',
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
