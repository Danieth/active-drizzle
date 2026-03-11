# UI Components

`@active-drizzle/react` ships headless-friendly components. All styling is done with Tailwind utility classes that you can override with `className` props.

## ModelCombobox

A searchable, optionally multi-select combobox backed by the generated `combobox` endpoint.

```tsx
import { ModelCombobox } from '@active-drizzle/react'
import { useAssets } from '../models/_generated/useAsset.gen'

const assets = useAssets(teamId)

// Single select
<ModelCombobox
  value={selectedId}
  onChange={setSelectedId}
  combobox={assets.combobox}
  placeholder="Pick an asset…"
/>

// Multi-select
<ModelCombobox
  value={selectedIds}
  onChange={setSelectedIds}
  combobox={assets.combobox}
  isMulti
  placeholder="Pick assets…"
/>
```

`combobox` is a function returned by the hook: `assets.combobox(q: string)` runs an oRPC `search` procedure and returns `Array<{ id, label }>`.

## SearchBar

Debounced input that calls `onSearch` with the latest value.

```tsx
import { SearchBar } from '@active-drizzle/react'

<SearchBar
  value={search.state.q}
  onSearch={q => search.set({ q })}
  placeholder="Search campaigns…"
  debounceMs={300}       // default 300
  className="w-full"
/>
```

## IntersectionTrigger

Fires `onVisible` when scrolled into view. Use at the bottom of a list for infinite scroll.

```tsx
import { IntersectionTrigger } from '@active-drizzle/react'

{hasNextPage && (
  <IntersectionTrigger
    onVisible={fetchNextPage}
    isLoading={isFetchingNextPage}
    threshold={0.1}          // IntersectionObserver threshold (default 0.1)
  />
)}
```

## ScopeToggle

Button that toggles a named scope in the search state.

```tsx
import { ScopeToggle } from '@active-drizzle/react'

<ScopeToggle
  scope="active"
  active={search.state.scopes.includes('active')}
  onToggle={scope => search.toggleScope(scope)}
>
  Active
</ScopeToggle>
```

Use multiple `ScopeToggle` buttons as a filter strip:

```tsx
{['draft', 'active', 'paused', 'completed'].map(s => (
  <ScopeToggle
    key={s}
    scope={s}
    active={search.state.scopes.includes(s)}
    onToggle={scope => search.toggleScope(scope)}
  >
    {capitalize(s)}
  </ScopeToggle>
))}
```
