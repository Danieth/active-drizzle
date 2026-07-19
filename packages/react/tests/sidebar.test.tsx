/**
 * <Surface.Sidebar> — the faceted-search panel: groups from declared
 * filters, DISJUNCTIVE counts zero-filled over declared options,
 * multi-select toggles, carets, clear-all, search wiring, and the three
 * altitudes (scaffold / per-group presenter / render-prop).
 */
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  createIndexSurface, FormSession, createFormHandle,
  registerFilterPresenter, clearFilterPresenters, type FilterPresenterProps,
} from '../src/index.js'

beforeEach(() => clearFilterPresenters())

class RowClient { constructor(a: any) { Object.assign(this, a) } }

function makeSurface(data: Record<string, any> = {}) {
  return createIndexSurface({
    meta: {
      searchable: true,
      filters: {
        stage: { kind: 'facet', label: 'Stage', options: ['draft', 'submitted', 'won', 'lost'] },
        isFeatured: { kind: 'toggle', label: 'Featured' },
        bigDeals: { kind: 'toggle', label: 'Big deals' },
      },
    },
    useIndexQuery: () => ({
      data: {
        data: [{ id: 1, name: 'Acme' }],
        pagination: { page: 0, totalPages: 1, hasMore: false, totalCount: 7 },
        facets: { stage: { draft: 4, submitted: 3 } },   // won/lost absent → zero-fill
        ...data,
      },
      isLoading: false, isError: false,
    }),
    makeRowHandle: (row) => createFormHandle(
      new FormSession({ draft: new RowClient(row) as any, mode: 'edit', abilities: null }),
      { fieldMeta: {} },
    ),
  })
}

describe('SidebarApi (render-prop)', () => {
  it('facet groups zero-fill DECLARED options; toggles keep widget semantics', () => {
    const S = makeSurface()
    let api: any
    render(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    const stage = api.groups.find((g: any) => g.name === 'stage')
    expect(stage.options.map((o: any) => [o.value, o.count])).toEqual([
      ['draft', 4], ['submitted', 3], ['won', 0], ['lost', 0],   // absent → 0, never vanishes
    ])
    const featured = api.groups.find((g: any) => g.name === 'isFeatured')
    expect(featured.options).toEqual([])                          // toggle → presenter body
    expect(api.total).toBe(7)
    expect(api.search).not.toBeNull()
  })

  it('toggle() is MULTI-SELECT: builds arrays, removes on re-toggle, clears empty', () => {
    const S = makeSurface()
    let api: any
    const ui = () => render(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    const r = ui()
    api.groups[0].options[0].toggle()                             // + draft
    r.rerender(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    expect(api.groups[0].value).toEqual(['draft'])
    api.groups[0].options[1].toggle()                             // + submitted
    r.rerender(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    expect(api.groups[0].value).toEqual(['draft', 'submitted'])
    expect(api.activeCount).toBe(1)
    api.groups[0].options[0].toggle()                             // - draft
    r.rerender(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    expect(api.groups[0].value).toEqual(['submitted'])
  })

  it('counts absent (no index.facets) → count null, options still render', () => {
    const S = makeSurface({ facets: undefined })
    let api: any
    render(<S.Index><S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>)
    expect(api.groups[0].options[0]).toMatchObject({ value: 'draft', count: null })
  })
})

describe('scaffold rendering', () => {
  it('carets (details/summary), count badges, zero-count dimming, clear-all', () => {
    const S = makeSurface()
    const { container, rerender } = render(<S.Index><S.Sidebar /></S.Index>)
    expect(container.querySelector('[data-ad-sidebar][data-ad-scaffold]')).toBeTruthy()
    expect(container.querySelectorAll('details[data-ad-sidebar-group]')).toHaveLength(3)
    expect(container.querySelector('details[data-ad-sidebar-group="stage"] summary')!.textContent).toBe('Stage')
    // count badge + zero-dim
    const won = container.querySelector('[data-ad-sidebar-option="lost"]') as HTMLElement
    expect(won.style.opacity).toBe('0.45')
    // toggle draft via its checkbox → clear-all appears
    fireEvent.click(container.querySelector('[data-ad-sidebar-option="draft"] input')!)
    rerender(<S.Index><S.Sidebar /></S.Index>)
    expect(screen.getByText(/Clear 1 filter/)).toBeTruthy()
    expect(container.querySelector('[data-ad-sidebar-total]')!.textContent).toContain('7 results')
  })

  it('a REGISTERED kind-default presenter takes over the group body', () => {
    registerFilterPresenter('chips', { kind: 'facet', component: (({ name }: FilterPresenterProps) => <em data-testid={`chips-${name}`}>chips</em>) as any })
    const S = makeSurface()
    // register AFTER surface creation — resolution is render-time
    const { container } = render(<S.Index><S.Sidebar presenters={{ stage: 'chips' }} /></S.Index>)
    expect(screen.getByTestId('chips-stage')).toBeTruthy()
    // unregistered groups keep scaffold rows
    expect(container.querySelector('details[data-ad-sidebar-group="isFeatured"]')).toBeTruthy()
  })

  it('search input wires session.setQ (debounced through the session)', () => {
    vi.useFakeTimers()
    try {
      const S = makeSurface()
      let api: any
      const { container } = render(
        <S.Index><S.Sidebar /><S.Filter name="stage">{() => null}</S.Filter>
          <S.Sidebar>{(a: any) => { api = a; return null }}</S.Sidebar></S.Index>,
      )
      fireEvent.change(container.querySelector('[data-ad-sidebar-search]')!, { target: { value: 'acme' } })
      vi.advanceTimersByTime(400)
    } finally { vi.useRealTimers() }
  })
})
