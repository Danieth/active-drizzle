/**
 * The derived surfaces: Board (state machine → columns + legal moves),
 * Chart/Metric (data-to-presenter), Empty (knows WHY), Error (parsed),
 * Table (grid contract), facet counts into FilterPresenterProps.
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createIndexSurface, FormSession, createFormHandle } from '../src/index.js'

class RowClient { constructor(attrs: any) { Object.assign(this, attrs) } }

const ROWS = [
  { id: 1, name: 'Acme', stage: 'draft', amount: 100 },
  { id: 2, name: 'Initech', stage: 'submitted', amount: 50 },
]

function makeSurface(over: Record<string, any> = {}, data: Record<string, any> = {}) {
  return createIndexSurface({
    meta: { sortable: ['name'], searchable: false, filters: { stage: { kind: 'facet', label: 'Stage', options: ['draft', 'submitted', 'won'] } } },
    useIndexQuery: () => ({
      data: { data: ROWS, pagination: { page: 0, totalPages: 1, hasMore: false }, facets: { stage: { draft: 4, submitted: 2 } }, ...data },
      isLoading: false, isError: false,
    }),
    makeRowHandle: (row) => createFormHandle(
      new FormSession({ draft: new RowClient(row) as any, mode: 'edit', abilities: null }),
      { fieldMeta: { name: { kind: 'string' } } },
    ),
    stateMeta: {
      field: 'stage',
      states: ['draft', 'submitted', 'won'],
      transitions: [
        { event: 'submit', from: ['draft'], to: 'submitted' },
        { event: 'win', from: ['submitted'], to: 'won' },
        { event: 'reopen', from: '*', to: 'draft' },
      ],
    },
    fields: [
      { name: 'name', kind: 'string', label: 'Deal Name' },
      { name: 'stage', kind: 'state', label: 'Stage' },
    ],
    ...over,
  })
}

describe('<Board> — the state machine as columns', () => {
  it('groups rows into state columns with facet counts; moves resolve TRANSITIONS', async () => {
    const mutateRow = vi.fn().mockResolvedValue({})
    const S = makeSurface({ mutateRow })
    let api: any
    render(<S.Index><S.Board>{(b: any) => { api = b; return null }}</S.Board></S.Index>)
    expect(api.columns.map((c: any) => c.key)).toEqual(['draft', 'submitted', 'won'])
    expect(api.columns[0].rows.map((r: any) => r.id)).toEqual([1])
    expect(api.columns[0].count).toBe(4)                        // facet count, not page-local
    // legality is the transition graph
    expect(api.canMove(ROWS[0], 'submitted')).toBe(true)        // draft → submit
    expect(api.canMove(ROWS[0], 'won')).toBe(false)             // no draft → won edge
    await api.move(ROWS[1], 'won')                              // submitted → win
    expect(mutateRow).toHaveBeenCalledWith(2, { _event: 'win' })
    await api.move(ROWS[1], 'draft')                            // '*' → reopen
    expect(mutateRow).toHaveBeenCalledWith(2, { _event: 'reopen' })
  })

  it('non-state groupBy PATCHes the column value instead of advancing', async () => {
    const mutateRow = vi.fn().mockResolvedValue({})
    const S = makeSurface({ mutateRow, stateMeta: undefined })
    let api: any
    render(<S.Index><S.Board groupBy="stage">{(b: any) => { api = b; return null }}</S.Board></S.Index>)
    await api.move(ROWS[0], 'submitted')
    expect(mutateRow).toHaveBeenCalledWith(1, { stage: 'submitted' })
  })

  it('scaffold rendering shows only LEGAL move buttons', () => {
    const S = makeSurface({ mutateRow: vi.fn() })
    const { container } = render(<S.Index><S.Board /></S.Index>)
    expect(container.querySelector('[data-ad-board]')).toBeTruthy()
    const draftCard = container.querySelector('[data-ad-board-column="draft"] [data-ad-board-card]')!
    expect([...draftCard.querySelectorAll('button')].map(b => b.textContent)).toEqual(['→ submitted'])
  })
})

describe('<Chart>/<Metric> — aggregation points, no chart lib', () => {
  it('Chart hands points to the render-prop; Metric hands the scalar', () => {
    const S = makeSurface({}, { chart: [{ x: 'draft', y: 3 }], metric: '150.00' })
    let points: any, value: any
    render(
      <S.Index>
        <S.Chart x="stage">{(p: any) => { points = p; return null }}</S.Chart>
        <S.Metric agg="sum:amount">{(v: any) => { value = v; return null }}</S.Metric>
      </S.Index>,
    )
    expect(points).toEqual([{ x: 'draft', y: 3 }])
    expect(value).toBe('150.00')
  })

  it('works OUTSIDE <Index> too (standalone aggregation)', () => {
    const S = makeSurface({}, { metric: 7 })
    let value: any
    render(<S.Metric agg="count">{(v: any) => { value = v; return null }}</S.Metric>)
    expect(value).toBe(7)
  })
})

describe('<Empty> knows WHY · <Error> parses · <Table> contract', () => {
  it('Empty renders the server reason with clear-filters for no-matches', () => {
    const S = createIndexSurface({
      meta: {},
      useIndexQuery: () => ({ data: { data: [], pagination: null, emptyReason: 'no-matches' }, isLoading: false, isError: false }),
      makeRowHandle: () => ({}),
    })
    const { container } = render(<S.Index><S.Empty /></S.Index>)
    expect(container.querySelector('[data-ad-empty="no-matches"]')).toBeTruthy()
    expect(screen.getByText('Clear filters')).toBeTruthy()
  })

  it('Error yields the parsed kind', () => {
    const S = createIndexSurface({
      meta: {},
      useIndexQuery: () => ({ data: null, isLoading: false, isError: true, error: { code: 'FORBIDDEN', message: 'no access' } } as any),
      makeRowHandle: () => ({}),
    })
    let e: any
    render(<S.Index><S.Error>{(err: any) => { e = err; return <em>err</em> }}</S.Error></S.Index>)
    expect(e.kind).toBe('forbidden')
    expect(e.message).toBe('no access')
  })

  it('Table: columns from field meta, sortable flags, setSort round-trips', () => {
    const S = makeSurface()
    let api: any
    render(<S.Index><S.Table>{(t: any) => { api = t; return null }}</S.Table></S.Index>)
    expect(api.columns).toEqual([
      { name: 'name', label: 'Deal Name', kind: 'string', sortable: true },
      { name: 'stage', label: 'Stage', kind: 'state', sortable: false },
    ])
    expect(api.rows).toHaveLength(2)
    api.setSort('name')
    // scaffold table renders sortable header as a button
    const { container } = render(<S.Index><S.Table /></S.Index>)
    expect(container.querySelector('table[data-ad-table]')).toBeTruthy()
    expect(screen.getAllByText(/Deal Name/).length).toBeGreaterThan(0)
  })

  it('facet counts reach the Filter render-prop', () => {
    const S = makeSurface()
    let counts: any
    render(<S.Index><S.Filter name="stage">{(p: any) => { counts = p.counts; return null }}</S.Filter></S.Index>)
    expect(counts).toEqual({ draft: 4, submitted: 2 })
  })
})

describe('<Can> + skeletons', () => {
  it('Can gates on abilities and can-map; not= inverts; fallback renders', () => {
    const session = new FormSession({
      draft: { id: 1, name: 'x' }, mode: 'edit',
      abilities: { name: 'view' }, can: { markWon: false }, version: '1',
    })
    const handle: any = createFormHandle(session, { fieldMeta: { name: { kind: 'string' } } })
    render(
      <>
        <handle.Can edit="name"><span>editable</span></handle.Can>
        <handle.Can edit="name" not><span>locked</span></handle.Can>
        <handle.Can action="markWon" fallback={<span>cannot win</span>}><span>can win</span></handle.Can>
      </>,
    )
    expect(screen.queryByText('editable')).toBeNull()
    expect(screen.getByText('locked')).toBeTruthy()
    expect(screen.getByText('cannot win')).toBeTruthy()
  })

  it('skeletons render one block per declared field', () => {
    const S = makeSurface()
    const { container } = render(<S.FormSkeleton />)
    expect(container.querySelectorAll('[data-ad-skeleton-field]')).toHaveLength(2)
    const list = render(<S.ListSkeleton rows={3} />)
    expect(list.container.querySelector('[data-ad-skeleton="list"]')!.children).toHaveLength(3)
  })
})
