/**
 * NestedArrayManager — the client half of accepts_nested_attributes_for.
 *
 * The server half already ships: ApplicationRecord.save() processes
 * `<assoc>Attributes: [{ id?, _destroy?, ...fields }]` transactionally.
 * This manager maintains the child drafts as identity-keyed FormSessions
 * (persisted rows key on `id:<id>`, new rows on an ephemeral `new:<n>` _key —
 * NEVER array indexes, so removing a middle row can't shift sibling state,
 * C5) and folds their dirty state into the parent submit payload:
 *
 *   new + dirty        → { ...fields, _key }        (server strips _key)
 *   persisted + dirty  → { id, ...changedFields }
 *   persisted + removed → { id, _destroy: true }
 *   new + removed      → dropped entirely
 */
import { FormSession } from './form-session.js'

/**
 * The child resource's own write endpoints, used for INSTANT nested writes
 * (when the parent row is already persisted). Wired by the generated hook
 * from the child controller's client. `create` returns the saved row (with
 * its new id) so the optimistic row can adopt it.
 */
export interface NestedTransport {
  create(data: Record<string, any>): Promise<{ ok: boolean; row?: Record<string, any> }>
  update(id: any, data: Record<string, any>): Promise<{ ok: boolean; row?: Record<string, any> }>
  destroy(id: any): Promise<{ ok: boolean }>
}

/** A view-only abilities mask covering every data field on a child draft. */
function viewMaskOf(draft: any): Record<string, 'view'> {
  const mask: Record<string, 'view'> = {}
  for (const k of Object.keys(draft ?? {})) {
    if (typeof draft[k] !== 'function' && !k.startsWith('_')) mask[k] = 'view'
  }
  return mask
}

export interface NestedChild {
  /** Stable identity for React keys and error routing: 'id:7' or 'new:3'. */
  key: string
  session: FormSession
  isNew: boolean
  destroyed: boolean
}

export class NestedArrayManager {
  readonly name: string
  private parent: FormSession
  private children: NestedChild[] = []
  private seq = 0
  private validateChild?: (draft: any) => Record<string, string[]>
  /** Child fields that are THEMSELVES nested arrays (nested-nested). */
  private nestedKeys: Set<string>
  /** When set, move() rewrites this field on every child (0-based). */
  private positionField?: string
  /** Envelope said `<name>Attributes: 'view'` — rows render read-only, no mutations. */
  private locked = false
  /**
   * Rails' allow_destroy: destroying PERSISTED rows through nesting is a
   * model-level opt-in the generated meta carries down. New (unsaved) rows
   * are always removable — dropping a row that never existed destroys
   * nothing. Defaults true for hand-rolled meta; generated meta is explicit.
   */
  readonly allowDestroy: boolean
  /**
   * Instant mode: when the PARENT row is persisted, a row change hits the
   * child's own controller immediately (optimistic, rolled back on failure)
   * instead of staging into the parent save. When the parent is still new
   * (no id) it stages like any nested row and becomes instant after the
   * parent save settles the row an id.
   */
  private instant = false
  private transport?: NestedTransport
  private foreignKey?: string

  constructor(
    parent: FormSession<any>,
    name: string,
    initial: any[] | undefined,
    opts: {
      validate?: (draft: any) => Record<string, string[]>
      nestedKeys?: string[]
      positionField?: string
      allowDestroy?: boolean
      instant?: boolean
      transport?: NestedTransport
      foreignKey?: string
    } = {},
  ) {
    this.parent = parent
    this.name = name
    this.allowDestroy = opts.allowDestroy !== false
    this.instant = Boolean(opts.instant)
    if (opts.transport) this.transport = opts.transport
    if (opts.foreignKey) this.foreignKey = opts.foreignKey
    this.nestedKeys = new Set(opts.nestedKeys ?? [])
    if (opts.positionField) this.positionField = opts.positionField
    if (opts.validate) this.validateChild = opts.validate
    for (const row of initial ?? []) {
      const draft = { ...row }
      this.children.push({
        key: row?.id != null ? `id:${row.id}` : `new:${++this.seq}`,
        session: this.makeChildSession(draft, row?.id == null),
        isNew: row?.id == null,
        destroyed: false,
      })
    }
  }

  private makeChildSession(draft: any, isNew: boolean): FormSession {
    return new FormSession({
      draft,
      // null (all-editable) until the parent's envelope locks the array —
      // then a view-only mask over the row's own fields
      abilities: this.locked ? viewMaskOf(draft) : null,
      mode: isNew ? 'new' : 'edit',
      ...(this.validateChild ? { validate: this.validateChild } : {}),
      // no transport: children NEVER fetch or submit — the parent owns the wire
    })
  }

  /**
   * The parent envelope's verdict for `<name>Attributes`. Locked rows render
   * through their view presenters (a view-only mask over each child) and
   * add/remove/move become no-ops — the same self-locking the flat fields get.
   */
  setLocked(locked: boolean): void {
    if (locked === this.locked) return
    this.locked = locked
    for (const child of this.children) {
      child.session.setAbilities(locked ? viewMaskOf(child.session.draft) : null)
    }
    this.parent.notifyExternal(this.name)
  }

  isLocked(): boolean { return this.locked }

  /** Children currently in the form — removed rows are gone from the UI. */
  visible(): NestedChild[] {
    return this.children.filter(c => !c.destroyed)
  }

  /** Every child including destroy-marked ones (for payload folding). */
  all(): NestedChild[] {
    return this.children
  }

  /** The parent row's id — present once the parent is persisted. */
  private parentId(): any { return (this.parent.draft as any)?.id }

  /** Instant writes fire only when opted in AND the parent row exists. */
  isInstant(): boolean {
    return this.instant && Boolean(this.transport) && this.parentId() != null
  }

  /** Flat snapshot of visible rows for compact custom widgets (reactions). */
  rows(): Array<{ key: string; isNew: boolean; data: Record<string, any> }> {
    return this.visible().map(c => ({ key: c.key, isNew: c.isNew, data: { ...(c.session.draft as any) } }))
  }

  add(defaults: Record<string, any> = {}): NestedChild | null {
    if (this.locked) return null
    const child: NestedChild = {
      key: `new:${++this.seq}`,
      session: this.makeChildSession({ ...defaults }, true),
      isNew: true,
      destroyed: false,
    }
    this.children.push(child)
    this.parent.notifyExternal(this.name)
    // Instant: persist immediately and adopt the server id; on failure the
    // optimistic row is removed. When the parent is still new, this no-ops
    // and the row stages into the parent save.
    if (this.isInstant()) void this.instantCreate(child)
    return child
  }

  private async instantCreate(child: NestedChild): Promise<void> {
    const payload = { ...(child.session.draft as any) }
    delete payload.id
    if (this.foreignKey) payload[this.foreignKey] = this.parentId()
    let res: { ok: boolean; row?: Record<string, any> }
    try { res = await this.transport!.create(payload) } catch { res = { ok: false } }
    if (res.ok && res.row?.id != null) {
      ;(child.session.draft as any).id = res.row.id
      child.isNew = false
      child.key = `id:${res.row.id}`
      child.session.resetBaseline()
    } else {
      const i = this.children.indexOf(child)
      if (i !== -1) this.children.splice(i, 1)   // rollback the optimistic add
    }
    this.parent.notifyExternal(this.name)
  }

  /**
   * Change fields on a row. Instant when eligible (optimistic + rollback);
   * otherwise the change stays on the child draft and rides the parent save.
   * `patch` is the op a reactions toggle uses to flip `kind`.
   */
  patch(key: string, data: Record<string, any>): void {
    const child = this.children.find(c => c.key === key)
    if (!child || this.locked) return
    const before: Record<string, any> = {}
    for (const k of Object.keys(data)) before[k] = (child.session.draft as any)[k]
    for (const [k, v] of Object.entries(data)) child.session.setValue(k, v)
    this.parent.notifyExternal(this.name)
    if (this.isInstant() && !child.isNew) {
      void (async () => {
        let ok = false
        try { ok = (await this.transport!.update((child.session.draft as any).id, data)).ok } catch { ok = false }
        if (ok) { child.session.resetBaseline() }
        else {
          for (const [k, v] of Object.entries(before)) child.session.setValue(k, v)   // rollback
          this.parent.notifyExternal(this.name)
        }
      })()
    }
  }

  /**
   * Reorder for drag-and-drop: moves the child to `toIndex` among VISIBLE
   * rows. With a positionField configured, every child's position rewrites
   * to its new index — the diffs ride the next submit like any other edit.
   */
  move(key: string, toIndex: number): void {
    if (this.locked) return
    const visible = this.visible()
    const from = visible.findIndex(c => c.key === key)
    if (from === -1) return
    const clamped = Math.max(0, Math.min(toIndex, visible.length - 1))
    if (from === clamped) return
    const [child] = visible.splice(from, 1)
    visible.splice(clamped, 0, child!)
    // Rebuild the full list preserving destroyed rows at the tail
    this.children = [...visible, ...this.children.filter(c => c.destroyed)]
    const moved: NestedChild[] = []
    if (this.positionField) {
      visible.forEach((c, i) => {
        if ((c.session.draft as any)[this.positionField!] !== i) {
          c.session.setValue(this.positionField!, i)
          moved.push(c)
        }
      })
    }
    this.parent.notifyExternal(this.name)
    // Instant reorder: push each changed position to the server now. Persisted
    // rows only — new rows carry their position into the parent save.
    if (this.isInstant() && this.positionField) {
      for (const c of moved) {
        if (c.isNew) continue
        const pos = (c.session.draft as any)[this.positionField!]
        void this.transport!.update((c.session.draft as any).id, { [this.positionField!]: pos })
          .then(r => { if (r.ok) c.session.resetBaseline() })
          .catch(() => { /* next explicit save reconciles */ })
      }
    }
  }

  /** Persisted rows mark `_destroy`; new rows vanish entirely. */
  remove(key: string): void {
    if (this.locked) return
    const idx = this.children.findIndex(c => c.key === key)
    if (idx === -1) return
    const child = this.children[idx]!
    if (child.isNew) { this.children.splice(idx, 1); this.parent.notifyExternal(this.name); return }
    if (!this.allowDestroy) return   // destroying persisted rows is not opted in — no-op
    // Instant: delete on the server now and drop the row (optimistic, with
    // rollback). Otherwise mark _destroy so it rides the parent save.
    if (this.isInstant()) {
      this.children.splice(idx, 1)
      this.parent.notifyExternal(this.name)
      void (async () => {
        let ok = false
        try { ok = (await this.transport!.destroy((child.session.draft as any).id)).ok } catch { ok = false }
        if (!ok) { this.children.splice(idx, 0, child); this.parent.notifyExternal(this.name) }  // rollback
      })()
      return
    }
    child.destroyed = true
    this.parent.notifyExternal(this.name)
  }

  /**
   * The `<name>Attributes` payload for the parent submit — null when no
   * child has anything to say (so clean submits stay clean).
   */
  attributesPayload(): Array<Record<string, any>> | null {
    if (this.locked) return null   // never send what the mask forbids
    const out: Array<Record<string, any>> = []
    for (const child of this.children) {
      const draft: any = child.session.draft
      if (child.destroyed) {
        if (this.allowDestroy) out.push({ id: draft.id, _destroy: true })
      } else if (child.isNew) {
        const data = { ...child.session.changedData() }
        // A brand-new row's ENTIRE draft is its diff (baseline was the
        // defaults) — except raw grandchild arrays: those fold as
        // <name>Attributes via the child session (nested-nested), never
        // as a fake column
        for (const [k, v] of Object.entries(draft)) {
          if (this.nestedKeys.has(k) || child.session.getNested(k)) continue
          if (typeof v !== 'function' && data[k] === undefined && v !== undefined) data[k] = v
        }
        delete data.id
        out.push({ ...data, _key: child.key })
      } else {
        const diff = child.session.changedData()
        if (Object.keys(diff).length > 0) out.push({ id: draft.id, ...diff })
      }
    }
    return out.length > 0 ? out : null
  }

  /**
   * Client-side validity across live children — blocks the parent submit.
   * gateErrors (not allErrors): recursion pulls grandchildren in, and stale
   * server errors on a child never wedge the parent's resubmit.
   */
  errors(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const child of this.visible()) {
      for (const [field, msgs] of Object.entries(child.session.gateErrors())) {
        out[`${this.name}[${child.key}].${field}`] = msgs
      }
    }
    return out
  }

  /** Parent submit attempted → every live child's errors become visible too. */
  markSubmitAttempted(): void {
    for (const child of this.visible()) child.session.markSubmitAttempted()
  }

  /** Route server errors addressed as `name[id:7].field` / `name[new:3].field`. */
  routeServerError(path: string, msgs: string[]): boolean {
    const m = path.match(new RegExp(`^${this.name}\\[([^\\]]+)\\]\\.(.+)$`))
    if (!m) return false
    const child = this.children.find(c => c.key === m[1])
    if (!child) return false
    child.session.applyExternalErrors({ [m[2]!]: msgs })
    return true
  }

  /**
   * After a successful parent submit, children settle onto their new
   * baselines — RECURSIVELY. Every child is matched to its saved server row
   * (persisted rows by id, new rows adopt fresh rows in order of appearance)
   * and that row is handed to the child's own nested managers, so saved
   * grandchildren re-key/drop too instead of staying `isNew` and being
   * re-created by the next save.
   */
  commitBaselines(savedRows?: any[]): void {
    // Drop destroyed rows and re-key new rows against the server's response
    this.children = this.children.filter(c => !c.destroyed)
    const byId = new Map<any, any>()
    if (savedRows) for (const r of savedRows) if (r?.id != null) byId.set(r.id, r)
    const knownIds = new Set(
      this.children.filter(c => !c.isNew).map(c => (c.session.draft as any).id),
    )
    const fresh = (savedRows ?? []).filter(r => r?.id != null && !knownIds.has(r.id))
    if (!savedRows && this.children.some(c => c.isNew)) {
      // Without the server echoing this association we cannot adopt the new
      // rows' ids — the next save would re-create them. Loud in dev.
      console.warn(
        `[active-drizzle] "${this.name}" has new rows but the save response did not `
        + `include "${this.name}" — add it to the controller's include so new rows `
        + `adopt their server ids (otherwise the next save duplicates them).`,
      )
    }
    let i = 0
    for (const child of this.children) {
      let row: any
      if (child.isNew) {
        row = fresh[i++]
        if (row) {
          ;(child.session.draft as any).id = row.id
          child.isNew = false
          child.key = `id:${row.id}`
        }
      } else {
        row = byId.get((child.session.draft as any).id)
      }
      // Grandchildren settle FIRST against the child's saved row, then the
      // child's own baseline snapshots the fully-settled state
      child.session.settleNested(row)
      child.session.resetBaseline()
    }
    this.parent.notifyExternal(this.name)
  }

  /**
   * Server truth arrived outside the submit path (refetch/rehydrate) and the
   * caller verified no local edits are pending — rebuild the rows to match.
   * Sessions for rows that still exist are REUSED (touched state, React
   * identity) with fresh values folded in via applyEnvelope, which recurses
   * into clean grandchild managers the same way.
   */
  syncFromServer(rows: any[]): void {
    this.children = rows.map(row => {
      const existing = this.children.find(
        c => !c.isNew && row?.id != null && (c.session.draft as any).id === row.id,
      )
      if (existing) {
        existing.session.applyEnvelope({ record: row })
        return existing
      }
      return {
        key: row?.id != null ? `id:${row.id}` : `new:${++this.seq}`,
        session: this.makeChildSession({ ...row }, row?.id == null),
        isNew: row?.id == null,
        destroyed: false,
      }
    })
    this.parent.notifyExternal(this.name)
  }
}
