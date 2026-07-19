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
