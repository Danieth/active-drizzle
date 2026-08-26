/**
 * Regression suite (component lane) for the `react` cluster:
 *   - PresenterContextProvider must memoize its bag/stack identity so an
 *     ancestor render does not re-render every field on the page.
 *   - The index context memo must include isFetching so the keepPreviousData
 *     "refreshing" signal reaches Surface.use().
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  PresenterContextProvider,
  useClientPresenterCtx,
  usePresenterLayoutStack,
  definePresenterContext,
} from '../src/presenter-context.js'
import { createIndexSurface } from '../src/index-surface.js'

// ── Bug: PresenterContextProvider rebuilds identity every render ─────────────

describe('PresenterContextProvider — stable identity', () => {
  it('reuses the same bag object across an ancestor re-render (no field re-render storm)', () => {
    const map = definePresenterContext({ density: () => 'compact' })
    const bags: unknown[] = []
    const Capture: React.FC = () => {
      bags.push(useClientPresenterCtx())
      return null
    }
    let force!: () => void
    const Wrapper: React.FC = () => {
      const [, setN] = React.useState(0)
      force = () => setN((n) => n + 1)
      return (
        <PresenterContextProvider map={map}>
          <Capture />
        </PresenterContextProvider>
      )
    }
    render(<Wrapper />)
    act(() => { force() })

    expect(bags.length).toBeGreaterThanOrEqual(2)
    // Same computed inputs → identical bag reference → context consumers idle.
    expect(bags[bags.length - 1]).toBe(bags[0])
  })

  it('reuses the same layout stack across an ancestor re-render', () => {
    const Layout: React.FC<any> = ({ children }) => <>{children}</>
    const map = definePresenterContext({ k: () => 1 }, { layout: Layout, consumes: ['errors'] })
    const stacks: unknown[] = []
    const Capture: React.FC = () => {
      stacks.push(usePresenterLayoutStack())
      return null
    }
    let force!: () => void
    const Wrapper: React.FC = () => {
      const [, setN] = React.useState(0)
      force = () => setN((n) => n + 1)
      return (
        <PresenterContextProvider map={map}>
          <Capture />
        </PresenterContextProvider>
      )
    }
    render(<Wrapper />)
    act(() => { force() })

    expect(stacks[stacks.length - 1]).toBe(stacks[0])
  })
})

// ── Bug: index context memo omits isFetching ─────────────────────────────────

describe('index surface — isFetching propagation', () => {
  it('surfaces a keepPreviousData refetch (isFetching flips while data is stable)', () => {
    let fetching = true
    const stableData = { data: [], pagination: null }
    const surface = createIndexSurface({
      meta: {},
      useIndexQuery: () => ({ data: stableData, isLoading: false, isError: false, isFetching: fetching }),
      makeRowHandle: (r: Record<string, any>) => r,
    })

    const seen: boolean[] = []
    const Probe: React.FC = () => {
      const { isFetching } = surface.use()
      seen.push(isFetching)
      return null
    }
    const el = (
      <surface.Index>
        <Probe />
      </surface.Index>
    )
    const { rerender } = render(el)

    // The background refetch settles — data identity unchanged, only isFetching.
    fetching = false
    act(() => {
      rerender(
        <surface.Index>
          <Probe />
        </surface.Index>,
      )
    })

    expect(seen[seen.length - 1]).toBe(false)
  })
})
