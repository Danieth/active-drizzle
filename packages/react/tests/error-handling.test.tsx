/**
 * The client error lane (was 40%/13%/33% covered): parse → apply → report
 * → the one-call handleControllerError policy; useAbilities; cache keys +
 * recordOf; the ClientModel basics.
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import {
  parseControllerError, applyFormErrors, onClientError, reportClientError,
  handleControllerError, useAbilities, FormSession,
  modelCacheKeys, recordOf, ClientModel,
} from '../src/index.js'

const orpcErr = (code: string, status: number, message: string, data?: any) =>
  ({ code, status, message, data, name: 'ORPCError' })

describe('parseControllerError → handleControllerError (the policy)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('422 field errors: applied to a form when given one, first-field text when not', () => {
    const e = orpcErr('UNPROCESSABLE_ENTITY', 422, 'Unprocessable', { errors: { name: ['is required'] } })
    const metas: any = {}
    const form = { setFieldMeta: (f: string, up: any) => { metas[f] = up({}) } }
    expect(handleControllerError(e, { form })).toBeNull()          // routed into the form
    expect(metas.name.errors).toEqual(['is required'])
    expect(handleControllerError(e)).toBe('name is required')      // no form → readable text
  })

  it('404/401/403/400 return the server message; 500s report + generic text', () => {
    expect(handleControllerError(orpcErr('NOT_FOUND', 404, 'Deal not found')))
      .toBe('Deal not found')
    const seen: any[] = []
    const off = onClientError((err, ctx) => seen.push({ err, ctx }))
    try {
      const msg = handleControllerError(orpcErr('INTERNAL_SERVER_ERROR', 500, 'boom stack'))
      expect(msg).toBe('Something went wrong. Please try again.')  // never the raw 500
      expect(seen).toHaveLength(1)                                  // …but the tracker got it
    } finally { off() }
  })

  it('reportClientError: console fallback with no handlers; a throwing handler cannot break the fan-out', () => {
    const con = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportClientError(new Error('x'))
    expect(con).toHaveBeenCalled()                                  // fallback lane
    const good = vi.fn()
    const off1 = onClientError(() => { throw new Error('handler bug') })
    const off2 = onClientError(good)
    try {
      reportClientError(new Error('y'))
      expect(good).toHaveBeenCalled()                               // survived the bad sibling
    } finally { off1(); off2() }
  })

  it('non-controller garbage parses to null and falls to the generic lane', () => {
    expect(parseControllerError('a string')).toBeNull()
    expect(parseControllerError(undefined)).toBeNull()
  })
})

describe('useAbilities — the mask outside a field (menus, toolbars)', () => {
  it('reads canEdit/can from the session; governed reflects a can-map arrival', () => {
    const session = new FormSession({
      draft: { id: 1, name: 'a' }, mode: 'edit',
      abilities: { name: 'edit', stage: 'view' }, can: { markWon: false },
    })
    let got: any
    function Probe() { got = useAbilities(session); return null }
    render(<Probe />)
    expect(got.canEdit('name')).toBe(true)
    expect(got.canEdit('stage')).toBe(false)
    expect(got.can('markWon')).toBe(false)                          // server said no
    expect(got.governed).toBe(true)
    const bare = new FormSession({ draft: { id: 1 }, mode: 'edit', abilities: null })
    function Probe2() { got = useAbilities(bare); return null }
    render(<Probe2 />)
    expect(got.governed).toBe(false)
    expect(got.can('anything')).toBe(true)                          // ungoverned defaults allow
  })
})

describe('cache keys + recordOf + ClientModel basics', () => {
  it('modelCacheKeys: detail nests under root (coherence prefix-invalidation relies on it)', () => {
    const keys = modelCacheKeys<{ teamId: number }>('deals')
    const scopes = { teamId: 7 }
    expect(keys.detail(5, scopes)).toEqual(['deals', scopes, 5])
    expect(keys.list(scopes)).toEqual(['deals', scopes, 'list'])
    expect(keys.list(scopes, { q: 'x' })).toEqual(['deals', scopes, 'list', { q: 'x' }])
    expect(keys.singleton(scopes)).toEqual(['deals', scopes, 'singleton'])
    // every family shares the root prefix — one invalidation reaches all
    for (const k of [keys.detail(5, scopes), keys.list(scopes), keys.singleton(scopes)]) {
      expect(k.slice(0, 2)).toEqual(['deals', scopes])
    }
  })

  it('recordOf unwraps envelopes and passes bare records through (FIXES #5)', () => {
    expect(recordOf({ record: { id: 1 }, abilities: {} })).toEqual({ id: 1 })
    expect(recordOf({ id: 2 })).toEqual({ id: 2 })
    expect(recordOf(null)).toBeNull()
  })

  it('ClientModel: attrs become writable data props; set() returns a NEW instance; raw() bypasses', () => {
    class DealClient extends ClientModel<{ id: number; name: string }, { name: string }> {
      get name(): string { return 'VIRTUAL' }      // prototype accessor…
    }
    const c: any = new DealClient({ id: 1, name: 'a' })
    expect(c.name).toBe('a')                        // …shadowed by the data prop (drafts mutate)
    expect(c.raw('name')).toBe('a')
    c.name = 'b'                                    // draft mutation must NOT throw
    expect(c.name).toBe('b')
    const next: any = c.set({ name: 'z' })
    expect(next).not.toBe(c)                        // immutably NEW
    expect(next.raw('name')).toBe('z')
    expect(DealClient.fromArray([{ id: 2, name: 'x' }])[0]!.raw('id')).toBe(2)
    expect(c.toObject()).toEqual({ id: 1, name: 'a' })   // original attrs frozen
  })
})
