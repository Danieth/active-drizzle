/**
 * DraftStore — park unsaved edits across navigation (DESIGN-cache-coherence
 * §G2). "Leave page A, come back, your edits survive."
 *
 * Stores the DIFF, never the draft: changedData() (flat dirty fields +
 * nested `<assoc>Attributes` payloads) + the baseline values OF THOSE
 * FIELDS + the version token. Restoring replays the diff through the
 * session's three-way semantics: server unmoved → edit replays silently;
 * server moved a replayed field → the STALE token is kept so the next
 * submit 409s into the conflict UX. A parked draft is just a form session
 * with a long pause in it — every safety theorem extends unchanged.
 *
 * WEAK semantics by design: in-memory, LRU-capped, TTL'd — a courtesy,
 * not a database. Cleared automatically when the form unmounts clean
 * (which includes "after a successful submit").
 */

export interface ParkedDraft {
  /** changedData() snapshot — flat dirty fields + nested payloads. */
  data: Record<string, any>
  /** Baseline values of the flat dirty fields only (conflict detection). */
  baseline: Record<string, any>
  /** The version token the edits were made against. */
  version: string | null
  at: number
}

export class DraftStore {
  private map = new Map<string, ParkedDraft>()
  constructor(
    private max = 50,
    private ttlMs = 30 * 60_000,
  ) {}

  /** Park a diff — or CLEAR the slot when the session left clean. */
  park(key: string, parked: Omit<ParkedDraft, 'at'> | null): void {
    this.map.delete(key)
    if (parked === null) return
    this.map.set(key, { ...parked, at: Date.now() })
    // LRU: Map preserves insertion order; evict oldest beyond cap
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** Read (non-destructive — the next unmount re-parks or clears). */
  take(key: string): ParkedDraft | null {
    const p = this.map.get(key)
    if (!p) return null
    if (Date.now() - p.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    return p
  }

  clear(key: string): void { this.map.delete(key) }
  size(): number { return this.map.size }
}

/** The default per-app store — module singleton, shared by all generated hooks. */
export const defaultDraftStore = new DraftStore()
