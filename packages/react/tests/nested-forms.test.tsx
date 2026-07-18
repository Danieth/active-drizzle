/**
 * Nested attribute arrays — the client half of accepts_nested_attributes_for.
 *
 * C5 (identity keys — removing a middle row keeps sibling state), the
 * unfurl render-prop, Add/Remove semantics (_destroy vs vanish), payload
 * folding to the server contract, error routing by _key, and child
 * validation gating the parent submit.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  FormSession,
  createFormHandle,
  registerPresenter,
  setDefaultPresenters,
  clearPresenters,
  type PresenterProps,
  type SubmitResult,
} from '../src/index.js'

function TextInput({ value, bind }: PresenterProps) {
  return (
    <input
      aria-label={bind.name}
      value={value ?? ''}
      onChange={(e) => bind.onChange(e.target.value)}
      onBlur={(e) => bind.onBlur(e)}
    />
  )
}
function TextView({ value }: PresenterProps) {
  return <span>{String(value ?? '')}</span>
}

beforeEach(() => {
  clearPresenters()
  registerPresenter('text', { kind: '*', component: TextInput })
  registerPresenter('textView', { kind: '*', component: TextView })
  setDefaultPresenters({ string: { edit: 'text', view: 'textView' } })
})

const FIELD_META = {
  amount: { kind: 'string', label: 'Amount' },
  assets: {
    kind: 'nested',
    fields: {
      name: { kind: 'string', label: 'Name' },
      value: { kind: 'string', label: 'Value' },
    },
  },
}

function makeHandle(opts: {
  assets?: any[]
  submit?: (payload: any) => Promise<SubmitResult>
  childValidate?: (d: any) => Record<string, string[]>
} = {}) {
  const meta = structuredClone
    ? { ...FIELD_META, assets: { ...FIELD_META.assets } }
    : FIELD_META
  if (opts.childValidate) (meta.assets as any).validate = opts.childValidate
  const session = new FormSession({
    draft: {
      id: 1,
      amount: '100',
      assets: opts.assets ?? [
        { id: 7, name: 'Truck', value: '30000' },
        { id: 8, name: 'Crane', value: '90000' },
      ],
    },
    mode: 'edit',
    abilities: null,
    version: 'v1',
    ...(opts.submit ? { submit: opts.submit } : {}),
  })
  return { handle: createFormHandle(session, { fieldMeta: meta as any }), session }
}

function renderAssets(loan: any) {
  return render(
    <loan.Form>
      <loan.assets>
        {(asset: any) => (
          <>
            <asset.name edit />
            <asset.Remove>Remove {asset.key}</asset.Remove>
          </>
        )}
      </loan.assets>
      <loan.assets.Add>Add asset</loan.assets.Add>
      <loan.Submit>Save</loan.Submit>
    </loan.Form>,
  )
}

// ── Unfurl + identity ────────────────────────────────────────────────────────

describe('render-prop unfurl', () => {
  it('renders one child form per row, keyed internally', () => {
    const { handle: loan } = makeHandle()
    renderAssets(loan)
    const inputs = screen.getAllByRole('textbox', { name: 'name' })
    expect(inputs).toHaveLength(2)
    expect((inputs[0] as HTMLInputElement).value).toBe('Truck')
    expect((inputs[1] as HTMLInputElement).value).toBe('Crane')
  })

  it('C5: removing the FIRST row keeps the second row’s edited state', () => {
    const { handle: loan } = makeHandle()
    renderAssets(loan)
    const inputs = screen.getAllByRole('textbox', { name: 'name' })
    fireEvent.change(inputs[1]!, { target: { value: 'Big Crane' } })

    fireEvent.click(screen.getByRole('button', { name: 'Remove id:7' }))

    const remaining = screen.getAllByRole('textbox', { name: 'name' })
    expect(remaining).toHaveLength(1)
    expect((remaining[0] as HTMLInputElement).value).toBe('Big Crane')  // survived
  })

  it('Add appends a new editable row', () => {
    const { handle: loan } = makeHandle()
    renderAssets(loan)
    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))
    expect(screen.getAllByRole('textbox', { name: 'name' })).toHaveLength(3)
  })
})

// ── Payload folding: the exact server contract ───────────────────────────────

describe('submit payload folding', () => {
  it('folds create/update/destroy into <name>Attributes', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })
    renderAssets(loan)

    // update row id:7
    fireEvent.change(screen.getAllByRole('textbox', { name: 'name' })[0]!, { target: { value: 'Truck XL' } })
    // destroy row id:8
    fireEvent.click(screen.getByRole('button', { name: 'Remove id:8' }))
    // create a new row
    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))
    fireEvent.change(screen.getAllByRole('textbox', { name: 'name' })[1]!, { target: { value: 'Forklift' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))

    const payload = submitSpy.mock.calls[0]![0]
    expect(payload.data.assets).toBeUndefined()          // raw array never rides the diff
    expect(payload.data.assetsAttributes).toEqual([
      { id: 7, name: 'Truck XL' },                       // persisted diff
      { id: 8, _destroy: true },                         // destroy marker
      { name: 'Forklift', _key: 'new:1' },               // new row w/ ephemeral key
    ])
  })

  it('a clean form submits without an assetsAttributes key at all', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })
    renderAssets(loan)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data).toEqual({})
  })

  it('removing a NEW row makes it vanish from the payload entirely', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({ submit: submitSpy })
    renderAssets(loan)

    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove new:1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data.assetsAttributes).toBeUndefined()
  })
})

// ── Validation + error routing ───────────────────────────────────────────────

describe('child validation and errors', () => {
  it('an invalid child blocks the parent submit', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const { handle: loan } = makeHandle({
      submit: submitSpy,
      childValidate: (d) => (d.name ? {} : { name: ['required'] }),
    })
    renderAssets(loan)

    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))  // empty name
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await new Promise(r => setTimeout(r, 10))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('server errors addressed by _key route to the right child session', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({
      ok: false,
      status: 422,
      errors: { 'assets[id:8].value': ['too expensive'] },
    }))
    const { handle: loan, session } = makeHandle({ submit: submitSpy })
    renderAssets(loan)

    fireEvent.change(screen.getAllByRole('textbox', { name: 'name' })[0]!, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const mgr: any = session.getNested('assets')
      const child = mgr.all().find((c: any) => c.key === 'id:8')
      expect(child.session.allErrors().value).toContain('too expensive')
    })
    // Nothing leaked to the parent's base
    expect(session.allErrors().base).toBeUndefined()
  })
})

// ── Post-save settle ─────────────────────────────────────────────────────────

describe('post-save settle', () => {
  it('new rows adopt server ids from the response envelope and re-key', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({
      ok: true,
      envelope: {
        record: {
          id: 1, amount: '100',
          assets: [
            { id: 7, name: 'Truck', value: '30000' },
            { id: 8, name: 'Crane', value: '90000' },
            { id: 99, name: 'Forklift', value: null },
          ],
        },
        version: 'v2',
      },
    }))
    const { handle: loan, session } = makeHandle({ submit: submitSpy })
    renderAssets(loan)

    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))
    fireEvent.change(screen.getAllByRole('textbox', { name: 'name' })[2]!, { target: { value: 'Forklift' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(session.getStatus()).toBe('saved'))
    const mgr: any = session.getNested('assets')
    const keys = mgr.visible().map((c: any) => c.key)
    expect(keys).toContain('id:99')                      // re-keyed from new:1
    expect(session.isDirty()).toBe(false)                // fully settled
  })
})

// ── Nested-nested: grandchildren fold through the child session ──────────────

describe('nested-nested forms', () => {
  it('a NEW child with its own nested array folds grandchildren as <name>Attributes', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const meta = {
      amount: { kind: 'string' },
      assets: {
        kind: 'nested',
        fields: {
          name: { kind: 'string' },
          liens: {                       // grandchild array
            kind: 'nested',
            fields: { holder: { kind: 'string' } },
          },
        },
      },
    }
    const session = new FormSession({
      draft: { id: 1, amount: '100', assets: [] },
      mode: 'edit', abilities: null, version: 'v1', submit: submitSpy,
    })
    const loan: any = createFormHandle(session, { fieldMeta: meta as any })

    render(
      <loan.Form>
        <loan.assets>
          {(asset: any) => (
            <>
              <asset.name edit />
              <asset.liens>
                {(lien: any) => <lien.holder edit />}
              </asset.liens>
              <asset.liens.Add>Add lien</asset.liens.Add>
            </>
          )}
        </loan.assets>
        <loan.assets.Add>Add asset</loan.assets.Add>
        <loan.Submit>Save</loan.Submit>
      </loan.Form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add asset' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'name' }), { target: { value: 'Truck' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add lien' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'holder' }), { target: { value: 'First Bank' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    const data = submitSpy.mock.calls[0]![0].data
    expect(data.assetsAttributes).toHaveLength(1)
    const asset = data.assetsAttributes[0]
    expect(asset.name).toBe('Truck')
    expect(asset._key).toBe('new:1')
    expect(asset.liens).toBeUndefined()                       // raw array never rides
    expect(asset.liensAttributes).toEqual([{ holder: 'First Bank', _key: 'new:1' }])
  })
})

// ── Drag-and-drop reordering ─────────────────────────────────────────────────

describe('move() reordering', () => {
  it('moves a row and rewrites position fields; diffs ride the submit', async () => {
    const submitSpy = vi.fn(async (): Promise<SubmitResult> => ({ ok: true }))
    const meta = {
      assets: {
        kind: 'nested',
        orderBy: 'position',
        fields: { name: { kind: 'string' }, position: { kind: 'integer' } },
      },
    }
    const session = new FormSession({
      draft: {
        id: 1,
        assets: [
          { id: 7, name: 'A', position: 0 },
          { id: 8, name: 'B', position: 1 },
          { id: 9, name: 'C', position: 2 },
        ],
      },
      mode: 'edit', abilities: null, version: 'v1', submit: submitSpy,
    })
    const loan: any = createFormHandle(session, { fieldMeta: meta as any })

    render(
      <loan.Form>
        <loan.assets>{(a: any) => <a.name view="textView" />}</loan.assets>
        <loan.Submit>Save</loan.Submit>
      </loan.Form>,
    )

    // DnD lib calls this on drop: move C to the front
    loan.assets.move('id:9', 0)

    // Visual order updated
    await waitFor(() => {
      const texts = screen.getAllByText(/^[ABC]$/).map(el => el.textContent)
      expect(texts).toEqual(['C', 'A', 'B'])
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1))
    expect(submitSpy.mock.calls[0]![0].data.assetsAttributes).toEqual([
      { id: 9, position: 0 },
      { id: 7, position: 1 },
      { id: 8, position: 2 },
    ])
  })
})
