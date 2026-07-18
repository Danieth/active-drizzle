/**
 * useGeneratedForm — the lifecycle engine behind generated hooks.
 *
 * Audit finding #1: the old generated hooks pinned the first payload in a
 * ref forever. These tests pin the CONTRACT:
 *   - navigating keys rebuilds the session for the new record
 *   - a fresh payload for the SAME key rehydrates a clean draft
 *   - a DIRTY draft is never clobbered by a background refetch
 *   - StrictMode double-rendering leaks nothing and settles correctly
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGeneratedForm } from '../src/generated-form.js'

const envelope = (record: Record<string, any>, extra: Record<string, any> = {}) => ({
  record,
  abilities: Object.fromEntries(Object.keys(record).map(k => [k, 'edit'])),
  can: {},
  ...extra,
})

function run(initial: { formKey: number | string; data: any }) {
  return renderHook(
    (props: { formKey: number | string; data: any }) =>
      useGeneratedForm<Record<string, any>>({
        formKey: props.formKey,
        mode: 'edit',
        data: props.data,
        makeDraft: (r) => ({ ...r }),
        fieldMeta: { name: { kind: 'string' } },
      }),
    { initialProps: initial },
  )
}

describe('useGeneratedForm', () => {
  it('waits for data, then builds; the handle exposes the record', () => {
    const hook = run({ formKey: 5, data: null })
    expect(hook.result.current.form).toBeNull()

    hook.rerender({ formKey: 5, data: envelope({ id: 5, name: 'Deal five' }) })
    expect(hook.result.current.form!.$draft.name).toBe('Deal five')
  })

  it('#1: navigating to a new key REBUILDS instead of serving the stale form', () => {
    const hook = run({ formKey: 5, data: envelope({ id: 5, name: 'Deal five' }) })
    expect(hook.result.current.form!.$draft.id).toBe(5)

    // Same mounted component, new id — the old ref-forever bug served deal 5 here
    hook.rerender({ formKey: 7, data: envelope({ id: 7, name: 'Deal seven' }) })
    expect(hook.result.current.form!.$draft.id).toBe(7)
    expect(hook.result.current.form!.$draft.name).toBe('Deal seven')
  })

  it('a fresh payload for the SAME key rehydrates a clean draft', () => {
    const first = envelope({ id: 5, name: 'Deal five' })
    const hook = run({ formKey: 5, data: first })

    // refetch (e.g. after invalidateQueries) lands with new server truth
    hook.rerender({ formKey: 5, data: envelope({ id: 5, name: 'Renamed elsewhere' }) })
    expect(hook.result.current.form!.$draft.name).toBe('Renamed elsewhere')
  })

  it('a DIRTY draft is never clobbered by a background refetch', () => {
    const hook = run({ formKey: 5, data: envelope({ id: 5, name: 'Deal five' }) })
    const form = hook.result.current.form!
    act(() => { form.$session.setValue('name', 'My unsaved edit') })

    hook.rerender({ formKey: 5, data: envelope({ id: 5, name: 'Server change' }) })
    expect(hook.result.current.form!.$draft.name).toBe('My unsaved edit')  // preserved
  })

  it('abilities re-mask on rehydrate (self-locking survives refetch)', () => {
    const hook = run({ formKey: 5, data: envelope({ id: 5, name: 'x' }) })
    expect(hook.result.current.form!.$session.canEdit('name')).toBe(true)

    hook.rerender({
      formKey: 5,
      data: { record: { id: 5, name: 'x' }, abilities: { name: 'view' }, can: {} },
    })
    expect(hook.result.current.form!.$session.canEdit('name')).toBe(false)
  })

  it('new mode builds immediately without data', () => {
    const hook = renderHook(() =>
      useGeneratedForm<Record<string, any>>({
        formKey: 'new',
        mode: 'new',
        data: null,
        makeDraft: (r) => ({ ...r }),
      }),
    )
    expect(hook.result.current.form).not.toBeNull()
    expect(hook.result.current.form!.$session.mode).toBe('new')
  })

  it('StrictMode-style re-invocation settles on ONE working session', () => {
    // renderHook wraps in StrictMode-free root; simulate by double rerender
    const data = envelope({ id: 5, name: 'Deal five' })
    const hook = run({ formKey: 5, data })
    const first = hook.result.current.form
    hook.rerender({ formKey: 5, data })
    expect(hook.result.current.form).toBe(first)   // stable identity, no churn
  })
})
