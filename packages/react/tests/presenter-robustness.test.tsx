/**
 * The presenter platform's ROBUSTNESS boundary — what happens when a bulb
 * misbehaves, a wire is crossed, or a name is typo'd:
 *
 *   1. a throwing presenter kills ITS field, never the form (FieldBoundary)
 *   2. a view-rendered presenter has NO pen (inert bind — writes refused)
 *   3. buildFieldBind enforces the ability mask at the pen itself
 *   4. attachment fields judge editability on the WRITE column (AssetId)
 *   5. a typo'd handle member teaches with did-you-mean instead of a
 *      misleading "no view presenter" — and every real member still works
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  FormSession, createFormHandle, buildFieldBind,
  registerPresenter, setDefaultPresenters, clearPresenters,
} from '../src/index.js'

const TextInput = (p: any) => (
  <input aria-label={p.bind.name} value={p.value ?? ''} disabled={p.bind.disabled}
    onChange={(e) => p.bind.onChange(e.target.value)} onBlur={p.bind.onBlur} />
)
const TextView = (p: any) => <span data-view={p.bind.name}>{String(p.value ?? '')}</span>

beforeEach(() => {
  clearPresenters()
  registerPresenter('textInput', { kind: '*', component: TextInput })
  registerPresenter('textView', { kind: '*', component: TextView })
  setDefaultPresenters({ string: { edit: 'textInput', view: 'textView' } })
})

const META = {
  name: { kind: 'string', label: 'Name' },
  stage: { kind: 'string', label: 'Stage' },
}

function makeHandle(over: { abilities?: Record<string, 'edit' | 'view'> | null; fieldMeta?: any; draft?: any } = {}) {
  const session = new FormSession({
    draft: over.draft ?? { id: 1, name: 'Acme', stage: 'draft' },
    mode: 'edit',
    abilities: over.abilities !== undefined ? over.abilities : null,
    version: '1',
  })
  const handle: any = createFormHandle(session, { fieldMeta: over.fieldMeta ?? META })
  return { session, handle }
}

describe('#1 one dead bulb ≠ a dead form', () => {
  it('a THROWING presenter yields an inline chip; sibling fields render fine', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      registerPresenter('bomb', {
        kind: '*',
        component: () => { throw new Error('presenter exploded') },
      })
      const { handle } = makeHandle()
      const { container } = render(
        <handle.Form>
          <handle.name edit="bomb" />
          <handle.stage edit />
        </handle.Form>,
      )
      // the bomb field died VISIBLY, in place
      const chip = container.querySelector('[data-ad-field-error="name"]')!
      expect(chip).toBeTruthy()
      expect(chip.textContent).toMatch(/presenter exploded/)
      // …and its sibling is alive and editable
      expect(container.querySelector('input[aria-label="stage"]')).toBeTruthy()
      // …and the terminal was told
      expect(err.mock.calls.some(c => String(c[0]).includes('failed to render'))).toBe(true)
    } finally { err.mockRestore() }
  })
})

describe('#2 view renders have NO pen', () => {
  it('a view presenter calling bind.onChange cannot corrupt the draft', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerPresenter('sneakyView', {
        kind: '*',
        component: (p: any) => {
          p.bind.onChange('EVIL')          // misbehaving bulb writes on render
          return <span>{String(p.value)}</span>
        },
      })
      setDefaultPresenters({ string: { edit: 'textInput', view: 'sneakyView' } })
      const { session, handle } = makeHandle()
      render(<handle.name />)              // view mode — no edit prop
      expect(session.getValue('name')).toBe('Acme')      // write refused
      expect(session.isDirty()).toBe(false)              // no phantom dirt
      expect(warn.mock.calls.some(c => String(c[0]).includes('refused'))).toBe(true)
    } finally { warn.mockRestore() }
  })
})

describe('#3 the mask is enforced at the pen (buildFieldBind)', () => {
  it("refuses writes the session's abilities mark 'view' — and allows the edit one", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const session = new FormSession({
        draft: { id: 1, name: 'a', stage: 'draft' }, mode: 'edit',
        abilities: { name: 'edit', stage: 'view' }, version: '1',
      })
      const stagePen = buildFieldBind(session, { field: 'stage', onCommit: () => {} })
      stagePen.onChange('won')
      expect(session.getValue('stage')).toBe('draft')    // refused
      expect(warn.mock.calls.some(c => String(c[0]).includes("'view'"))).toBe(true)

      const namePen = buildFieldBind(session, { field: 'name', onCommit: () => {} })
      namePen.onChange('b')
      expect(session.getValue('name')).toBe('b')         // positive control
    } finally { warn.mockRestore() }
  })
})

describe('#4 attachments judge edit on the WRITE column', () => {
  const ATTACH_META = { logo: { kind: 'attachmentOne', label: 'Logo' } }
  const captured: any[] = []
  const AttachProbe = (p: any) => { captured.push(p); return <span /> }

  it("abilities { logoAssetId: 'edit' } renders the logo field EDITABLE", () => {
    captured.length = 0
    registerPresenter('attachEdit', { kind: 'attachmentOne', component: AttachProbe })
    registerPresenter('attachView', { kind: 'attachmentOne', component: AttachProbe })
    setDefaultPresenters({ attachmentOne: { edit: 'attachEdit', view: 'attachView' } })
    const { session, handle } = makeHandle({
      draft: { id: 1, logo: { id: 9, url: 'x' }, logoAssetId: 9 },
      fieldMeta: ATTACH_META,
      // the envelope keys abilities on the PERMITTED column, not the name
      abilities: { logo: 'view', logoAssetId: 'edit' },
    })
    render(<handle.logo edit />)
    expect(captured[0].mode).toBe('edit')                 // was 'view' before the alias fix
    captured[0].bind.onChange({ id: 42, url: 'y' })
    expect(session.getValue('logoAssetId')).toBe(42)      // and the pen writes the id column
  })

  it('visibility flows through the alias too (only AssetId in the mask)', () => {
    captured.length = 0
    registerPresenter('attachView', { kind: 'attachmentOne', component: AttachProbe })
    setDefaultPresenters({ attachmentOne: { view: 'attachView' } })
    const { handle } = makeHandle({
      draft: { id: 1, logo: { id: 9 }, logoAssetId: 9 },
      fieldMeta: ATTACH_META,
      abilities: { logoAssetId: 'edit' },                 // 'logo' itself absent
    })
    const { container } = render(<handle.logo />)
    expect(captured.length).toBe(1)                       // rendered, not masked away
    void container
  })
})

describe('#5 a typo teaches — with did-you-mean', () => {
  it('handle.naem renders an inline chip suggesting "name"; console.errors once', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { handle } = makeHandle()
      const { container } = render(<handle.naem edit />)
      const chip = container.querySelector('[data-ad-unknown-field="naem"]')!
      expect(chip).toBeTruthy()
      expect(chip.textContent).toContain('"name"')
      expect(err.mock.calls.some(c => String(c[0]).includes('not a field'))).toBe(true)
    } finally { err.mockRestore() }
  })

  it('programmatic reads on a typo are safe defaults, not crashes', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { handle } = makeHandle()
      expect(handle.naem.value).toBeUndefined()
      expect(handle.naem.errors).toEqual([])
      expect(handle.naem.dirty).toBe(false)
    } finally { err.mockRestore() }
  })

  it('every REAL member keeps working: fields, $api, draft-only keys', () => {
    const { session, handle } = makeHandle()
    expect(typeof handle.Form).toBe('function')
    expect(handle.name.value).toBe('Acme')
    expect(handle.$dirty).toBe(false)
    // a draft key with no declared meta is NOT a typo (ad-hoc reads allowed)
    expect(handle.id.value).toBe(1)
    void session
  })

  it('bare handles (no field meta) stay fully permissive', () => {
    const session = new FormSession({ draft: { id: 1, x: 'y' }, mode: 'edit', abilities: null })
    const handle: any = createFormHandle(session, { fieldMeta: {} })
    expect(handle.anything.value).toBeUndefined()          // no chip, no error
  })
})

describe('audit bug fixes (presenter DX)', () => {
  it("call-site label reaches meta.label — a presenter reading ONLY meta just works", () => {
    let got: any
    registerPresenter('metaProbe', { kind: '*', component: (p: any) => { got = p; return null } })
    setDefaultPresenters({ string: { edit: 'metaProbe' } })
    const { handle } = makeHandle()
    render(<handle.name edit label="Call-site label" />)
    expect(got.meta.label).toBe('Call-site label')       // merged — the doc is now true
    expect(got.overrides.label).toBe('Call-site label')  // raw overrides still distinguishable
  })

  it("the waiting fixture actually reads state 'waiting' with a disabled bind", async () => {
    const { fieldStateFixtures } = await import('../src/testing.js')
    const fx = fieldStateFixtures({ name: { kind: 'string', label: 'Name' } }, 'name')
    expect(fx.waiting.props.state).toBe('waiting')
    expect(fx.waiting.props.bind.disabled).toBe(true)
  })

  it("registering a discrete-kind presenter without commit:'change' warns; with it, silent", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerPresenter('sw', { kind: 'boolean', component: () => null })
      expect(warn.mock.calls.some(c => String(c[0]).includes('NEVER SAVES'))).toBe(true)
      warn.mockClear()
      registerPresenter('sw2', { kind: 'boolean', commit: 'change', component: () => null })
      registerPresenter('txt', { kind: 'string', component: () => null })
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })
})
