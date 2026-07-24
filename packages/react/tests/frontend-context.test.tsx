/**
 * @frontendContext, client half: the envelope's ctx bag reaches EVERY
 * presenter as props.ctx — held by the session, refreshed by rehydrate,
 * mirrored by the testing kit, surfaced by the index surface.
 */
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  FormSession, createFormHandle, createIndexSurface,
  registerPresenter, setDefaultPresenters, clearPresenters,
} from '../src/index.js'
import { useForm } from '../src/use-form.js'
import { buildTestProps, createTestSession } from '../src/testing.js'

const CTX = { userType: 'admin', plan: 'pro' }

beforeEach(() => clearPresenters())

describe('session plumbing', () => {
  it('holds the envelope ctx; ungoverned sessions get {} (never null)', () => {
    const governed = new FormSession({ draft: { id: 1 }, mode: 'edit', abilities: null, ctx: CTX })
    expect(governed.getFrontendCtx()).toEqual(CTX)
    const bare = new FormSession({ draft: { id: 1 }, mode: 'edit', abilities: null })
    expect(bare.getFrontendCtx()).toEqual({})
  })

  it('rehydrate REFRESHES ctx — server facts track the server', () => {
    const s = new FormSession({ draft: { id: 1, name: 'a' }, mode: 'edit', abilities: null, ctx: CTX })
    s.rehydrate({ record: { id: 1, name: 'a' }, ctx: { userType: 'member', plan: 'pro' } })
    expect(s.getFrontendCtx()).toEqual({ userType: 'member', plan: 'pro' })
  })

  it('useForm lifts ctx off the envelope like abilities/can', () => {
    let handle: any
    function Probe() {
      handle = useForm({
        draft: { id: 1, name: 'a' }, mode: 'edit',
        envelope: { abilities: { name: 'edit' }, ctx: CTX },
      })
      return null
    }
    render(<Probe />)
    expect(handle.$session.getFrontendCtx()).toEqual(CTX)
  })
})

describe('every presenter receives props.ctx', () => {
  it('a rendered Field hands the presenter the bag', () => {
    let got: any
    registerPresenter('probe', { kind: '*', component: (p: any) => { got = p.ctx; return null } })
    setDefaultPresenters({ string: { edit: 'probe', view: 'probe' } })
    const session = new FormSession({
      draft: { id: 1, name: 'a' }, mode: 'edit',
      abilities: { name: 'edit' }, ctx: CTX,
    })
    const handle: any = createFormHandle(session, { fieldMeta: { name: { kind: 'string' } } })
    render(<handle.name edit />)
    expect(got).toEqual(CTX)
  })

  it('the testing kit mirrors the contract (fixtures stay honest)', () => {
    const s = createTestSession({ name: { kind: 'string' } })
    ;(s as any).frontendCtx = CTX          // arranged session state
    const props = buildTestProps(s, { name: { kind: 'string' } }, 'name')
    expect(props.ctx).toEqual(CTX)
    // and the default is {} — presenters may destructure unconditionally
    const bare = buildTestProps(createTestSession({ name: { kind: 'string' } }), { name: { kind: 'string' } }, 'name')
    expect(bare.ctx).toEqual({})
  })
})

describe('index surface', () => {
  it('use() exposes the response-level ctx (computed once, not per row)', () => {
    const S = createIndexSurface({
      meta: {},
      useIndexQuery: () => ({
        data: { data: [{ id: 1 }], pagination: null, ctx: CTX },
        isLoading: false, isError: false,
      }),
      makeRowHandle: () => ({}),
    })
    let api: any
    const Probe = () => { api = (S as any).use(); return null }
    render(<S.Index><Probe /></S.Index>)
    expect(api.ctx).toEqual(CTX)
  })
})
