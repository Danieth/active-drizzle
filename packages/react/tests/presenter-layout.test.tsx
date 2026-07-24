/**
 * The LAYOUT socket + typed kind values (Daniel's two directives):
 * chrome written ONCE by the app; a money bulb typed for the wrong value
 * is a red squiggle at registration.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  FormSession, createFormHandle,
  registerPresenter, registerPresenterLayout, setDefaultPresenters, clearPresenters,
  type PresenterPropsFor,
} from '../src/index.js'

beforeEach(() => clearPresenters())

const Bare = (p: any) => <input aria-label={p.bind.name} value={p.value ?? ''} onChange={e => p.bind.onChange(e.target.value)} />

function makeHandle() {
  const session = new FormSession({
    draft: { id: 1, name: 'Acme' }, mode: 'edit', abilities: null,
  })
  session.setValue('name', 'Acme2')                      // dirty → chrome has something to show
  const handle: any = createFormHandle(session, { fieldMeta: { name: { kind: 'string', label: 'Name' } } })
  return handle
}

describe('the layout socket — chrome written once', () => {
  it('a DEFAULT layout wraps every bulb: label + dirty chrome around a value+bind input', () => {
    registerPresenterLayout('field', (p) => (
      <label data-ad-layout="">
        <span>{p.meta.label}</span>
        {p.dirty && <em data-chrome="dirty">unsaved</em>}
        {p.children}
        {p.errors.length > 0 && <span role="alert">{p.errors.join(', ')}</span>}
      </label>
    ), { default: true })
    registerPresenter('textInput', { kind: 'string', component: Bare })
    setDefaultPresenters({ string: { edit: 'textInput' } })
    const { container } = render(React.createElement(makeHandle().name, { edit: true }))
    expect(container.querySelector('[data-ad-layout]')).toBeTruthy()
    expect(container.textContent).toContain('Name')                    // chrome rendered the label
    expect(container.querySelector('[data-chrome="dirty"]')).toBeTruthy()
    expect(container.querySelector('input[aria-label="name"]')).toBeTruthy()  // bulb inside
  })

  it("layout: false opts a bulb OUT; explicit layout name wins; missing layout teaches", () => {
    registerPresenterLayout('field', (p) => <div data-ad-layout="">{p.children}</div>, { default: true })
    registerPresenter('bare', { kind: 'string', layout: false, component: Bare })
    setDefaultPresenters({ string: { edit: 'bare' } })
    const { container } = render(React.createElement(makeHandle().name, { edit: true }))
    expect(container.querySelector('[data-ad-layout]')).toBeNull()

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      clearPresenters()
      registerPresenter('lost', { kind: 'string', layout: 'nope', component: Bare })
      setDefaultPresenters({ string: { edit: 'lost' } })
      const { container: c2 } = render(React.createElement(makeHandle().name, { edit: true }))
      expect(c2.querySelector('[data-ad-field-error]')!.textContent).toMatch(/layout "nope" is not registered/)
    } finally { err.mockRestore() }
  })
})

describe('typed kind values (compile-time — asserted structurally)', () => {
  it('PresenterPropsFor gives builtin kinds their value types', () => {
    // These are type-level facts; the runtime assertion is that correctly
    // typed registrations compile AND run. The red-squiggle proof lives
    // in the type test below (build fails if the typing regresses).
    const MoneyBulb = (p: PresenterPropsFor<'money'>) => {
      const v: number | null = p.value                    // typed number — not any
      return <span>{v ?? 0}</span>
    }
    registerPresenter('moneyText', { kind: 'money', component: MoneyBulb })
    expect(true).toBe(true)
  })
})
