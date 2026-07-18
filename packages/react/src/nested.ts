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
      mode: isNew ? 'new' : 'edit',
      abilities: null,                       // child masks ride the parent's projection
      ...(this.validateChild ? { validate: this.validateChild } : {}),
      // no transport: children NEVER fetch or submit — the parent owns the wire
    })
  }

  /** Children currently in the form — removed rows are gone from the UI. */
  visible(): NestedChild[] {
    return this.children.filter(c => !c.destroyed)
  }

  /** Every child including destroy-marked ones (for payload folding). */
  all(): NestedChild[] {
    return this.children
  }

  add(defaults: Record<string, any> = {}): NestedChild {
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

  /** After a successful parent submit, children settle onto their new baselines. */
  commitBaselines(savedRows?: any[]): void {
    // Drop destroyed rows and re-key new rows against the server's response
    this.children = this.children.filter(c => !c.destroyed)
    if (savedRows) {
      // Best effort: match still-new children to returned rows by order of appearance
      const knownIds = new Set(
        this.children.filter(c => !c.isNew).map(c => (c.session.draft as any).id),
      )
      const fresh = savedRows.filter(r => r?.id != null && !knownIds.has(r.id))
      let i = 0
      for (const child of this.children) {
        if (!child.isNew) continue
        const row = fresh[i++]
        if (!row) break
        ;(child.session.draft as any).id = row.id
        child.isNew = false
        child.key = `id:${row.id}`
      }
    }
    for (const child of this.children) child.session.resetBaseline()
    this.parent.notifyExternal(this.name)
  }
}
