/**
 * FormSession — the interaction layer over a Client draft.
 *
 * The draft (a generated Client instance, or any mutable object) IS the data
 * layer: values, codecs, dirty tracking, client-side validate(). FormSession
 * adds only what the data layer must not know about:
 *
 *   - touched / submitAttempted (error display timing — C1)
 *   - per-field subscriptions (a keystroke re-renders one field)
 *   - the abilities mask + can map from the server envelope
 *   - submit lifecycle (diff + optional _event; 422 handling)
 *
 * It is deliberately framework-agnostic — React binds to it through
 * `useSyncExternalStore` in the form handle. State lives HERE, not in field
 * components, so `presentIf` hiding a field never loses its value (C6), and
 * programmatic draft writes are visible to every subscriber (C9).
 */

export type Ability = 'edit' | 'view'
export type SessionStatus = 'ready' | 'saving' | 'saved' | 'error' | 'unauthenticated' | 'conflict'

export interface ServerEnvelope {
  record?: Record<string, any>
  abilities?: Record<string, Ability>
  can?: Record<string, boolean>
  issues?: Array<{ field: string; code: string }>
  /** Optimistic-lock token — echoed back as `_version` on every submit. */
  version?: string
}

export type SubmitResult =
  | { ok: true; envelope?: ServerEnvelope }
  | {
      ok: false
      status: number
      errors?: Record<string, string[]>
      /** 409 only: the server's CURRENT envelope (fresh record + version). */
      envelope?: ServerEnvelope
    }

export interface SubmitPayload {
  data: Record<string, any>
  _event?: string
  /** Optimistic-lock echo — the version token from the last envelope. */
  _version?: string
}

export interface FormSessionOptions<T extends Record<string, any>> {
  draft: T
  mode: 'edit' | 'new'
  /** Server abilities mask. Omit/null (e.g. new forms) → every field editable. */
  abilities?: Record<string, Ability> | null
  /** Server-computed Attr.state verdicts. */
  can?: Record<string, boolean> | null
  /** Optimistic-lock token from the initial envelope (edit forms). */
  version?: string | null
  /**
   * Client validation over the draft. Defaults to calling `draft.validate()`
   * when the generated Client provides one.
   */
  validate?: (draft: T) => Record<string, string[]>
  /** Transport — wired by generated hooks; injectable for tests. */
  submit?: (payload: SubmitPayload) => Promise<SubmitResult>
}

export class FormSession<T extends Record<string, any> = Record<string, any>> {
  readonly draft: T
  readonly mode: 'edit' | 'new'

  private abilities: Record<string, Ability> | null
  private canMap: Record<string, boolean>

  private touched = new Set<string>()
  private submitAttempted = false
  private status: SessionStatus = 'ready'
  private serverErrors: Record<string, string[]> = {}
  private serverIssues: Array<{ field: string; code: string }> = []
  /** Per-field autosave lifecycle for save-indicators (spinner/checkmark). */
  private fieldStates = new Map<string, 'saving' | 'saved' | 'error' | 'pending'>()
  /** Fields mid-IME-composition — commit-on-change is suppressed (C11). */
  private composing = new Set<string>()
  /** Offline autosave queue — field → newest value, retried by flushPending(). */
  private pendingWrites = new Map<string, any>()

  /** Optimistic-lock token — rides every submit as `_version`. */
  private version: string | null = null
  /** The server's CURRENT envelope from a 409 — fuel for resolveConflict(). */
  private conflictEnvelope: ServerEnvelope | null = null

  /** Baseline for the submit diff — reset on load and on successful submit. */
  private baseline: Record<string, any>

  private listeners = new Map<string, Set<() => void>>()
  private versions = new Map<string, number>()
  private globalVersion = 0

  /** Nested attribute managers (accepts_nested_attributes_for client half).
   *  hasMany managers speak arrays; hasOne managers speak a single object —
   *  the session treats payloads and server echoes opaquely either way. */
  private nested = new Map<string, {
    attributesPayload(): Array<Record<string, any>> | Record<string, any> | null
    errors(): Record<string, string[]>
    routeServerError(path: string, msgs: string[]): boolean
    commitBaselines(saved?: any): void
    markSubmitAttempted(): void
    syncFromServer(rows: any): void
    setLocked(locked: boolean): void
  }>()

  private readonly validateFn: (draft: T) => Record<string, string[]>
  private readonly submitFn?: (payload: SubmitPayload) => Promise<SubmitResult>

  constructor(opts: FormSessionOptions<T>) {
    this.draft = opts.draft
    this.mode = opts.mode
    this.abilities = opts.abilities ?? null
    this.canMap = opts.can ?? {}
    this.version = opts.version ?? null
    this.validateFn = opts.validate
      ?? ((d: T) => (typeof (d as any).validate === 'function' ? (d as any).validate() : {}))
    if (opts.submit) this.submitFn = opts.submit
    this.baseline = this.snapshotDraft()
  }

  // ── Values ────────────────────────────────────────────────────────────────

  getValue(field: string): any {
    return (this.draft as any)[field]
  }

  /** Write to the draft and notify that field's subscribers. */
  setValue(field: string, value: any): void {
    ;(this.draft as any)[field] = value
    // Editing again after a settled submit returns the session to ready —
    // otherwise 'saved'/'error' stick forever and save-indicators lie
    if (this.status === 'saved' || this.status === 'error') this.status = 'ready'
    const fs = this.fieldStates.get(field)
    if (fs === 'saved' || fs === 'error') this.fieldStates.delete(field)
    this.notify(field)
  }

  /** Mark interacted (blur) — errors for this field become visible (C1). */
  touch(field: string): void {
    if (this.touched.has(field)) return
    this.touched.add(field)
    this.notify(field)
  }

  isDirty(): boolean {
    const now = this.snapshotDraft()
    const flatDirty = Object.keys({ ...this.baseline, ...now }).some(
      k => !this.nested.has(k) && !valueEquals(this.baseline[k], now[k]),
    )
    if (flatDirty) return true
    for (const manager of this.nested.values()) {
      if (manager.attributesPayload() !== null) return true
    }
    return false
  }

  /** The submit diff — only fields that changed since the baseline. */
  changedData(): Record<string, any> {
    const now = this.snapshotDraft()
    const out: Record<string, any> = {}
    for (const k of Object.keys(now)) {
      if (this.nested.has(k)) continue   // raw child arrays never ride the diff
      if (!valueEquals(this.baseline[k], now[k])) out[k] = now[k]
    }
    // Nested arrays fold in as <name>Attributes (the server contract)
    for (const [name, manager] of this.nested) {
      const payload = manager.attributesPayload()
      if (payload) out[`${name}Attributes`] = payload
    }
    return out
  }

  /** Wire a nested attribute manager in (called by the handle on first use). */
  registerNested(name: string, manager: {
    attributesPayload(): Array<Record<string, any>> | Record<string, any> | null
    errors(): Record<string, string[]>
    routeServerError(path: string, msgs: string[]): boolean
    commitBaselines(saved?: any): void
    markSubmitAttempted(): void
    syncFromServer(rows: any): void
    setLocked(locked: boolean): void
  }): void {
    this.nested.set(name, manager)
    manager.setLocked(!this.canEditNested(name))
  }

  getNested(name: string): unknown { return this.nested.get(name) }

  /** External components (nested managers) bump a field's channel. */
  notifyExternal(field: string): void { this.notify(field) }

  /**
   * Server errors injected from outside (nested error routing). Runs through
   * refieldErrors so a path addressed DEEPER (`liens[new:1].holder` arriving
   * at the middle session of a nested-nested form) routes onward to the
   * grandchild instead of dying as an unrenderable flat key.
   */
  applyExternalErrors(errors: Record<string, string[]>): void {
    this.serverErrors = { ...this.serverErrors, ...this.refieldErrors(errors) }
    // These arrived from a submit attempt — make them visible immediately
    this.submitAttempted = true
    this.notifyAll()
  }

  /**
   * A submit was attempted — errors become visible on EVERY field, including
   * untouched fields in nested child rows (and their children, recursively).
   * Without the recursion, an invalid untouched child blocks the submit while
   * showing nothing: the form just silently refuses to save.
   */
  markSubmitAttempted(): void {
    this.submitAttempted = true
    for (const manager of this.nested.values()) manager.markSubmitAttempted()
    this.notifyAll()
  }

  /**
   * Post-save settle for this session's nested managers, given the saved
   * record. Each manager drops destroyed rows, re-keys new rows against the
   * server's echo, and recurses into ITS children the same way — without
   * this, a saved new grandchild stays `isNew` and is re-created (duplicated)
   * by every subsequent save.
   */
  settleNested(record?: Record<string, any>): void {
    for (const [name, manager] of this.nested) {
      // Shape is the manager's business: array managers expect rows, singular
      // managers a single object (or null = destroyed) — pass the echo raw
      manager.commitBaselines(record?.[name])
    }
  }

  /** Re-snapshot the baseline (post-save settle). Stale 422s don't linger. */
  resetBaseline(): void {
    this.baseline = this.snapshotDraft()
    this.serverErrors = {}
    this.notifyAll()
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  canView(field: string): boolean {
    if (this.abilities === null) return true
    return field in this.abilities
  }

  canEdit(field: string): boolean {
    if (this.abilities === null) return true
    return this.abilities[field] === 'edit'
  }

  /** Server verdict for an Attr.state event; client may only narrow, never widen. */
  can(event: string): boolean {
    return this.canMap[event] === true
  }

  /**
   * Edit verdict for a nested attribute array — the envelope governs it as
   * `<name>Attributes` in the abilities mask. An ABSENT key means the mask
   * doesn't govern this array (older server / plain include) → editable;
   * the server-side permit still strips and reports either way.
   */
  canEditNested(name: string): boolean {
    if (this.abilities === null) return true
    return this.abilities[`${name}Attributes`] !== 'view'
  }

  /** Replace the abilities mask (nested lock propagation from a parent). */
  setAbilities(abilities: Record<string, Ability> | null): void {
    this.abilities = abilities
    this.notifyAll()
  }

  getStatus(): SessionStatus { return this.status }
  getIssues(): Array<{ field: string; code: string }> { return this.serverIssues }

  /** Per-field autosave state — 'ready' when nothing is in flight. */
  fieldState(field: string): 'ready' | 'saving' | 'saved' | 'error' | 'pending' {
    return this.fieldStates.get(field) ?? 'ready'
  }

  beginComposition(field: string): void { this.composing.add(field) }
  endComposition(field: string): void { this.composing.delete(field) }
  isComposing(field: string): boolean { return this.composing.has(field) }

  // ── Errors ────────────────────────────────────────────────────────────────

  private errorsCache: { version: number; errors: Record<string, string[]> } | null = null

  /**
   * Client validation, defensively: a validator that throws (e.g. a gate
   * reading something this projection doesn't carry) must never break
   * rendering OR block submit — it degrades to {} and the server stays
   * authoritative for that rule.
   */
  private clientValidate(): Record<string, string[]> {
    try {
      return this.validateFn(this.draft) ?? {}
    } catch {
      return {}
    }
  }

  /**
   * ALL current errors: client validate() ∪ server errors, deduped.
   * Memoized per session version — every rendered field calls this, and
   * re-running the full validate() N times per keystroke adds up.
   */
  allErrors(): Record<string, string[]> {
    const version = this.globalVersion
    if (this.errorsCache?.version === version) return this.errorsCache.errors
    const client = this.clientValidate()
    const merged: Record<string, string[]> = {}
    for (const src of [client, this.serverErrors]) {
      for (const [field, msgs] of Object.entries(src)) {
        const list = (merged[field] ??= [])
        for (const m of msgs) if (!list.includes(m)) list.push(m)
      }
    }
    this.errorsCache = { version, errors: merged }
    return merged
  }

  /**
   * Client errors that GATE a submit: this session's validate() plus every
   * nested child's, recursively (grandchildren included). Server errors are
   * display-only here — a stale 422 must never block resubmitting the
   * corrected value.
   */
  gateErrors(): Record<string, string[]> {
    const out: Record<string, string[]> = { ...this.clientValidate() }
    for (const manager of this.nested.values()) Object.assign(out, manager.errors())
    return out
  }

  /**
   * Errors VISIBLE for a field right now — validate-on-change, display gated
   * by touched ∪ submitAttempted; once visible, they clear live while typing.
   */
  visibleErrors(field: string): string[] {
    if (!this.touched.has(field) && !this.submitAttempted) return []
    return this.allErrors()[field] ?? []
  }

  baseErrors(): string[] {
    if (!this.submitAttempted && Object.keys(this.serverErrors).length === 0) return []
    return this.allErrors()['base'] ?? []
  }

  // ── Submit lifecycle ──────────────────────────────────────────────────────

  /**
   * Validate, then submit the diff (+version, +optional _event). On success,
   * the envelope re-masks the session and resets the baseline — the same JSX
   * re-renders under the new abilities (C14). On 422, server errors bind to
   * fields; unknown fields land on base. On 401, the draft SURVIVES (C15).
   */
  async submit(opts: { event?: string } = {}): Promise<boolean> {
    this.markSubmitAttempted()

    // Children (and grandchildren) gate the parent: any invalid row blocks
    const clientErrors = this.gateErrors()
    if (Object.keys(clientErrors).length > 0) {
      this.status = 'error'
      this.notifyAll()
      return false
    }

    if (!this.submitFn) {
      this.notifyAll()
      return true // staged-only session (no transport wired)
    }

    this.status = 'saving'
    this.notifyAll()

    const payload: SubmitPayload = { data: this.changedData() }
    if (opts.event) payload._event = opts.event
    if (this.version != null) payload._version = this.version

    let result: SubmitResult
    try {
      result = await this.submitFn(payload)
    } catch {
      this.status = 'error'
      this.notifyAll()
      return false
    }

    if (result.ok) {
      this.serverErrors = {}
      if (result.envelope) this.applyEnvelope(result.envelope)
      // Children settle: destroyed rows drop, new rows adopt server ids —
      // recursively, so grandchildren re-key too (settleNested)
      this.settleNested(result.envelope?.record)
      this.baseline = this.snapshotDraft()
      this.lastSavedAt = Date.now()
      this.status = 'saved'
      this.notifyAll()
      return true
    }

    if (result.status === 401 || result.status === 403) {
      this.status = 'unauthenticated'   // draft untouched — re-auth then retry
    } else if (result.status === 409) {
      this.enterConflict(result.envelope)   // draft untouched — user decides
    } else {
      this.serverErrors = this.refieldErrors(result.errors ?? {})
      // A failure must never be invisible: 500s (or empty bodies) get a base
      // fallback. Errors that ROUTED to nested children are already visible
      // there, so only the truly-empty case falls back.
      if (Object.keys(result.errors ?? {}).length === 0) {
        this.serverErrors = { base: ['Something went wrong — please try again.'] }
      }
      this.status = 'error'
    }
    this.notifyAll()
    return false
  }

  /**
   * Commit ONE field under the given policy. 'stage' just marks touched
   * (batch submit sends it later). 'autosave' sends a single-field PATCH:
   * optimistic (the draft already holds the value), rolled back on failure,
   * gated by that field's own validators, no-op when the field is clean or
   * mid-composition (C11). Errors land on the field like any other.
   */
  async commitField(field: string, mode: 'stage' | 'autosave'): Promise<boolean> {
    this.touch(field)
    if (mode !== 'autosave' || !this.submitFn) return true
    if (this.composing.has(field)) return true
    if (this.status === 'conflict') return false   // paused until resolved

    const now = this.snapshotDraft()
    if (valueEquals(this.baseline[field], now[field])) return true   // clean → no PATCH

    // Field-local validation gate: never autosave a value the client knows is bad
    const fieldErrors = this.allErrors()[field] ?? []
    if (fieldErrors.length > 0) {
      this.notify(field)
      return false
    }

    const previous = this.baseline[field]
    this.fieldStates.set(field, 'saving')
    this.notify(field)

    let result: SubmitResult
    try {
      result = await this.submitFn({
        data: { [field]: now[field] },
        ...(this.version != null ? { _version: this.version } : {}),
      })
    } catch {
      result = { ok: false, status: 0 }
    }

    if (result.ok) {
      if (result.envelope) this.applyEnvelope(result.envelope)
      else this.baseline[field] = now[field]
      this.pendingWrites.delete(field)
      this.fieldStates.set(field, 'saved')
      this.notify(field)
      return true
    }

    // OFFLINE (network failure, status 0): keep the optimistic value and
    // QUEUE the delta — the edit is never lost. flushPending() retries it
    // (the Form wires this to the browser 'online' event). This is the whole
    // "orchestrator", deliberately tiny: last-write-per-field, retried later.
    if (result.status === 0) {
      this.pendingWrites.set(field, now[field])
      this.fieldStates.set(field, 'pending')
      this.notify(field)
      return false
    }

    // Conflict: the record changed elsewhere. The optimistic value STAYS on
    // the draft (never silently drop a user's edit) — resolveConflict decides.
    if (result.status === 409) {
      this.pendingWrites.delete(field)
      this.fieldStates.set(field, 'error')
      this.enterConflict(result.envelope)
      this.notifyAll()
      return false
    }

    // Server rejected it (validation/auth) — roll back to what the server has
    ;(this.draft as any)[field] = previous
    this.pendingWrites.delete(field)
    if (result.status === 401 || result.status === 403) {
      this.status = 'unauthenticated'
    } else {
      this.serverErrors = { ...this.serverErrors, ...this.refieldErrors(result.errors ?? {}) }
    }
    this.fieldStates.set(field, 'error')
    this.notifyAll()
    return false
  }

  /**
   * Retry every queued offline write. Called when connectivity returns.
   * Clean, fail-closed: work that fails again just stays queued.
   */
  async flushPending(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      const fields = [...this.pendingWrites.keys()]
      for (const field of fields) await this.commitField(field, 'autosave')
    }
    if (this.pendingFlush) await this.autoFlush()
  }

  hasPending(): boolean { return this.pendingWrites.size > 0 || this.pendingFlush }

  // ── Whole-diff autosave (the <Form autosave> engine) ─────────────────────
  //
  // Why object-level and not field-level: the client holds the ENTIRE
  // projected draft plus every validator that fits the projection, so it can
  // know the whole object is coherent BEFORE sending. Commits stage locally;
  // the accumulated diff flushes when the draft is valid and the debounce
  // window closes. Invalid intermediate states (isFeatured toggled, amount
  // not typed yet) simply stay local — no jarring mid-edit 422s, and
  // multi-field invariants save atomically in one PATCH.

  private autoFlushTimer: ReturnType<typeof setTimeout> | null = null
  private autoFlushInFlight = false
  private autoFlushQueued = false
  private pendingFlush = false
  private lastSavedAt: number | null = null

  /** Timestamp of the last successful save (submit or flush) — SaveStatus fuel. */
  getLastSavedAt(): number | null { return this.lastSavedAt }

  /** Field-level unsaved signal: the draft differs from the server baseline. */
  fieldDirty(field: string): boolean {
    return !valueEquals(this.baseline[field], this.snapshotDraft()[field])
  }

  /** Debounced flush — <Form autosave> field commits land here. */
  requestAutoFlush(delayMs = 400): void {
    if (this.autoFlushTimer) clearTimeout(this.autoFlushTimer)
    this.autoFlushTimer = setTimeout(() => {
      this.autoFlushTimer = null
      void this.autoFlush()
    }, delayMs)
  }

  /** Unmount hygiene — a dropped form must not fire a stale flush. */
  cancelAutoFlush(): void {
    if (this.autoFlushTimer) { clearTimeout(this.autoFlushTimer); this.autoFlushTimer = null }
  }

  /**
   * Flush the accumulated diff IF the whole draft is currently valid.
   * Single-flight; edits made mid-flight stay dirty (never clobbered by the
   * response) and roll into an immediate follow-up flush. Offline queues the
   * whole diff for flushPending(). A 422 binds field errors but does NOT
   * splash untouched fields (C1 stands: no markSubmitAttempted here).
   */
  async autoFlush(): Promise<boolean> {
    if (this.autoFlushInFlight) { this.autoFlushQueued = true; return false }
    if (!this.submitFn) return false
    // A standing conflict PAUSES autosave — retrying with the stale token
    // would 409 forever; resolveConflict() re-arms the flush
    if (this.status === 'conflict') return false
    if (!this.isDirty()) return true
    if (Object.keys(this.gateErrors()).length > 0) return false   // stays local

    this.autoFlushInFlight = true
    const flushed = this.snapshotDraft()
    this.status = 'saving'
    this.notifyAll()

    let result: SubmitResult
    try {
      result = await this.submitFn({
        data: this.changedData(),
        ...(this.version != null ? { _version: this.version } : {}),
      })
    } catch {
      result = { ok: false, status: 0 }
    }
    this.autoFlushInFlight = false

    if (result.ok) {
      this.pendingFlush = false
      this.serverErrors = {}
      this.applyFlushSuccess(result.envelope, flushed)
      this.lastSavedAt = Date.now()
      this.status = 'saved'
      this.notifyAll()
    } else if (result.status === 0) {
      // Offline: the draft keeps every edit; the diff is queued as a unit
      this.pendingFlush = true
      this.status = 'ready'
      this.notifyAll()
    } else if (result.status === 401 || result.status === 403) {
      this.status = 'unauthenticated'   // draft untouched (C15)
      this.notifyAll()
    } else if (result.status === 409) {
      // The whole point of the lock under autosave: two tabs both flushing
      // must not silently clobber each other — surface it, don't retry
      this.enterConflict(result.envelope)
      this.notifyAll()
    } else {
      this.serverErrors = this.refieldErrors(result.errors ?? {})
      if (Object.keys(result.errors ?? {}).length === 0) {
        this.serverErrors = { base: ['Something went wrong — your changes are not saved yet.'] }
      }
      this.status = 'error'
      this.notifyAll()
    }

    // Mid-flight edits (or coalesced requests) ride the next flush
    if (this.autoFlushQueued) {
      this.autoFlushQueued = false
      if (this.isDirty()) this.requestAutoFlush(0)
    } else if (result.ok && this.isDirty()) {
      this.requestAutoFlush(0)
    }
    return result.ok
  }

  /**
   * Success application that never clobbers keystrokes made DURING the
   * flight: server values fold into the draft only for fields unchanged
   * since the flush snapshot; the baseline takes the server truth either
   * way, so mid-flight edits stay dirty and ride the next flush.
   */
  private applyFlushSuccess(envelope: ServerEnvelope | undefined, flushed: Record<string, any>): void {
    if (envelope?.version !== undefined) this.version = envelope.version ?? null
    const rec = envelope?.record
    if (rec) {
      const now = this.snapshotDraft()
      for (const [k, v] of Object.entries(rec)) {
        if (this.nested.has(k)) continue
        if (valueEquals(now[k], flushed[k])) {
          try {
            ;(this.draft as any)[k] = v
          } catch {
            Object.defineProperty(this.draft, k, { value: v, writable: true, enumerable: true, configurable: true })
          }
        }
        this.baseline[k] = v
      }
      if (envelope!.abilities !== undefined) {
        this.abilities = envelope!.abilities ?? null
        for (const [name, manager] of this.nested) manager.setLocked(!this.canEditNested(name))
      }
      if (envelope!.can !== undefined) this.canMap = envelope!.can ?? {}
      this.serverIssues = envelope!.issues ?? []
      const stripped = this.serverIssues.filter(i => i.code === 'forbidden').map(i => i.field)
      if (stripped.length > 0) {
        console.warn(
          `[active-drizzle] the server stripped non-permitted fields from this autosave: `
          + `${stripped.join(', ')} — permit them in the controller or stop rendering them editable.`,
        )
        this.serverErrors = {
          ...this.serverErrors,
          base: [...(this.serverErrors['base'] ?? []), `Some changes were not permitted and were not saved: ${stripped.join(', ')}`],
        }
      }
      this.settleNested(rec)
    } else {
      for (const k of Object.keys(flushed)) {
        if (!this.nested.has(k)) this.baseline[k] = flushed[k]
      }
      this.settleNested(undefined)
    }
  }

  // ── Draft parking (navigation survival — DESIGN-cache-coherence §G2) ─────

  /**
   * The parkable diff, or null when the session is clean (a clean park
   * CLEARS the slot — self-cleaning after successful submits).
   */
  parkableState(): { data: Record<string, any>; baseline: Record<string, any>; version: string | null } | null {
    const data = this.changedData()
    if (Object.keys(data).length === 0) return null
    const baseline: Record<string, any> = {}
    for (const k of Object.keys(data)) {
      if (k.endsWith('Attributes')) continue   // nested payloads carry ids/_keys, not baselines
      baseline[k] = this.baseline[k]
    }
    return { data, baseline, version: this.version }
  }

  /**
   * Replay a parked diff onto a FRESHLY BUILT session (baseline = the new
   * envelope). Per flat field, three-way against the STORED baseline:
   * server unmoved → replay; both converged → skip; server moved → replay
   * MINE and keep the STALE version token, so the next submit 409s into
   * the conflict UX — the same withhold rule rehydrate() uses.
   */
  restoreParked(parked: { data: Record<string, any>; baseline: Record<string, any>; version: string | null }): void {
    let conflict = false
    for (const [k, mine] of Object.entries(parked.data)) {
      if (k.endsWith('Attributes')) {
        const name = k.slice(0, -'Attributes'.length)
        const manager: any = this.nested.get(name)
        if (manager && typeof manager.restorePayload === 'function') manager.restorePayload(mine)
        continue
      }
      const storedBase = parked.baseline[k]
      const freshBase = this.baseline[k]
      if (valueEquals(freshBase, mine)) continue          // converged while away
      if (!valueEquals(freshBase, storedBase)) conflict = true   // moved under me
      this.setValue(k, mine)                              // never lose the edit
    }
    if (conflict && parked.version != null) this.version = parked.version   // stale on purpose
    this.notifyAll()
  }

  // ── Optimistic concurrency (409 conflicts) ───────────────────────────────

  /** The current lock token (null when the server doesn't version this form). */
  getVersion(): string | null { return this.version }

  /** The server's CURRENT envelope from the 409 — null when not in conflict. */
  getConflict(): ServerEnvelope | null { return this.conflictEnvelope }

  /**
   * A 409 landed: the record changed since this client read it. The draft is
   * left UNTOUCHED (no user keystroke is ever dropped by a race) and the
   * session enters 'conflict' — autosave pauses, a base error explains, and
   * resolveConflict() offers the two honest exits.
   */
  private enterConflict(envelope?: ServerEnvelope): void {
    this.conflictEnvelope = envelope ?? null
    this.serverErrors = {
      ...this.serverErrors,
      base: ['This record was changed elsewhere — reload it or overwrite.'],
    }
    this.status = 'conflict'
  }

  /**
   * The two exits from a conflict:
   *   'reload'    → take the SERVER's truth: fold the 409's envelope into
   *                 the draft (nested children force-sync too) and drop
   *                 local edits. Returns true.
   *   'overwrite' → keep MINE: adopt the fresh version token and resubmit
   *                 the still-dirty diff. Returns the resubmit's outcome.
   */
  async resolveConflict(mode: 'reload' | 'overwrite'): Promise<boolean> {
    const env = this.conflictEnvelope
    this.conflictEnvelope = null
    delete this.serverErrors['base']
    if (mode === 'reload') {
      if (env) {
        this.applyEnvelope(env)
        // Reload means the server wins EVERYWHERE — dirty nested managers
        // (which applyEnvelope deliberately never clobbers) force-sync here
        if (env.record) {
          for (const [name, manager] of this.nested) {
            if (name in env.record) manager.syncFromServer((env.record as any)[name])
          }
        }
        this.baseline = this.snapshotDraft()
      }
      this.status = 'ready'
      this.notifyAll()
      return true
    }
    if (env?.version != null) this.version = env.version
    this.status = 'ready'
    this.notifyAll()
    return this.submit()
  }

  /**
   * REHYDRATE — fold a FRESH same-door envelope into a LIVE, possibly-dirty
   * session: the three-way merge (DESIGN-cache-coherence §B).
   *
   * Per flat field: mine==base → adopt theirs (clean fields track the
   * server); theirs==base → keep mine (server didn't move); all three
   * differ → TRUE CONFLICT: keep mine (never eat a keystroke) and WITHHOLD
   * the fresh version token, so the next submit 409s into the existing
   * conflict UX — one conflict system. mine==theirs (both arrived at the
   * same value) settles the baseline silently.
   *
   * Nested managers merge by id (their own rehydrate). Ordering guard:
   * a payload OLDER than the session's known version is ignored entirely
   * (a slow refetch must never roll back a newer echo).
   *
   * Returns true when a conflict was detected (token withheld).
   */
  rehydrate(envelope: ServerEnvelope): boolean {
    // C — monotonicity: version tokens are numeric-comparable by
    // convention (epoch millis / lock integers)
    if (envelope.version != null && this.version != null) {
      const incoming = Number(envelope.version)
      const known = Number(this.version)
      if (Number.isFinite(incoming) && Number.isFinite(known) && incoming < known) return false
    }

    let conflict = false
    const rec = envelope.record
    if (rec) {
      const now = this.snapshotDraft()
      for (const [k, their] of Object.entries(rec)) {
        if (this.nested.has(k)) continue
        const base = this.baseline[k]
        const mine = now[k]
        if (valueEquals(mine, base)) {
          // clean → adopt (accessor-proof, same as applyEnvelope)
          try {
            ;(this.draft as any)[k] = their
          } catch {
            Object.defineProperty(this.draft, k, { value: their, writable: true, enumerable: true, configurable: true })
          }
          this.baseline[k] = their
        } else if (valueEquals(their, base)) {
          // server didn't move → my edit stands, baseline stands
        } else if (valueEquals(their, mine)) {
          // both converged on the same value → settle silently
          this.baseline[k] = their
        } else {
          conflict = true
        }
      }
      for (const [name, manager] of this.nested) {
        if (!(name in rec)) continue
        const m = manager as any
        if (typeof m.rehydrate === 'function') {
          if (m.rehydrate((rec as any)[name])) conflict = true
        } else if (manager.attributesPayload() === null) {
          manager.syncFromServer((rec as any)[name])
        }
      }
    }

    if (envelope.abilities !== undefined) {
      this.abilities = envelope.abilities ?? null
      for (const [name, manager] of this.nested) manager.setLocked(!this.canEditNested(name))
    }
    if (envelope.can !== undefined) this.canMap = envelope.can ?? {}
    // Version adoption ONLY when conflict-free — withholding it is what
    // guarantees the conflict surfaces (T3): the stale token 409s
    if (envelope.version !== undefined && !conflict) this.version = envelope.version ?? null

    this.notifyAll()
    return conflict
  }

  /** Fold a server envelope in: new record values, mask, can, version. */
  applyEnvelope(envelope: ServerEnvelope): void {
    if (envelope.record) {
      for (const [k, v] of Object.entries(envelope.record)) {
        // Accessor-proof: a draft class with a getter-only property must not
        // blow up the success path — define over it instead
        try {
          ;(this.draft as any)[k] = v
        } catch {
          Object.defineProperty(this.draft, k, { value: v, writable: true, enumerable: true, configurable: true })
        }
      }
      // Nested children: a manager with NO pending local edits syncs to the
      // server's echo (a refetch picked up children added/changed elsewhere).
      // A manager holding unsaved child edits is left alone — the same
      // never-clobber rule the flat draft gets. The submit path is unaffected:
      // its managers are still dirty here, and settleNested() handles them.
      // The key must be PRESENT: an envelope without the association carries
      // no verdict (null on a singular association means "destroyed" — real).
      for (const [name, manager] of this.nested) {
        if (!(name in envelope.record)) continue
        if (manager.attributesPayload() === null) {
          manager.syncFromServer((envelope.record as any)[name])
        }
      }
    }
    if (envelope.abilities !== undefined) {
      this.abilities = envelope.abilities ?? null
      // Nested arrays lock/unlock with the fresh mask (self-locking, C14)
      for (const [name, manager] of this.nested) {
        manager.setLocked(!this.canEditNested(name))
      }
    }
    if (envelope.can !== undefined) this.canMap = envelope.can ?? {}
    if (envelope.version !== undefined) this.version = envelope.version ?? null
    this.serverIssues = envelope.issues ?? []
    // A save that silently dropped fields is a permit/UI mismatch — never
    // invisible. Loud in the console for the developer, on base for the user.
    const stripped = this.serverIssues.filter(i => i.code === 'forbidden').map(i => i.field)
    if (stripped.length > 0) {
      console.warn(
        `[active-drizzle] the server stripped non-permitted fields from this save: `
        + `${stripped.join(', ')} — permit them in the controller or stop rendering them editable.`,
      )
      this.serverErrors = {
        ...this.serverErrors,
        base: [...(this.serverErrors['base'] ?? []), `Some changes were not permitted and were not saved: ${stripped.join(', ')}`],
      }
    }
    this.baseline = this.snapshotDraft()
    this.notifyAll()
  }

  /**
   * Server errors on fields this session can't see re-field to base.
   * Nested paths (`assets[id:7].value`, `assets[new:3].name`) route to the
   * owning child session first.
   */
  private refieldErrors(errors: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [field, msgs] of Object.entries(errors)) {
      let routed = false
      for (const manager of this.nested.values()) {
        if (manager.routeServerError(field, msgs)) { routed = true; break }
      }
      if (routed) continue
      const key = field === 'base' || this.canView(field) ? field : 'base'
      ;(out[key] ??= []).push(...msgs)
    }
    return out
  }

  // ── Subscriptions (useSyncExternalStore contract) ────────────────────────

  subscribe(field: string, fn: () => void): () => void {
    const set = this.listeners.get(field) ?? new Set()
    set.add(fn)
    this.listeners.set(field, set)
    return () => { set.delete(fn) }
  }

  /** Monotonic per-field version — the getSnapshot value. */
  fieldVersion(field: string): number {
    return (this.versions.get(field) ?? 0) + this.globalVersion
  }

  private notify(field: string): void {
    this.versions.set(field, (this.versions.get(field) ?? 0) + 1)
    this.globalVersion++   // '*' subscribers (predicate-bearing fields) see every change
    for (const fn of this.listeners.get(field) ?? []) fn()
    for (const fn of this.listeners.get('*') ?? []) fn()
  }

  private notifyAll(): void {
    this.globalVersion++
    for (const set of this.listeners.values()) for (const fn of set) fn()
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private snapshotDraft(): Record<string, any> {
    const d: any = this.draft
    if (typeof d.toJSON === 'function') return { ...d.toJSON() }
    const out: Record<string, any> = {}
    for (const k of Object.keys(d)) {
      if (typeof d[k] !== 'function' && !k.startsWith('_')) out[k] = d[k]
    }
    return out
  }
}

function valueEquals(a: any, b: any): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}
