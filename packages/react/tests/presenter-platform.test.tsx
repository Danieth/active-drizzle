/**
 * The presenter-platform escape hatches (wishlist 1/2/4/5/8): the public
 * bind builder, useFieldProps, the testing kit, per-field flush narration,
 * elsewhere.by, and handle read parity — every one asserted against REAL
 * sessions, because that's the whole point.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  FormSession, createFormHandle, buildFieldBind, useFieldProps,
  createTestSession, buildTestProps, fieldStateFixtures,
} from '../src/index.js'

const META = { amount: { kind: 'money', label: 'Amount' }, name: { kind: 'string', label: 'Name' } }

describe('#1 buildFieldBind — the real contract, headless', () => {
  it('stages on change-commit, honors IME guards, maps attachment writes', () => {
    const s = createTestSession(META, { values: { amount: '10' } })
    const commits: string[] = []
    const bind = buildFieldBind(s, { field: 'amount', commit: 'change', onCommit: f => commits.push(f) })
    bind.onChange('11')
    expect(s.getValue('amount')).toBe('11')
    expect(commits).toEqual(['amount'])              // discrete commit fired
    s.beginComposition('amount')
    bind.onChange('12')                              // mid-IME: write, no commit
    expect(commits).toEqual(['amount'])
    s.endComposition('amount')

    const att = buildFieldBind(s, { field: 'logo', writeField: 'logoAssetId', attachment: 'one', onCommit: () => {} })
    att.onChange({ id: 42, url: 'x' })
    expect(s.getValue('logoAssetId')).toBe(42)       // asset → id mapping intact
  })

  it('data-ad-cancel blur intent skips the commit (C10 survives extraction)', () => {
    const s = createTestSession(META)
    const commits: string[] = []
    const bind = buildFieldBind(s, { field: 'name', onCommit: f => commits.push(f) })
    const cancelEl = { closest: (sel: string) => (sel === '[data-ad-cancel]' ? {} : null) }
    bind.onBlur?.({ relatedTarget: cancelEl } as any)
    expect(commits).toEqual([])                      // cancel intent → no commit
    bind.onBlur?.({} as any)
    expect(commits).toEqual(['name'])
  })
})

describe('#2 the testing kit — every state is a REAL session', () => {
  it('fieldStateFixtures walks the states with genuine props', () => {
    const fx = fieldStateFixtures(META, 'amount', { amount: '10' })
    expect(fx.ready.props.state).toBe('ready')
    expect(fx.dirty.props.dirty).toBe(true)
    expect(fx.saving.props.state).toBe('saving')
    expect(fx.saving.props.bind.disabled).toBe(true)   // real disable rule, not a prop
    expect(fx.saved.props.state).toBe('saved')
    expect(fx.error.props.state).toBe('error')
    expect(fx.conflict.props.state).toBe('conflict')
    expect(fx.elsewhere.props.elsewhere).toMatchObject({ value: 'theirs', by: 'Mel' })
    expect(fx.elsewhere.props.dirty).toBe(true)        // mine survived the merge
  })
})

describe('#4 per-field narration through a debounced flush', () => {
  it("only the FLUSHED fields pulse saving→saved; mid-flight edits drop back to dirty", async () => {
    let resolveSubmit!: (v: any) => void
    const submit = vi.fn(() => new Promise<any>(r => { resolveSubmit = r }))
    const s = createTestSession(META, { values: { amount: '10', name: 'a' }, submit: submit as any })
    s.setValue('amount', '20')
    s.setValue('name', 'b')
    const flight = s.autoFlush()
    expect(s.fieldState('amount')).toBe('saving')
    expect(s.fieldState('name')).toBe('saving')
    s.setValue('name', 'c')                            // mid-flight edit
    resolveSubmit({ ok: true })
    await flight
    expect(s.fieldState('amount')).toBe('saved')       // landed untouched → saved pulse
    expect(s.fieldState('name')).toBe('ready')         // re-edited → back to dirty narration
    expect(s.fieldDirty('name')).toBe(true)
  })

  it('a failed flush clears the transient marks (no stuck spinners)', async () => {
    const s = createTestSession(META, {
      values: { amount: '10' },
      submit: (async () => ({ ok: false, status: 422, errors: { amount: ['bad'] } })) as any,
    })
    s.setValue('amount', '999')
    await s.autoFlush()
    expect(s.fieldState('amount')).toBe('ready')
    expect(s.getStatus()).toBe('error')
  })
})

describe('#8 handle read parity', () => {
  it('field members expose dirty/elsewhere/ability beside errors/meta/value', () => {
    const s = new FormSession({
      draft: { id: 1, name: 'a' }, mode: 'edit',
      abilities: { name: 'view' }, version: '1000',
    })
    const h: any = createFormHandle(s, { fieldMeta: META })
    expect(h.name.ability).toBe('view')
    expect(h.name.dirty).toBe(false)
    s.setValue('name', 'MINE')
    s.rehydrate({ record: { id: 1, name: 'THEIRS', updatedBy: 'ada' }, version: '2000' })
    expect(h.name.dirty).toBe(true)
    expect(h.name.elsewhere).toMatchObject({ value: 'THEIRS', by: 'ada' })
  })
})

describe('useFieldProps — the hook escape hatch', () => {
  it('yields live PresenterProps for a portal/custom composition', () => {
    const s = createTestSession(META, { values: { amount: '10' } })
    let got: any
    function Probe() { got = useFieldProps(s, 'amount'); return null }
    render(<Probe />)
    expect(got.value).toBe('10')
    expect(got.meta.label).toBe('Amount')
    expect(got.mode).toBe('edit')
    act(() => { got.bind.onChange('55') })
    expect(s.getValue('amount')).toBe('55')
    let after: any
    function Probe2() { after = useFieldProps(s, 'amount'); return null }
    render(<Probe2 />)
    expect(after.dirty).toBe(true)
  })
})
