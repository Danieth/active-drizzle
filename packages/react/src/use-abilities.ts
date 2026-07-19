/**
 * useAbilities — the envelope's permission verdicts as a hook, for logic
 * that lives outside a field (menus, toolbars, layout branches):
 *
 *   const { canEdit, can } = useAbilities(deal)
 *   {can('markWon') && <ExplainerPanel/>}
 *
 * Reads the SAME mask the server enforces — the client can only narrow;
 * every write/action is re-checked at dispatch.
 */
import { useSyncExternalStore } from 'react'
import type { FormSession } from './form-session.js'

export interface Abilities {
  /** Field-level edit verdict (abilities mask; new/ungoverned → true). */
  canEdit: (field: string) => boolean
  /** Action verdict: state events AND @mutations (can map; ungoverned → allow). */
  can: (action: string) => boolean
  /** True when an envelope's can map governs this session. */
  governed: boolean
}

export function useAbilities(formOrSession: { $session?: FormSession<any> } | FormSession<any>): Abilities {
  const session: FormSession<any> =
    (formOrSession as any)?.$session ?? (formOrSession as FormSession<any>)
  useSyncExternalStore(
    (cb) => session.subscribe('*', cb),
    () => session.fieldVersion('*'),
    () => session.fieldVersion('*'),
  )
  return {
    canEdit: (field: string) => session.canEdit(field),
    can: (action: string) => session.verdict(action),
    governed: (session as any).canGoverned === true,
  }
}
