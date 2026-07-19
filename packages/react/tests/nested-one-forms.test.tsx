/**
 * Singular nested forms — the hasOne half of accepts_nested_attributes_for.
 *
 * `<owner.profile>` yields ONE child handle; `profileAttributes` folds as a
 * single object ({...fields} new · {id, ...diff} dirty · {id, _destroy} removed
 * · absent clean). Build/Remove semantics, `profile.<field>` error routing,
 * child validation gating the parent, and post-save settle (id adoption).
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

function TextInput({ value, bind, errors }: PresenterProps) {
  return (
    <>
      <input
        aria-label={bind.name}
        value={value ?? ''}
        onChange={(e) => bind.onChange(e.target.value)}
        onBlur={(e) => bind.onBlur(e)}
      />
      {errors?.map(msg => <span key={msg} role="alert">{msg}</span>)}
    </>
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
  name: { kind: 'string', label: 'Name' },
  profile: {
    kind: 'nestedOne',
    fields: {
      bio: { kind: 'string', label: 'Bio' },
      website: { kind: 'string', label: 'Website' },
    },
  },
}

function makeHandle(opts: {
  profile?: any
  abilities?: Record<string, 'edit' | 'view'> | null
  submit?: (payload: any) => Promise<SubmitResult>
  childValidate?: (d: any) => Record<string, string[]>
  allowDestroy?: boolean
} = {}) {
  const meta: any = { ...FIELD_META, profile: { ...FIELD_META.profile } }
  if (opts.childValidate) meta.profile.validate = opts.childValidate
  if (opts.allowDestroy !== undefined) meta.profile.allowDestroy = opts.allowDestroy
  const session = new FormSession({
    draft: {
      id: 1,
      name: 'Ada',
      ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    },
    mode: 'edit',
    abilities: opts.abilities ?? null,
    ...(opts.submit ? { submit: opts.submit } : {}),
  })
  return { handle: createFormHandle(session, { fieldMeta: meta }), session }
}

function renderProfile(user: any) {
  return render(
    <user.Form>
      <user.profile>
        {(p: any) => (
          <>
            <p.bio edit />
            <p.Remove>Remove profile</p.Remove>
          </>
        )}
      </user.profile>
      <user.profile.Build>Add profile</user.profile.Build>
      <user.Submit>Save</user.Submit>
    </user.Form>,
  )
}

// ── Render + Build/Remove ────────────────────────────────────────────────────

describe('singular render-prop', () => {
  it('renders the ONE child form when the association is loaded', () => {
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'hello' } })
    renderProfile(user)
    const input = screen.getByRole('textbox', { name: 'bio' }) as HTMLInputElement
    expect(input.value).toBe('hello')
    // Build is hidden while a child exists — there is only ever one
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull()
    expect(user.profile.exists).toBe(true)
  })

  it('renders nothing (plus Build) when absent; Build creates the child', () => {
    const { handle: user } = makeHandle()
    renderProfile(user)
    expect(screen.queryByRole('textbox', { name: 'bio' })).toBeNull()
    expect(user.profile.exists).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    expect(screen.queryByRole('textbox', { name: 'bio' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Add profile' })).toBeNull()
    expect(user.profile.exists).toBe(true)
    expect(user.profile.form?.isNew).toBe(true)
  })

  it('removing a NEW child drops it entirely; Build returns', () => {
    const { handle: user } = makeHandle()
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove profile' }))
    expect(screen.queryByRole('textbox', { name: 'bio' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add profile' })).not.toBeNull()
    expect(user.profile.exists).toBe(false)
  })
})

// ── Payload folding ──────────────────────────────────────────────────────────

describe('singular payload folding', () => {
  it('a new child folds as a bare object (no id, no _key)', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({ submit })
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'bio' }), { target: { value: 'brand new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]![0].data.profileAttributes).toEqual({ bio: 'brand new' })
  })

  it('a dirty persisted child folds as { id, ...changedFields }', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'old', website: 'w' }, submit })
    renderProfile(user)
    fireEvent.change(screen.getByRole('textbox', { name: 'bio' }), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]![0].data.profileAttributes).toEqual({ id: 7, bio: 'edited' })
  })

  it('a clean persisted child stays OFF the wire', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'clean' }, submit })
    renderProfile(user)
    user.$session.setValue('name', 'Ada L')   // dirty a flat field only
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]![0].data).not.toHaveProperty('profileAttributes')
  })

  it('removing a persisted child folds as { id, _destroy: true }', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'bye' }, submit })
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Remove profile' }))
    expect(screen.queryByRole('textbox', { name: 'bio' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]![0].data.profileAttributes).toEqual({ id: 7, _destroy: true })
  })

  it('allowDestroy: false hides Remove for persisted children', () => {
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'x' }, allowDestroy: false })
    renderProfile(user)
    expect(screen.queryByRole('button', { name: 'Remove profile' })).toBeNull()
  })
})

// ── Errors ───────────────────────────────────────────────────────────────────

describe('singular error routing + gating', () => {
  it('server errors addressed `profile.<field>` land on the child field', async () => {
    const submit = vi.fn().mockResolvedValue({
      ok: false, status: 422, errors: { 'profile.bio': ['is too short'] },
    } satisfies SubmitResult)
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'x' }, submit })
    renderProfile(user)
    fireEvent.change(screen.getByRole('textbox', { name: 'bio' }), { target: { value: 'y' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('is too short'))
  })

  it('an invalid child BLOCKS the parent submit (client gate)', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({
      submit,
      childValidate: (d: any) => (!d.bio ? { bio: ['required'] } : {}),
    })
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('required'))
    expect(submit).not.toHaveBeenCalled()
  })
})

// ── Settle + locking ─────────────────────────────────────────────────────────

describe('singular settle + abilities', () => {
  it('a saved new child adopts the echoed server id — the next save diffs', async () => {
    const submit = vi.fn()
      .mockResolvedValueOnce({ ok: true, envelope: { record: { id: 1, name: 'Ada', profile: { id: 55, bio: 'brand new' } } } })
      .mockResolvedValue({ ok: true })
    const { handle: user } = makeHandle({ submit })
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'bio' }), { target: { value: 'brand new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(user.profile.form?.isNew).toBe(false))

    fireEvent.change(screen.getByRole('textbox', { name: 'bio' }), { target: { value: 'edited later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    // id adopted → second save updates (never re-creates)
    expect(submit.mock.calls[1]![0].data.profileAttributes).toEqual({ id: 55, bio: 'edited later' })
  })

  it('a destroyed child settles away after a successful save', async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, envelope: { record: { id: 1, name: 'Ada', profile: null } } })
    const { handle: user } = makeHandle({ profile: { id: 7, bio: 'bye' }, submit })
    renderProfile(user)
    fireEvent.click(screen.getByRole('button', { name: 'Remove profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    await waitFor(() => expect(user.profile.exists).toBe(false))
    // Nothing left to say — a follow-up save carries no profileAttributes
    expect((user.$session as any).changedData()).not.toHaveProperty('profileAttributes')
  })

  it('abilities `profileAttributes: view` locks the child: no Build, no Remove, no payload', () => {
    const { handle: user } = makeHandle({
      profile: { id: 7, bio: 'locked' },
      abilities: { name: 'edit', profileAttributes: 'view' },
    })
    renderProfile(user)
    expect(screen.queryByRole('button', { name: 'Remove profile' })).toBeNull()
    user.profile.remove()   // programmatic mutation is a no-op too
    expect(user.profile.exists).toBe(true)
    expect((user.$session as any).changedData()).not.toHaveProperty('profileAttributes')
  })
})
