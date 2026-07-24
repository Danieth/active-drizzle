/**
 * Folder-scoped presenter context — the CLIENT lane of props.ctx.
 *
 * Every folder in the presenter tree may hold a `context.ts`:
 *
 *   // presenters/context.ts — app-wide
 *   export default definePresenterContext({
 *     density: () => useUiStore(s => s.density),   // hooks are fine — these
 *   })                                              // run during render
 *
 *   // presenters/models/Deal/context.ts — Deal-area only
 *   export default definePresenterContext({
 *     stageColors: () => DEAL_STAGE_COLORS,
 *   })
 *
 * The generated registry (codegen) discovers every file, verifies that NO
 * nested folder redeclares an ancestor's key (a collision is a regen
 * teaching error naming both files — ctx.density means ONE thing
 * everywhere), mounts the app-wide entries through
 * <PresenterContextProvider>, and wraps each folder's presenters so they
 * see their area's keys. Presenters just read props.ctx — the client lane
 * and the server lane (@frontendContext) arrive merged, and the generated
 * types make every key autocomplete.
 */
import React, { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { PresenterProps } from './presenters.js'

export type PresenterContextMap = Record<string, () => unknown>

/** The chrome responsibilities LAW 3 governs (DESIGN-presenter-tree §3). */
export const CHROME_RESPONSIBILITIES = ['label', 'errors', 'dirty', 'state', 'elsewhere', 'help'] as const
export type ChromeResponsibility = (typeof CHROME_RESPONSIBILITIES)[number]

export interface PresenterContextOpts {
  /** This folder's LAYOUT — wraps every presenter beside/below. ORDER
   *  (Daniel's rule): the file's context keys establish BEFORE this
   *  layout, so it may read its own folder's ctx. */
  layout?: ComponentType<PresenterProps & { children?: ReactNode }>
  /** Chrome responsibilities this layout CONSUMES — the bulb receives the
   *  remainder; regen enforces every-path coverage and no double-claims. */
  consumes?: ChromeResponsibility[]
}

export const PRESENTER_CONTEXT_OPTS = Symbol('ad:presenterContextOpts')

/**
 * Declares one folder's context entries (+ optionally its LAYOUT).
 * Runtime: returns the map with the layout/consumes stashed under a
 * symbol. Codegen: the ONE recognizable marker — keys, checker types,
 * consumes, and layout presence are all read statically from this call.
 */
export function definePresenterContext<T extends PresenterContextMap>(map: T, opts?: PresenterContextOpts): T {
  if (opts) Object.defineProperty(map, PRESENTER_CONTEXT_OPTS, { value: opts, enumerable: false })
  return map
}

interface LayerEntry { layout: ComponentType<PresenterProps & { children?: ReactNode }>; consumes: ChromeResponsibility[] }
const ClientCtx = createContext<Record<string, unknown>>({})
const LayoutStack = createContext<LayerEntry[]>([])

/**
 * Layers one context map (and its layout, when declared) over the current
 * bag — the generated registry drives this for the root and each area.
 * Keys establish BEFORE the layout joins the stack (provider outside).
 */
export function PresenterContextProvider({ map, children }: { map: PresenterContextMap; children?: ReactNode }): React.JSX.Element {
  const parent = useContext(ClientCtx)
  const parentStack = useContext(LayoutStack)
  const bag: Record<string, unknown> = { ...parent }
  for (const [key, fn] of Object.entries(map)) bag[key] = fn()
  const opts = (map as any)[PRESENTER_CONTEXT_OPTS] as PresenterContextOpts | undefined
  const stack = opts?.layout
    ? [...parentStack, { layout: opts.layout, consumes: opts.consumes ?? [] }]
    : parentStack
  return (
    <ClientCtx.Provider value={bag}>
      <LayoutStack.Provider value={stack}>{children}</LayoutStack.Provider>
    </ClientCtx.Provider>
  )
}

/** The merged client-lane bag visible where this hook runs. */
export function useClientPresenterCtx(): Record<string, unknown> {
  return useContext(ClientCtx)
}

/** The layout layers above this point, OUTERMOST first. */
export function usePresenterLayoutStack(): ReadonlyArray<{ layout: ComponentType<PresenterProps & { children?: ReactNode }>; consumes: ChromeResponsibility[] }> {
  return useContext(LayoutStack)
}

/** Wrap a rendered bulb in the active layout stack (outer → inner). */
export function wrapInLayoutStack(
  stack: ReadonlyArray<{ layout: ComponentType<PresenterProps & { children?: ReactNode }> }>,
  props: PresenterProps,
  bulb: ReactNode,
): ReactNode {
  let out = bulb
  for (let i = stack.length - 1; i >= 0; i--) {
    const Layout = stack[i]!.layout
    out = <Layout {...props}>{out}</Layout>
  }
  return out
}
