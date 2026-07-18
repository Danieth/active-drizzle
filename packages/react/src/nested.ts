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

  constructor(
    parent: FormSession<any>,
    name: string,
    initial: any[] | undefined,
    opts: {
      validate?: (draft: any) => Record<string, string[]>
      nestedKeys?: string[]
      positionField?: string
    } = {},
  ) {
    this.parent = parent
    this.name = name
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
    return child
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
    if (this.positionField) {
      visible.forEach((c, i) => {
        if ((c.session.draft as any)[this.positionField!] !== i) {
          c.session.setValue(this.positionField!, i)
        }
      })
    }
    this.parent.notifyExternal(this.name)
  }

  /** Persisted rows mark `_destroy`; new rows vanish entirely. */
  remove(key: string): void {
    if (this.locked) return
    const idx = this.children.findIndex(c => c.key === key)
    if (idx === -1) return
    const child = this.children[idx]!
    if (child.isNew) this.children.splice(idx, 1)
    else child.destroyed = true
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
        out.push({ id: draft.id, _destroy: true })
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
