/**
 * Commit-event tap — transport WS4's emission source (core side).
 *
 * Core owns every in-contract write path and cannot import the controller,
 * so the frames pipeline subscribes HERE: the SAME call sites that persist
 * the O10 write-log (save/destroy in application-record.ts, bulk
 * updateAll/insertAll in relation.ts, counter-cache bumps) emit one
 * CommitEvent per logged commit. Those sites already know table / pk /
 * token / lifecycle / changedKeys for every in-contract path — one source
 * of truth, zero new hook systems, and the bulk paths (which per-model
 * @afterCommit decorators would miss) are covered by construction.
 *
 * DELIVERY: never in-transaction. `emitCommitEvents` defers through the
 * EXISTING afterCommitQueue (boot.ts) — the never-emit-uncommitted
 * guarantee: a rolled-back transaction's queue is discarded with it. The
 * write-log call sites always run inside a wrap for logged models
 * (_saveNeedsTransaction / _destroyNeedsTransaction force it), so the queue
 * is always present there; the no-queue branch fires post-hoc for safety.
 *
 * SHAPE: `record` is a SNAPSHOT instance (fresh instance over a shallow
 * copy of the committed `_attributes` — never the live instance, which app
 * code can mutate inside the gateway's coalescing window; A2 requires the
 * frame's values to be the committed state at `token`) for single-record
 * save/destroy paths — the tier-0 in-memory short-circuit that lets the
 * emitter serialize a CHANGE frame with no reload. Bulk paths (updateAll,
 * insertAll) and counter-cache bumps carry ids only; the emitter downgrades
 * them to SIGNAL frames in v1 (the client joins the rumor via store.signal
 * and the WS3 validation pull heals — C1 makes the downgrade harmless).
 *
 * `changedKeys` are the same keys handed to the write-log bitmap (COLUMN
 * keys for column writes; a key outside the schema numbering is treated by
 * consumers exactly like packChangedBitmap treats it — conservative
 * wildcard, stales every projection rather than hiding from all of them).
 *
 * Publishers are BEST-EFFORT observers: a throwing publisher is reported
 * and dropped from that flush, never propagated into the committing request
 * (frames are best-effort by design — C1; there is deliberately no outbox).
 */
import { afterCommitQueue } from './boot.js'
import { reportError } from './error-reporting.js'
import { LIFECYCLE } from './write-log.js'

export type CommitOp = 'create' | 'update' | 'destroy' | 'undelete'

export interface CommitEvent {
  /** Table name — the identity space (STI subclasses share it). */
  table: string
  pk: string | number
  /** The lock int this commit wrote (destroys: D = loaded + 1). */
  token: number
  op: CommitOp
  /** Changed column keys (create/destroy: [] — lifecycle says it all). */
  changedKeys: string[]
  /** SNAPSHOT record instance frozen at the write point (A2 — never the
   *  live, still-mutable instance) — single-record save/destroy only
   *  (tier-0 short-circuit). Absent on bulk / counter-cache events ⇒
   *  SIGNAL lane. */
  record?: any
}

export type CommitPublisher = (events: CommitEvent[]) => void | Promise<void>

const _publishers = new Set<CommitPublisher>()

/** Subscribe to committed writes on logged models. Returns unsubscribe. */
export function registerCommitPublisher(cb: CommitPublisher): () => void {
  _publishers.add(cb)
  return () => { _publishers.delete(cb) }
}

/** Test/boot hygiene. */
export function resetCommitPublishers(): void {
  _publishers.clear()
}

/** Cheap guard for the hot write path: skip event assembly with no listeners. */
export function hasCommitPublishers(): boolean {
  return _publishers.size > 0
}

async function deliver(events: CommitEvent[]): Promise<void> {
  for (const cb of _publishers) {
    try {
      await cb(events)
    } catch (err) {
      // Best-effort by doctrine: a broken publisher must never fail (or
      // retry-loop) the request whose commit it observes.
      reportError(err, { source: 'transport-events', events: events.length })
    }
  }
}

/**
 * Emit commit events for writes that are part of the CURRENT transaction —
 * deferred to after its outermost commit via the afterCommitQueue (and
 * silently discarded with it on rollback). Callable from inside the write
 * phase, right next to the write-log point.
 */
export function emitCommitEvents(events: CommitEvent[]): void {
  if (events.length === 0 || _publishers.size === 0) return
  const queue = afterCommitQueue.getStore()
  if (queue) {
    queue.push(() => deliver(events))
  } else {
    // No ambient transaction (autocommit write) — the data is already
    // durable; deliver on the microtask queue so the write path never
    // awaits fan-out.
    void Promise.resolve().then(() => deliver(events))
  }
}

/** Map a write-log lifecycle flag to the event op. */
export function lifecycleToOp(lifecycle: number): CommitOp {
  switch (lifecycle) {
    case LIFECYCLE.create: return 'create'
    case LIFECYCLE.destroy: return 'destroy'
    case LIFECYCLE.undelete: return 'undelete'
    default: return 'update'
  }
}
