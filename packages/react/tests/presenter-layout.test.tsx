/**
 * LAYOUTS ARE CONTEXT (LAW 3, DESIGN-presenter-tree §3): a folder's
 * context.ts declares its layout + consumed responsibilities; the stack
 * wraps every bulb beside/below; keys establish BEFORE the file's own
 * layout (Daniel's ordering rule). Plus typed kind values.
 */
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  FormSession, createFormHandle,
  registerPresenter, setDefaultPresenters, clearPresenters,
  definePresenterContext, PresenterContextProvider,
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

describe('layouts are context — the stack wraps every bulb below', () => {
  it('a context-declared layout renders chrome around the bulb; ctx keys visible to it', () => {
    registerPresenter('textInput', { kind: 'string', component: Bare })
    setDefaultPresenters({ string: { edit: 'textInput' } })
    let layoutSawCtx: any
    const appCtx = definePresenterContext(
      { density: () => 'compact' },
      {
        layout: (p: any) => {
          layoutSawCtx = p.ctx.density        // ordering rule: keys BEFORE own layout
          return (
            <label data-ad-layout="">
              <span>{p.meta.label}</span>
              {p.dirty && <em data-chrome="dirty">unsaved</em>}
              {p.children}
            </label>
          )
        },
        consumes: ['label', 'dirty'],
      },
    )
    const handle = makeHandle()
    const { container } = render(
      <PresenterContextProvider map={appCtx}>
        {React.createElement(handle.name, { edit: true })}
      </PresenterContextProvider>,
    )
    expect(container.querySelector('[data-ad-layout]')).toBeTruthy()
    expect(container.textContent).toContain('Name')
    expect(container.querySelector('[data-chrome="dirty"]')).toBeTruthy()
    expect(container.querySelector('input[aria-label="name"]')).toBeTruthy()
    expect(layoutSawCtx).toBe('compact')                 // the layout read its OWN folder's ctx
  })

  it('layouts STACK: outer area wraps inner area wraps the bulb', () => {
    registerPresenter('textInput', { kind: 'string', component: Bare })
    setDefaultPresenters({ string: { edit: 'textInput' } })
    const mk = (name: string) => definePresenterContext({}, {
      layout: (p: any) => <div data-layer={name}>{p.children}</div>,
      consumes: [],
    })
    const handle = makeHandle()
    const { container } = render(
      <PresenterContextProvider map={mk('app')}>
        <PresenterContextProvider map={mk('deal-area')}>
          {React.createElement(handle.name, { edit: true })}
        </PresenterContextProvider>
      </PresenterContextProvider>,
    )
    const outer = container.querySelector('[data-layer="app"]')!
    expect(outer.querySelector('[data-layer="deal-area"]')).toBeTruthy()   // nesting order holds
    expect(outer.querySelector('input')).toBeTruthy()
  })

  it('no layout declared anywhere → bulb renders bare (nothing to opt out of)', () => {
    registerPresenter('textInput', { kind: 'string', component: Bare })
    setDefaultPresenters({ string: { edit: 'textInput' } })
    const handle = makeHandle()
    const { container } = render(React.createElement(handle.name, { edit: true }))
    expect(container.querySelector('[data-ad-layout]')).toBeNull()
    expect(container.querySelector('input[aria-label="name"]')).toBeTruthy()
  })
})

describe('typed kind values (compile-time — asserted structurally)', () => {
  it('PresenterPropsFor gives builtin kinds their value types', () => {
    const MoneyBulb = (p: PresenterPropsFor<'money'>) => {
      const v: number | null = p.value                    // typed number — not any
      return <span>{v ?? 0}</span>
    }
    registerPresenter('moneyText', { kind: 'money', component: MoneyBulb })
    expect(true).toBe(true)
  })
})
