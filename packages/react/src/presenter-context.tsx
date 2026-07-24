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
import React, { createContext, useContext, type ReactNode } from 'react'

export type PresenterContextMap = Record<string, () => unknown>

/**
 * Declares one folder's context entries. Identity at runtime — its job is
 * the TYPE capture (codegen reads the entry keys + checker return types)
 * and being the ONE recognizable marker the scanner looks for.
 */
export function definePresenterContext<T extends PresenterContextMap>(map: T): T {
  return map
}

const ClientCtx = createContext<Record<string, unknown>>({})

/**
 * Layers one context map over the current bag — the generated registry
 * uses this for the app root AND for each folder area. Entry functions run
 * every render (they may call hooks; keep them cheap or memoized).
 */
export function PresenterContextProvider({ map, children }: { map: PresenterContextMap; children?: ReactNode }): React.JSX.Element {
  const parent = useContext(ClientCtx)
  const bag: Record<string, unknown> = { ...parent }
  for (const [key, fn] of Object.entries(map)) bag[key] = fn()
  return <ClientCtx.Provider value={bag}>{children}</ClientCtx.Provider>
}

/** The merged client-lane bag visible where this hook runs. */
export function useClientPresenterCtx(): Record<string, unknown> {
  return useContext(ClientCtx)
}
