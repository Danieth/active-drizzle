/**
 * Generic UI components for active-drizzle.
 *
 * ModelCombobox — searchable, multi-selectable combobox for model records.
 * SearchBar      — search input wired to a search state.
 * IntersectionTrigger — infinite scroll trigger.
 *
 * These are minimal, headless-friendly components styled with Tailwind.
 * Projects can replace them with their own design system components.
 */
import React, {
  useState, useEffect, useRef, useCallback, type FC, type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ComboboxOption {
  id: number | string
  label: string
  [key: string]: any
}

export interface ComboboxConfig {
  /** Fetch options for the combobox (returns {data, pagination}) */
  searchFn: (query: string) => Promise<{ data: ComboboxOption[] }>
  /** Cache key prefix for React Query */
  queryKeyPrefix: string[]
  /** Placeholder text */
  placeholder?: string
}

// ── ModelCombobox ─────────────────────────────────────────────────────────────

export interface ModelComboboxProps {
  value: (number | string)[] | number | string | null | undefined
  onChange: (value: (number | string)[] | number | string | null) => void
  combobox: ComboboxConfig
  isMulti?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}

export const ModelCombobox: FC<ModelComboboxProps> = ({
  value,
  onChange,
  combobox,
  isMulti = false,
  placeholder,
  disabled = false,
  className = '',
}) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ComboboxOption[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const selectedIds = Array.isArray(value) ? value : value != null ? [value] : []

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const cacheKey = [...combobox.queryKeyPrefix, 'combobox', query]
        const result = await queryClient.fetchQuery({
          queryKey: cacheKey,
          queryFn: () => combobox.searchFn(query),
          staleTime: 30_000,
        })
        setOptions(result.data)
      } catch (e) {
        console.error('[ModelCombobox] Error fetching options', e)
        setOptions([])
      } finally {
        setLoading(false)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [query, open, combobox, queryClient])

  const toggle = (id: number | string) => {
    if (!isMulti) {
      onChange(id)
      setOpen(false)
      return
    }
    const next = selectedIds.includes(id)
      ? selectedIds.filter(v => v !== id)
      : [...selectedIds, id]
    onChange(next)
  }

  const removeSelected = (id: number | string) => {
    const next = selectedIds.filter(v => v !== id)
    onChange(isMulti ? next : null)
  }

  return (
    <div className={`relative ${className}`}>
      <div
        className="flex flex-wrap gap-1 min-h-9 px-3 py-1.5 border border-input rounded-md bg-background cursor-text"
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus() } }}
      >
        {selectedIds.map(id => {
          const opt = options.find(o => o.id === id)
          const label = opt?.label ?? String(id)
          return (
            <span key={id} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-sm rounded px-1.5">
              {label}
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeSelected(id) }}
                className="text-primary/70 hover:text-primary"
              >
                ×
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={selectedIds.length === 0 ? (placeholder ?? combobox.placeholder ?? 'Search…') : ''}
          disabled={disabled}
          className="flex-1 min-w-20 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-popover border border-border rounded-md shadow-lg max-h-60 overflow-auto">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          ) : options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No results</div>
          ) : (
            options.map(opt => (
              <button
                key={opt.id}
                type="button"
                onMouseDown={e => { e.preventDefault(); toggle(opt.id) }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground flex items-center gap-2 ${selectedIds.includes(opt.id) ? 'text-primary font-medium' : ''}`}
              >
                {selectedIds.includes(opt.id) && <span className="text-primary">✓</span>}
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── SearchBar ─────────────────────────────────────────────────────────────────

export interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  debounce?: number
  className?: string
}

export const SearchBar: FC<SearchBarProps> = ({
  value,
  onChange,
  placeholder = 'Search…',
  debounce = 300,
  className = '',
}) => {
  const [local, setLocal] = useState(value)

  useEffect(() => setLocal(value), [value])

  useEffect(() => {
    const timer = setTimeout(() => onChange(local), debounce)
    return () => clearTimeout(timer)
  }, [local, debounce, onChange])

  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        ⌕
      </span>
      <input
        type="search"
        value={local}
        onChange={e => setLocal(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
      />
      {local && (
        <button
          type="button"
          onClick={() => { setLocal(''); onChange('') }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── IntersectionTrigger ───────────────────────────────────────────────────────

export interface IntersectionTriggerProps {
  onVisible: () => void
  /** Root margin (default: 200px) */
  rootMargin?: string
  children?: ReactNode
  className?: string
}

export const IntersectionTrigger: FC<IntersectionTriggerProps> = ({
  onVisible,
  rootMargin = '200px',
  children,
  className = '',
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const onVisibleRef = useRef(onVisible)
  useEffect(() => { onVisibleRef.current = onVisible }, [onVisible])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) onVisibleRef.current() },
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

// ── ScopeToggle ───────────────────────────────────────────────────────────────

export interface ScopeToggleProps {
  scope: string
  active: boolean
  onToggle: (scope: string, active: boolean) => void
  label?: string
  className?: string
}

export const ScopeToggle: FC<ScopeToggleProps> = ({
  scope,
  active,
  onToggle,
  label,
  className = '',
}) => (
  <button
    type="button"
    onClick={() => onToggle(scope, !active)}
    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
      active
        ? 'bg-primary text-primary-foreground'
        : 'bg-muted text-muted-foreground hover:bg-muted/80'
    } ${className}`}
  >
    {label ?? scope}
  </button>
)
