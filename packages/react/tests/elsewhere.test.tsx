/**
 * The `elsewhere` presenter prop + the fat <handle.Changes> floater.
 *
 * One source (the merge's incoming map), two bulbs: field presenters get
 * elsewhere?: { value, at } to render inline affordances; <handle.Changes>
 * yields { changes: [{ field, label, value, at, adopt }], adoptAll, dismiss }
 * for the aggregate "A, B and C changed — click to update" floater.
 */
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import {
  FormSession, createFormHandle, registerPresenter, setDefaultPresenters, clearPresenters,
  type PresenterProps,
} from '../src/index.js'

let lastProps: PresenterProps | null = null
function Probe(p: PresenterProps) {
  lastProps = p
  return <input value={p.value ?? ''} onChange={(e) => p.bind.onChange(e.target.value)} />
}

beforeEach(() => {
  clearPresenters()
  lastProps = null
  registerPresenter('probe', { kind: '*', component: Probe })
  setDefaultPresenters({ string: { edit: 'probe', view: 'probe' } })
})

const FIELD_META = { name: { kind: 'string', label: 'Deal Name' }, amount: { kind: 'string', label: 'Amount' } }

function makeConflicted() {
  const session = new FormSession({
    draft: { id: 1, name: 'a', amount: '10' }, mode: 'edit', abilities: null, version: '1000',
  })
  const handle: any = createFormHandle(session, { fieldMeta: FIELD_META })
  session.setValue('name', 'MINE')
  session.rehydrate({ record: { id: 1, name: 'THEIRS', amount: '10', updatedAt: '2026-07-19T12:00:00Z' }, version: '2000' })
  return { session, handle }
}

describe('elsewhere rides PresenterProps', () => {
  it('a diverged field gets { value, at }; a settled field gets nothing', () => {
    const { handle } = makeConflicted()
    render(<handle.name edit />)
    expect(lastProps!.elsewhere).toEqual({ value: 'THEIRS', at: '2026-07-19T12:00:00Z' })
    expect(lastProps!.value).toBe('MINE')          // never eat a keystroke
    render(<handle.amount edit />)
    expect(lastProps!.elsewhere).toBeUndefined()
  })

  it('adopting via bind.onChange(elsewhere.value) clears the prop on the next render', () => {
    const { session, handle } = makeConflicted()
    render(<handle.name edit />)
    act(() => { session.adoptIncoming('name') })
    expect(lastProps!.elsewhere).toBeUndefined()
    expect(lastProps!.value).toBe('THEIRS')
  })
})

describe('<handle.Changes> — the fat floater', () => {
  it('render-prop yields labeled changes with adopt(); adopting settles field + token', () => {
    const { session, handle } = makeConflicted()
    let api: any
    render(<handle.Changes>{(a: any) => { api = a; return <em>floater</em> }}</handle.Changes>)
    expect(api.changes).toHaveLength(1)
    expect(api.changes[0]).toMatchObject({ field: 'name', label: 'Deal Name', value: 'THEIRS', at: '2026-07-19T12:00:00Z' })
    act(() => { api.changes[0].adopt() })
    expect((session.draft as any).name).toBe('THEIRS')
    expect(session.getVersion()).toBe('2000')      // withheld token released
  })

  it('default rendering: take-theirs button adopts; floater then disappears', () => {
    const { session, handle } = makeConflicted()
    const { container } = render(<handle.Changes />)
    expect(container.textContent).toContain('Deal Name → THEIRS')
    fireEvent.click(screen.getByText('take theirs'))
    expect((session.draft as any).name).toBe('THEIRS')
    expect(container.querySelector('[data-ad-changes]')).toBeNull()
  })

  it('adoptAll takes every standing change; dismiss is presentation-only', () => {
    const session = new FormSession({ draft: { id: 1, name: 'a', amount: '10' }, mode: 'edit', abilities: null, version: '1000' })
    const handle: any = createFormHandle(session, { fieldMeta: FIELD_META })
    session.setValue('name', 'M1'); session.setValue('amount', 'M2')
    session.rehydrate({ record: { id: 1, name: 'T1', amount: 'T2' }, version: '2000' })
    let api: any
    render(<handle.Changes>{(a: any) => { api = a; return null }}</handle.Changes>)
    expect(api.changes).toHaveLength(2)
    act(() => { api.adoptAll() })
    expect((session.draft as any).name).toBe('T1')
    expect((session.draft as any).amount).toBe('T2')
    expect(session.getVersion()).toBe('2000')

    // dismiss path: notice clears but a stale token still guards the submit
    session.setValue('name', 'MINE2')
    session.rehydrate({ record: { id: 1, name: 'T3', amount: 'T2' }, version: '3000' })
    act(() => { api.dismiss() })
    expect(session.getIncoming()).toEqual({})
    expect(session.getVersion()).toBe('2000')      // withheld — next submit 409s
  })
})
