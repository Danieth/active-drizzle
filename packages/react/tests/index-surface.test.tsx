import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createIndexSurface, FormSession, createFormHandle, registerPresenter, setDefaultPresenters, clearPresenters, type PresenterProps } from '../src/index.js'

function TextView({ value }: PresenterProps) { return <span>{String(value ?? '')}</span> }
beforeEach(() => {
  clearPresenters()
  registerPresenter('textView', { kind: '*', component: TextView })
  setDefaultPresenters({ string: { view: 'textView' } })
})

class RowClient { constructor(attrs: any) { Object.assign(this, attrs) } }

const Deals = createIndexSurface({
  meta: { searchable: true, filters: { stage: { kind: 'facet', label: 'Stage', options: ['draft', 'won'] } } },
  useIndexQuery: () => ({ data: { data: [{ id: 1, name: 'Acme', stage: 'draft' }], pagination: { page: 0, totalPages: 1, hasMore: false } }, isLoading: false, isError: false }),
  makeRowHandle: (row) => createFormHandle(
    new FormSession({ draft: new RowClient(row) as any, mode: 'edit', abilities: null }),
    { fieldMeta: { name: { kind: 'string' } } },
  ),
})

describe('surface probe', () => {
  it('renders items + filters + search', () => {
    render(
      <Deals.Index>
        <Deals.Search />
        <Deals.Filters />
        <Deals.Items>{(d: any) => <d.name view />}</Deals.Items>
        <Deals.Pagination />
      </Deals.Index>,
    )
    expect(screen.getByText('Acme')).toBeTruthy()
  })
})

describe('filter presenter SOCKET (mirrors form presenters)', async () => {
  const { registerFilterPresenter, setDefaultFilterPresenters, clearFilterPresenters } = await import('../src/index.js')

  function makeSurface() {
    return createIndexSurface({
      meta: { searchable: false, filters: {
        stage: { kind: 'facet', label: 'Stage', options: ['draft', 'won'] },
        hot: { kind: 'toggle', label: 'Hot' },
      } },
      useIndexQuery: () => ({ data: { data: [], pagination: null }, isLoading: false, isError: false }),
      makeRowHandle: (r) => r,
    })
  }

  it('scaffolding renders by default and is LABELED as scaffolding', () => {
    clearFilterPresenters()
    const S = makeSurface()
    render(<S.Index><S.Filters /></S.Index>)
    expect(document.querySelectorAll('[data-ad-scaffold]').length).toBeGreaterThan(0)
  })

  it('a registered kind-default REPLACES scaffolding for every matching filter', () => {
    clearFilterPresenters()
    registerFilterPresenter('segmented', { kind: 'facet', component: ({ name }) => <b data-custom={name}>SEG</b> })
    setDefaultFilterPresenters({ facet: 'segmented' })
    const S = makeSurface()
    render(<S.Index><S.Filters /></S.Index>)
    expect(document.querySelector('[data-custom="stage"]')).toBeTruthy()          // custom took over
    expect(document.querySelector('[data-ad-filter="stage"][data-ad-scaffold]')).toBeNull()
    expect(document.querySelector('[data-ad-filter="hot"][data-ad-scaffold]')).toBeTruthy()  // toggle still scaffold
    clearFilterPresenters()
  })

  it('per-site presenter override + kind gating', () => {
    clearFilterPresenters()
    registerFilterPresenter('special', { kind: 'facet', component: () => <i data-special /> })
    const S = makeSurface()
    render(<S.Index><S.Filters.stage presenter="special" /></S.Index>)
    expect(document.querySelector('[data-special]')).toBeTruthy()
    // a facet presenter on a toggle filter must throw (kind gate)
    expect(() => render(<S.Index><S.Filters.hot presenter="special" /></S.Index>)).toThrow(/serves kind/)
    clearFilterPresenters()
  })

  it('the render-prop Filter yields raw state — no registry involved', () => {
    clearFilterPresenters()
    const S = makeSurface()
    let got: any = null
    render(
      <S.Index>
        <S.Filter name="stage">{(p) => { got = p; return <u>{String(p.value ?? 'none')}</u> }}</S.Filter>
      </S.Index>,
    )
    expect(got.meta.kind).toBe('facet')
    expect(typeof got.set).toBe('function')
    expect(typeof got.clear).toBe('function')
  })
})
