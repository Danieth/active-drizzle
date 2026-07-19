/**
 * useGeneratedForm — the runtime engine behind generated use<Model>EditForm /
 * use<Model>NewForm hooks. Living here (not in generated output) means the
 * hard parts are tested once, and generated code stays a thin wiring layer.
 *
 * The three lifecycle rules:
 *
 *   1. IDENTITY — the session is keyed. Navigate deal 5 → deal 7 without
 *      unmounting and the handle rebuilds for the new record; the old
 *      session is simply dropped.
 *   2. REHYDRATION — a fresh payload for the SAME key (refetch, cache
 *      invalidation after another mutation) folds into the live session via
 *      applyEnvelope — unless the user has unsaved edits. A dirty draft is
 *      never clobbered by a background refetch.
 *   3. PURITY — FormSession/createFormHandle construction is side-effect
 *      free (no subscriptions until a component mounts a field), so the
 *      React-blessed adjust-state-during-render pattern is StrictMode and
 *      concurrent-rendering safe: discarded renders leak nothing.
 */
import { useEffect, useRef, useState } from 'react'
import { FormSession, type ServerEnvelope, type SubmitPayload, type SubmitResult } from './form-session.js'
import { createFormHandle, type FormHandle } from './form-handle.js'
import { defaultDraftStore } from './draft-store.js'

export interface UseGeneratedFormOptions<T extends Record<string, any>> {
  /** Identity — the session rebuilds when this changes (record id, or 'new'). */
  formKey: string | number
  mode: 'edit' | 'new'
  /** Latest server payload — envelope or bare record; null while loading. */
  data: any | null
  /** Build the draft from the payload's record (usually `new ModelClient(r)`). */
  makeDraft: (record: Record<string, any>) => T
  fieldMeta?: Record<string, Record<string, any>>
  submit?: (payload: SubmitPayload) => Promise<SubmitResult>
  validate?: (draft: T) => Record<string, string[]>
  /** Instant nested transports keyed by child resource (for instant nested writes). */
  nestedTransports?: Record<string, import('./nested.js').NestedTransport>
  /**
   * Draft parking key ("resource:id"). When set, unsaved edits PARK on
   * unmount and RESTORE (three-way, conflict-aware) on the next mount of
   * the same key — navigation stops eating drafts. Cleared automatically
   * when the form leaves clean. Pass nothing to disable.
   */
  draftKey?: string
}

/** Normalize a payload into envelope shape. */
function asEnvelope(data: any): ServerEnvelope {
  return data && typeof data === 'object' && 'record' in data ? data : { record: data }
}

export function useGeneratedForm<T extends Record<string, any>>(
  opts: UseGeneratedFormOptions<T>,
): { form: FormHandle<T> | null } {
  const [built, setBuilt] = useState<{
    key: string | number
    session: FormSession<T>
    handle: FormHandle<T>
  } | null>(null)
  // Payload already folded into the session — the rehydration effect skips it
  const appliedRef = useRef<any>(null)

  const canBuild = opts.mode === 'new' || opts.data != null

  // Adjust-state-during-render: rebuild when the key changes (or first data
  // arrives). Construction is pure, so discarded renders are garbage, not
  // leaks. NO early return — hook order must be identical every render.
  let active = built
  if (canBuild && (built === null || built.key !== opts.formKey)) {
    const envelope = opts.mode === 'new' ? {} : asEnvelope(opts.data)
    const session = new FormSession<T>({
      draft: opts.makeDraft((envelope as any).record ?? {}),
      mode: opts.mode,
      abilities: (envelope as any).abilities ?? null,
      can: (envelope as any).can ?? null,
      version: (envelope as any).version ?? null,
      ...(opts.submit ? { submit: opts.submit } : {}),
      ...(opts.validate ? { validate: opts.validate } : {}),
    })
    const handle = createFormHandle(session, {
      ...(opts.fieldMeta ? { fieldMeta: opts.fieldMeta } : {}),
      ...(opts.nestedTransports ? { nestedTransports: opts.nestedTransports } : {}),
    })
    // Parked draft from a previous visit? Replay it (three-way vs the
    // fresh baseline; a moved field keeps the stale token → 409 later)
    if (opts.draftKey) {
      const parked = defaultDraftStore.take(opts.draftKey)
      if (parked) session.restoreParked(parked)
    }
    active = { key: opts.formKey, session, handle }
    appliedRef.current = opts.data
    setBuilt(active)
  }

  // Park on unmount / key change — a CLEAN session clears the slot
  const draftKey = opts.draftKey
  useEffect(() => {
    if (!active || !draftKey) return
    const session = active.session
    return () => { defaultDraftStore.park(draftKey, session.parkableState()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draftKey])

  // Rehydrate the SAME key on fresh payloads — the three-way merge: clean
  // fields adopt the server, dirty fields survive, true conflicts withhold
  // the version token so the next save 409s into the conflict UX. This
  // replaced the old all-or-nothing isDirty() gate (which ignored refetches
  // entirely while ANY field was dirty).
  useEffect(() => {
    if (!active || opts.data == null || active.key !== opts.formKey) return
    if (appliedRef.current === opts.data) return
    appliedRef.current = opts.data
    active.session.rehydrate(asEnvelope(opts.data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, opts.data, opts.formKey])

  return { form: active?.handle ?? null }
}
