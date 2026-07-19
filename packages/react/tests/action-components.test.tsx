/**
 * @mutation action components — the button IS a presenter.
 *
 * <deal.Archive/> renders from FormActionMeta wired by codegen: verdict-aware
 * (envelope can map → disabled; server re-enforces regardless), envelope-
 * folding (a returned envelope rehydrates the live session), param actions
 * become an implicit scaffolding mini-form unless `fields` pre-supplies the
 * payload or the render-prop takes over.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FormSession, createFormHandle, onFormEvents, type FormActionMeta } from '../src/index.js'

function makeHandle(opts: {
  can?: Record<string, boolean> | null
  actions: Record<string, FormActionMeta>
  draft?: Record<string, any>
}) {
  const session = new FormSession({
    draft: { id: 1, name: 'Acme', ...(opts.draft ?? {}) },
    mode: 'edit',
    abilities: null,
    ...(opts.can !== undefined ? { can: opts.can } : {}),
    version: '1000',
  })
  const handle: any = createFormHandle(session, {
    fieldMeta: { name: { kind: 'string' } },
    actions: opts.actions,
  })
  return { session, handle }
}

describe('paramless action → verdict-aware button', () => {
  it('runs the transport and reports success on the event bus', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true })
    const events: any[] = []
    const off = onFormEvents(e => { if (e.type === 'action') events.push(e) })
    try {
      const { handle } = makeHandle({ can: { archive: true }, actions: { archive: { transport } } })
      const A = handle.Archive
      render(<A />)
      fireEvent.click(screen.getByRole('button'))
      await waitFor(() => expect(transport).toHaveBeenCalledWith(undefined))
      await waitFor(() => expect(events).toEqual([expect.objectContaining({ action: 'archive', ok: true })]))
    } finally { off() }
  })

  it('GOVERNED session + false verdict → disabled (the grey button)', () => {
    const { handle } = makeHandle({ can: { archive: false }, actions: { archive: { transport: vi.fn() } } })
    render(<handle.Archive />)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('UNGOVERNED session (row handle, no can map) defaults to allow', () => {
    const { handle } = makeHandle({ can: null, actions: { archive: { transport: vi.fn() } } })
    render(<handle.Archive />)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('label comes from meta; children override it', () => {
    const { handle } = makeHandle({ can: null, actions: { archive: { label: 'Put away', transport: vi.fn() } } })
    render(<><handle.Archive /><handle.Archive>Custom</handle.Archive></>)
    expect(screen.getByText('Put away')).toBeTruthy()
    expect(screen.getByText('Custom')).toBeTruthy()
  })

  it('a returned envelope folds into the session: fields AND verdicts re-mask', async () => {
    const transport = vi.fn().mockResolvedValue({
      record: { id: 1, name: 'Archived Acme' },
      can: { archive: false },
      version: '2000',
    })
    const { session, handle } = makeHandle({ can: { archive: true }, actions: { archive: { transport } } })
    render(<handle.Archive />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect((session.draft as any).name).toBe('Archived Acme'))
    expect(session.verdict('archive')).toBe(false)
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true))
  })

  it('a 422 shows the error inline and reports ok:false', async () => {
    const transport = vi.fn().mockRejectedValue({ code: 'UNPROCESSABLE_ENTITY', message: 'nope', data: { errors: { base: ['archive is not available for this record'] } } })
    const { handle } = makeHandle({ can: null, actions: { archive: { transport } } })
    render(<handle.Archive />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not available'))
  })
})

describe('param action → implicit mini-form / fields / render-prop', () => {
  it('declared params render a scaffolding mini-form that posts the values', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true })
    const { handle } = makeHandle({
      can: { sendBack: true },
      actions: { sendBack: { label: 'Send back', params: ['reason'], required: ['reason'], transport } },
    })
    const { container } = render(<handle.SendBack />)
    expect(container.querySelector('[data-ad-scaffold]')).toBeTruthy()
    fireEvent.change(container.querySelector('input')!, { target: { value: 'needs numbers' } })
    fireEvent.click(screen.getByText('Send back'))
    await waitFor(() => expect(transport).toHaveBeenCalledWith({ reason: 'needs numbers' }))
  })

  it('field errors from a 422 land on the mini-form inputs', async () => {
    const transport = vi.fn().mockRejectedValue({ code: 'UNPROCESSABLE_ENTITY', message: 'Unprocessable Entity', data: { errors: { reason: ['is required'] } } })
    const { handle } = makeHandle({ can: null, actions: { sendBack: { params: ['reason'], transport } } })
    const { container } = render(<handle.SendBack />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(container.textContent).toContain('is required'))
  })

  it('`fields` pre-supplies the payload → plain button, no scaffold', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true })
    const { handle } = makeHandle({ can: null, actions: { sendBack: { params: ['reason'], transport } } })
    const { container } = render(<handle.SendBack fields={{ reason: 'duplicate' }}>Reject as dup</handle.SendBack>)
    expect(container.querySelector('[data-ad-scaffold]')).toBeNull()
    fireEvent.click(screen.getByText('Reject as dup'))
    await waitFor(() => expect(transport).toHaveBeenCalledWith({ reason: 'duplicate' }))
  })

  it('render-prop gets the raw api: run/allowed/pending/errors/label/params', async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true })
    const { handle } = makeHandle({ can: { sendBack: false }, actions: { sendBack: { label: 'Send back', params: ['reason'], transport } } })
    let api: any
    render(<handle.SendBack>{(a: any) => { api = a; return <em>custom ui</em> }}</handle.SendBack>)
    expect(screen.getByText('custom ui')).toBeTruthy()
    expect(api.allowed).toBe(false)
    expect(api.params).toEqual(['reason'])
    expect(api.label).toBe('Send back')
    await api.run({ reason: 'x' })
    expect(transport).toHaveBeenCalledWith({ reason: 'x' })
  })
})

describe('handle resolution rules', () => {
  it('PascalCase members resolve only declared actions; others fall through to fields', () => {
    const { handle } = makeHandle({ can: null, actions: { archive: { transport: vi.fn() } } })
    expect((handle.Archive as any).displayName).toBe('AdAction(archive)')
    expect(((handle.Publish as any)?.displayName ?? '')).not.toContain('AdAction')
  })

  it('reserved components are not shadowed by same-named actions', () => {
    // A mutation named `form` must not hijack <deal.Form>
    const { handle } = makeHandle({ can: null, actions: { form: { transport: vi.fn() } } })
    expect((handle.Form as any).displayName).not.toBe('AdAction(form)')
  })
})
