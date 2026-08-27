/**
 * The channel emitter — transport WS4's publish half + the frame-building
 * helpers the gateway shares.
 *
 * PUBLISH HALF (`startChannelEmitter`): subscribes to core's commit-event
 * tap (registerCommitPublisher — the write-log call sites, deferred through
 * afterCommitQueue) and routes each committed write onto bus channels,
 * applying THE SILENCE RULE first: a change with empty
 * (changedKeys ∩ door mask) publishes NOTHING for that door — projection is
 * the moat, and the ceiling is per VIEW (record channels use the door's
 * get-projection mask, index channels the index-projection mask; a change
 * inside get.expose but outside index.expose is silent on the index channel
 * and vice versa).
 *
 * CHANNEL KEYS (door-keyed — the door is the authorization unit):
 *   rec:${doorId}:${pk}              one record through one door
 *   idx:${doorId}                    the door's index lane (unscoped /
 *                                    scopeBy doors, and the routing fallback)
 *   idx:${doorId}?${scopeHash}       per-tenant index lane of a URL-scoped
 *                                    door — scope params hashed in so bus
 *                                    fanout can never cross tenants
 *
 * Record channels carry no scope hash: the pk itself partitions, and only
 * subscribers who passed the door's dry-run FOR THAT PK hold the channel.
 * A scoped door's VALUE events route to the tenant lane only when the live
 * record is in hand (its scope columns are the truth); everything else
 * reaches the door-wide lane STRIPPED to ids (the record never rides a
 * lane every tenant holds), and the gateway per-pk dry-runs even those
 * ids-only rumors before a SIGNAL touches a subscriber's socket — neither
 * row values NOR pk/token/op metadata cross a tenant boundary. A
 * scope-column value write additionally publishes an ids-only
 * membershipHint door-wide (the row re-tenanted: the tag bumped in-commit,
 * and every tenant's sub must re-read it).
 *
 * SERVING HELPERS: `buildChangeSliceBytes` / `destroySliceBytes` produce a
 * CHANGE frame's raw payload — the UTF-8 JSON bytes of a PARTIAL
 * ColumnarEnvelope `{ entities, touched? }` from buildColumnarEnvelope (the
 * ONE serializer; A0: byte-compatible with GET/validation slices, framed
 * raw inside the binary envelope). Frame slices serialize the root row plus
 * belongsTo linkage only — hasMany membership rides its own lane (the
 * emitter never loaded children, and absence ≠ [] is the honest wire
 * statement; the client's pk-arrays stay untouched).
 */
import { createHash } from 'node:crypto'
import {
  registerCommitPublisher,
  fieldNumberingFor,
  isWriteLogged,
  normalizeIncludeSpecs,
  resolveWireAssociation,
  modelClassName,
  type CommitEvent,
  type CommitOp,
} from '@active-drizzle/core'
import { buildColumnarEnvelope } from '../columnar-envelope.js'
import {
  columnarDoorsForTable,
  type ColumnarDoorTransportEntry,
} from '../validate-handler.js'
import type { ChannelBus, BusCommitEvent } from './bus.js'

// ── Channel keys ────────────────────────────────────────────────────────────

export function recordChannel(doorId: string, pk: string | number): string {
  return `rec:${doorId}:${pk}`
}

export function indexChannel(doorId: string, scopeHash?: string): string {
  return scopeHash ? `idx:${doorId}?${scopeHash}` : `idx:${doorId}`
}

/**
 * Both lanes of a door's index channel (subscriptions listen to both). The
 * tenant-lane hash is computed over the door's SCOPE params ONLY, picked
 * out of whatever params the caller holds — the publish side hashes the
 * record's scope columns and the subscribe side receives the client's full
 * SUB params (filters, sort, perPage ride along for the dry-run); hashing
 * anything beyond the scope params would silently subscribe a lane nobody
 * publishes. A missing scope param falls back to the door-wide lane alone
 * (the dry-run will have refused such a SUB anyway).
 */
export function indexChannelsFor(entry: ColumnarDoorTransportEntry, params: Record<string, any>): string[] {
  const doorWide = indexChannel(entry.doorId)
  if (entry.scopes.length === 0) return [doorWide]
  const scopeParams: Record<string, any> = {}
  for (const s of entry.scopes) {
    const v = params[s.paramName]
    if (v == null) return [doorWide]
    scopeParams[s.paramName] = v
  }
  return [indexChannel(entry.doorId, scopeHashOf(scopeParams)), doorWide]
}

/**
 * Deterministic hash of resolved scope params (key-order invariant; values
 * String()-normalized so a URL "42" and a column 42 agree). 128 bits of
 * SHA-256: the tenant lane is a routing boundary the gateway additionally
 * re-checks for record-less events, but the value lane trusts it — keep
 * collisions out of adversarial reach, not merely accidental reach.
 */
export function scopeHashOf(params: Record<string, any>): string {
  const canonical = Object.keys(params).sort().map(k => `${k}=${String(params[k])}`).join('&')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

// ── The silence rule ────────────────────────────────────────────────────────

/**
 * Does this event's change intersect the mask? Lifecycle events always pass
 * (create/destroy/undelete are relevant to every projection of the record).
 * A changed key OUTSIDE the table's column numbering is a conservative
 * wildcard — the same doctrine as packChangedBitmap: an unknown change
 * stales every projection rather than hiding from all of them.
 */
export function changeIntersectsMask(
  event: Pick<CommitEvent, 'op' | 'changedKeys' | 'table'>,
  mask: Set<string>,
): boolean {
  if (event.op !== 'update') return true
  let numbering: Set<string> | null = null
  try { numbering = new Set(fieldNumberingFor(event.table)) } catch { numbering = null }
  return event.changedKeys.some(k => mask.has(k) || (numbering !== null && !numbering.has(k)))
}

// ── The publish half ────────────────────────────────────────────────────────

function scopeParamsFromRecord(entry: ColumnarDoorTransportEntry, record: any): Record<string, any> | null {
  const out: Record<string, any> = {}
  for (const s of entry.scopes) {
    const v = record?.[s.field] ?? record?._attributes?.[s.field]
    if (v == null) return null                  // cannot place the row — fall back
    out[s.paramName] = v
  }
  return out
}

export interface StartEmitterOptions {
  bus: ChannelBus
}

/**
 * Wire the commit tap to the bus. Returns a stop function. One emitter per
 * process is the intended shape (attachChannels starts it; a publish-only
 * process calls this directly).
 */
export function startChannelEmitter({ bus }: StartEmitterOptions): () => void {
  return registerCommitPublisher((events: CommitEvent[]) => {
    for (const event of events) {
      if (!isWriteLogged(event.table)) continue  // registry may have reset under us
      for (const entry of columnarDoorsForTable(event.table)) {
        routeEventThroughDoor(bus, entry, event)
      }
    }
  })
}

function routeEventThroughDoor(bus: ChannelBus, entry: ColumnarDoorTransportEntry, event: CommitEvent): void {
  const busEvent: BusCommitEvent = {
    table: event.table,
    pk: event.pk,
    token: event.token,
    op: event.op,
    changedKeys: event.changedKeys,
  }
  if (event.record !== undefined) busEvent.record = event.record

  // ── Record lane (silence rule over the GET projection) ───────────────────
  if (changeIntersectsMask(event, entry.getMask())) {
    bus.publish(recordChannel(entry.doorId, event.pk), busEvent)
  }

  // ── Index lane (membership events always; value events under the INDEX
  //    projection; scope-column moves ALWAYS — they are membership events in
  //    value clothing, even when the scope column is outside every mask) ────
  const membership = event.op !== 'update'
  // A scope-column VALUE write re-tenants the row: membership moved on
  // BOTH tenants' lists (the tag bumped in-commit — write-log.ts). The
  // NEW tenant's lane gets the value event; the door-wide lane gets an
  // ids-only membership hint so every other tenant's sub re-reads its tag.
  const scopeMoved = event.op === 'update' && entry.scopes.length > 0
    && event.changedKeys.some(k => entry.scopes.some(s => s.field === k))
  const valueRelevant = !membership && changeIntersectsMask(event, entry.indexMask())
  if (!membership && !valueRelevant && !scopeMoved) return

  if (entry.scopes.length > 0) {
    if (event.record !== undefined) {
      const scopeParams = scopeParamsFromRecord(entry, event.record)
      if (scopeParams) {
        bus.publish(indexChannel(entry.doorId, scopeHashOf(scopeParams)), busEvent)
        if (scopeMoved) bus.publish(indexChannel(entry.doorId), idsOnly(busEvent, true))
        return
      }
      // Unplaceable record (null scope column): STRIP the record before the
      // door-wide publish — a scoped door's row values must never reach a
      // lane every tenant holds. The gateway's per-pk dry-run then gates
      // even the ids-only rumor per subscriber.
      bus.publish(indexChannel(entry.doorId), idsOnly(busEvent, scopeMoved))
      return
    }
    bus.publish(indexChannel(entry.doorId), idsOnly(busEvent, scopeMoved))
    return
  }
  // Unscoped / scopeBy doors: the door-wide lane. scopeBy value events (with
  // or without a record) are per-pk dry-run-gated by the gateway before
  // anything — values OR pk metadata — reaches a subscriber's socket.
  bus.publish(indexChannel(entry.doorId), busEvent)
}

/** The door-wide copy of a scoped door's event: ids only, never the record. */
function idsOnly(event: BusCommitEvent, membershipHint: boolean): BusCommitEvent {
  const out: BusCommitEvent = {
    table: event.table, pk: event.pk, token: event.token,
    op: event.op, changedKeys: event.changedKeys,
  }
  if (membershipHint) out.membershipHint = true
  return out
}

// ── Frame slice building (the serving half's serializer seam) ───────────────

const _frameIncludeMemo = new WeakMap<object, string[]>()

/**
 * The include names a CHANGE slice serializes: the door's belongsTo entries
 * only (FK linkage columns ride; unloaded children recurse to nothing).
 * hasMany pk-arrays are deliberately excluded — the emitter never loaded
 * them, and an omitted column is the honest wire statement (absence ≠ []).
 */
export function frameIncludeNames(entry: ColumnarDoorTransportEntry): string[] {
  let names = _frameIncludeMemo.get(entry.config as object)
  if (!names) {
    names = normalizeIncludeSpecs(
      (entry.config.get?.include ?? []) as any[], modelClassName(entry.model),
    )
      .filter(e => resolveWireAssociation(entry.model, e.name)?.kind === 'belongsTo')
      .map(e => e.name)
    _frameIncludeMemo.set(entry.config as object, names)
  }
  return names
}

const _utf8 = new TextEncoder()

export interface ChangeSlice {
  /** UTF-8 JSON bytes of { entities, touched? } — the CHANGE frame payload. */
  bytes: Uint8Array
  /** The committed tokens carried (per root row) — SIGNAL degrade material
   *  (`op` keeps the degraded rumor honest: a destroy must not degrade to
   *  an 'update' announcement). */
  tokens: Array<{ pk: string | number; token: number; op: CommitOp }>
}

/**
 * Serialize root record instances into a CHANGE slice through the ONE
 * serializer. Multi-row batches share one frame; a k-divergence (two rows
 * of one table disagreeing about loaded state) falls back to per-row
 * sections by serializing individually and merging — never a dropped frame.
 */
export function buildChangeSliceBytes(entry: ColumnarDoorTransportEntry, records: any[]): ChangeSlice {
  const includeSpecs = frameIncludeNames(entry) as any[]
  const serialize = (roots: any[]) =>
    buildColumnarEnvelope(roots, entry.model, entry.config, { includeSpecs }).entities
  let entities: Record<string, any>
  try {
    entities = serialize(records)
  } catch {
    // k-divergence fallback: one frame per row is always uniform.
    entities = {}
    for (const r of records) {
      const one = serialize([r])
      for (const [table, section] of Object.entries<any>(one)) {
        const acc = entities[table]
        if (!acc) { entities[table] = { k: section.k, v: [...section.v], r: [...section.r] } }
        else if (acc.k.length === section.k.length && acc.k.every((c: string, i: number) => c === section.k[i])) {
          acc.v.push(...section.v)
          acc.r.push(...section.r)
        }
        // Genuinely divergent k: keep the first shape; the dropped row's
        // subscriber heals via the validation pull (C1).
      }
    }
  }
  const lockedTokens: ChangeSlice['tokens'] = []
  const root = entities[entry.tableName]
  if (root) {
    for (let i = 0; i < root.r.length; i++) {
      const pk = root.r[i][0]
      const token = root.v[i]
      if (pk != null && typeof token === 'number') lockedTokens.push({ pk, token, op: 'update' })
    }
  }
  return { bytes: _utf8.encode(JSON.stringify({ entities })), tokens: lockedTokens }
}

/** A destroy's CHANGE payload: the touched lane only — mergeEnvelope raises
 *  floors (M2), zero new client code. */
export function destroySliceBytes(entry: ColumnarDoorTransportEntry, pk: string | number, token: number): Uint8Array {
  return _utf8.encode(JSON.stringify({
    touched: [{ resource: entry.tableName, id: pk, op: 'destroy', version: token }],
  }))
}

/** Strip a full door envelope (get/validate output) to the frame slice. */
export function sliceBytesFromEnvelope(envelope: { entities?: any; touched?: any }): Uint8Array {
  const slim: Record<string, unknown> = { entities: envelope.entities ?? {} }
  if (envelope.touched) slim['touched'] = envelope.touched
  return _utf8.encode(JSON.stringify(slim))
}
