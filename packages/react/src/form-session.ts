/**
 * FormSession — the interaction layer over a Client draft.
 *
 * The draft (a generated Client instance, or any mutable object) IS the data
 * layer: values, codecs, dirty tracking, client-side validate(). FormSession
 * adds only what the data layer must not know about:
 *
 *   - touched / submitAttempted (error display timing — C1)
 *   - per-field subscriptions (a keystroke re-renders one field)
 *   - the abilities mask + can map + version from the server envelope
 *   - submit lifecycle (diff + version + optional _event; 422/409 handling)
 *
 * It is deliberately framework-agnostic — React binds to it through
 * `useSyncExternalStore` in the form handle. State lives HERE, not in field
 * components, so `presentIf` hiding a field never loses its value (C6), and
 * programmatic draft writes are visible to every subscriber (C9).
 */

export type Ability = 'edit' | 'view'
export type SessionStatus = 'ready' | 'saving' | 'saved' | 'error' | 'unauthenticated'

export interface ServerEnvelope {
  record?: Record<string, any>
  abilities?: Record<string, Ability>
  can?: Record<string, boolean>
  version?: string | null
  issues?: Array<{ field: string; code: string }>
}

export type SubmitResult =
  | { ok: true; envelope?: ServerEnvelope }
  | { ok: false; status: number; errors?: Record<string, string[]> }

export interface SubmitPayload {
  data: Record<string, any>
  version?: string | null
  _event?: string
}

export interface FormSessionOptions<T extends Record<string, any>> {
  draft: T
  mode: 'edit' | 'new'
  /** Server abilities mask. Omit/null (e.g. new forms) → every field editable. */
  abilities?: Record<string, Ability> | null
  /** Server-computed Attr.state verdicts. */
  can?: Record<string, boolean> | null
  /** Optimistic-lock token, echoed on submit. */
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
  private version: string | null

  private touched = new Set<string>()
  private submitAttempted = false
  private status: SessionStatus = 'ready'
  private serverErrors: Record<string, string[]> = {}
  private serverIssues: Array<{ field: string; code: string }> = []
  /** Per-field autosave lifecycle for save-indicators (spinner/checkmark). */
  private fieldStates = new Map<string, 'saving' | 'saved' | 'error'>()
  /** Fields mid-IME-composition — commit-on-change is suppressed (C11). */
  private composing = new Set<string>()

  /** Baseline for the submit diff — reset on load and on successful submit. */
  private baseline: Record<string, any>

  private listeners = new Map<string, Set<() => void>>()
  private versions = new Map<string, number>()
  private globalVersion = 0

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
    return Object.keys({ ...this.baseline, ...now }).some(
      k => !valueEquals(this.baseline[k], now[k]),
    )
  }

  /** The submit diff — only fields that changed since the baseline. */
  changedData(): Record<string, any> {
    const now = this.snapshotDraft()
    const out: Record<string, any> = {}
    for (const k of Object.keys(now)) {
      if (!valueEquals(this.baseline[k], now[k])) out[k] = now[k]
    }
    return out
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

  getStatus(): SessionStatus { return this.status }
  getVersion(): string | null { return this.version }
  getIssues(): Array<{ field: string; code: string }> { return this.serverIssues }

  /** Per-field autosave state — 'ready' when nothing is in flight. */
  fieldState(field: string): 'ready' | 'saving' | 'saved' | 'error' {
    return this.fieldStates.get(field) ?? 'ready'
  }

  beginComposition(field: string): void { this.composing.add(field) }
  endComposition(field: string): void { this.composing.delete(field) }
  isComposing(field: string): boolean { return this.composing.has(field) }

  // ── Errors ────────────────────────────────────────────────────────────────

  /** ALL current errors: client validate() ∪ server errors, deduped. */
  allErrors(): Record<string, string[]> {
    const client = this.validateFn(this.draft) ?? {}
    const merged: Record<string, string[]> = {}
    for (const src of [client, this.serverErrors]) {
      for (const [field, msgs] of Object.entries(src)) {
        const list = (merged[field] ??= [])
        for (const m of msgs) if (!list.includes(m)) list.push(m)
      }
    }
    return merged
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
    this.submitAttempted = true

    const clientErrors = this.validateFn(this.draft) ?? {}
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

    const payload: SubmitPayload = { data: this.changedData(), version: this.version }
    if (opts.event) payload._event = opts.event

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
      this.baseline = this.snapshotDraft()
      this.status = 'saved'
      this.notifyAll()
      return true
    }

    if (result.status === 401 || result.status === 403) {
      this.status = 'unauthenticated'   // draft untouched — re-auth then retry
    } else if (result.status === 409) {
      // Optimistic-lock conflict carries no field errors — surface it on base
      // so the form can tell the user to refresh instead of silently failing
      this.serverErrors = {
        base: ['This record was changed by someone else — refresh to see the latest version.'],
        ...(result.errors ?? {}),
      }
      this.status = 'error'
    } else {
      this.serverErrors = this.refieldErrors(result.errors ?? {})
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
      result = await this.submitFn({ data: { [field]: now[field] }, version: this.version })
    } catch {
      result = { ok: false, status: 0 }
    }

    if (result.ok) {
      if (result.envelope) this.applyEnvelope(result.envelope)
      else this.baseline[field] = now[field]
      this.fieldStates.set(field, 'saved')
      this.notify(field)
      return true
    }

    // Rollback the optimistic write — the field shows what the server has
    ;(this.draft as any)[field] = previous
    if (result.status === 401 || result.status === 403) {
      this.status = 'unauthenticated'
    } else if (result.status === 409) {
      this.serverErrors = {
        ...this.serverErrors,
        base: ['This record was changed by someone else — refresh to see the latest version.'],
      }
    } else {
      this.serverErrors = { ...this.serverErrors, ...this.refieldErrors(result.errors ?? {}) }
    }
    this.fieldStates.set(field, 'error')
    this.notifyAll()
    return false
  }

  /** Fold a server envelope in: new record values, mask, can, version. */
  applyEnvelope(envelope: ServerEnvelope): void {
    if (envelope.record) {
      for (const [k, v] of Object.entries(envelope.record)) {
        ;(this.draft as any)[k] = v
      }
    }
    if (envelope.abilities !== undefined) this.abilities = envelope.abilities ?? null
    if (envelope.can !== undefined) this.canMap = envelope.can ?? {}
    if (envelope.version !== undefined) this.version = envelope.version ?? null
    this.serverIssues = envelope.issues ?? []
    this.baseline = this.snapshotDraft()
    this.notifyAll()
  }

  /** Server errors on fields this session can't see re-field to base. */
  private refieldErrors(errors: Record<string, string[]>): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [field, msgs] of Object.entries(errors)) {
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
