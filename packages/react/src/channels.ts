/**
 * The channel client — transport WS4's CLIENT half (O16's epoch filter
 * lives here; DESIGN-transport-work §3 WS4 + Appendix A, as amended to the
 * landed wire).
 *
 * ONE module (I1/DRY): the socket, the frame dispatch, reconnect/backoff,
 * and the epoch filter live HERE — generated hooks and app code call
 * `connectChannels` once and `subscribeRecord`/`subscribeIndex` per
 * surface; nothing about the wire lives in generated strings.
 *
 * DISPATCH (the store is the only sink — I1 holds because this module IS a
 * generated-adjacent response handler):
 *
 *   CHANGE  → JSON.parse(payload bytes) → mergeEnvelope — the ONE decoder
 *             (A0: the payload is buildColumnarEnvelope's own JSON bytes,
 *             byte-compatible with GET/validation slices; destroys arrive
 *             as `{ touched: [{…, op:'destroy', version}] }` and raise
 *             floors through the same call).
 *   SIGNAL  → { table, pk, token } is a RUMOR: store.signal (M3 — never a
 *             value write; also the server's soft-backpressure degrade of
 *             CHANGE). A record sub that carries its codegen validator
 *             then schedules revalidateProjection — C1: the push was a
 *             prepaid pull, and the echo-merge skip makes a signal whose
 *             values already arrived cost zero round trips.
 *             { tag } on an index sub invalidates the list family (the
 *             `onTag` callback) only when tag > known — a false alarm hits
 *             the structure-token guard downstream and costs nothing. A
 *             RE-ack (reconnect / post-RESET) fires onTag even at an EQUAL
 *             tag: the tag covers lifecycle + scope-column membership, not
 *             arbitrary filter crossings, so across a gap tag-equality is
 *             not consumed as a skip (O5's v1 license).
 *   RESET   → header.epoch IS the new epoch: adopt it (outlawing every
 *             replayed frame of the old generation), drop the local sub
 *             (the server retired its side), revalidateProjection(force)
 *             through the WS3 client path, and re-SUB fresh (new subId).
 *
 * THE EPOCH FILTER (O16, landmine 11): delivery order is NOT a security
 * boundary — an old frame can legally arrive after RESET on 𝒞w. Every
 * data frame (CHANGE/SIGNAL) is `peekHeader`ed FIRST — a fixed 9-byte
 * read — and dropped when its epoch precedes current(subId) (or the sub
 * is unknown/retired), BEFORE any msgpack/JSON touches the bytes.
 *
 * SUB dry-run semantics (server: gateway.ts handleSub): a record SUB
 * carrying `cursor` (projFreshAt W) + `projId` IS the WS3 three-way
 * validation — fresh answers SUB_ACK{cursor:v} alone, stale answers
 * SUB_ACK then IMMEDIATELY the dirty CHANGE slice, gone answers
 * SUB_ACK{gone:true,d} (dispatched to store.destroy — a REAL token, T4).
 * The ack's bare cursor is deliberately NOT certified into the store: the
 * ack cannot say whether a dirty CHANGE follows, and certifying before
 * that slice lands would claim stale cells fresh at v — the one forbidden
 * corruption (landmine 3) if the connection died in the gap. The stale
 * slice (or the next revalidation) advances lastSeen lawfully instead.
 *
 * RECONNECT (the C1 heal): close 1001 (deploy drain) ⇒ fast jittered
 * reconnect; 1013 (backpressure) ⇒ short backoff; anything else ⇒
 * exponential backoff 1s→30s with FULL jitter. On every reconnect: mint a
 * NEW one-time token (they are single-use — landmine 6), re-SUB every
 * live sub with cursors (record: projFreshAt recomputed from the store;
 * index: the last known tag), and force-revalidate the mount registry —
 * the socket gap is itself the rumor, so the round trip is mandatory.
 *
 * HEARTBEAT: app-level PING every heartbeatMs (25s default — proxy idle
 * timeouts); a browser client cannot observe protocol-level ws pings, so
 * two missed app PONGs ⇒ the socket is presumed dead ⇒ close + reconnect.
 *
 * TODO(SharedWorker): tab-sharing — one socket per browser profile via
 * SharedWorker (Chrome 148+ Android) with BroadcastChannel+WebLocks
 * fallback — is deliberately out of scope. It lands as a SECOND
 * ChannelTransport implementation behind the same interface; nothing
 * above this module may assume the socket is tab-local.
 */
import {
  FrameType,
  encodeFrame,
  decodeFrame,
  peekHeader,
} from '@active-drizzle/core/frames'
import { EntityStore, entityStore, projFreshAt, type EntityPk } from './entity-store.js'
import { revalidateProjection, type ProjectionValidator } from './validation-client.js'
import { mergeEnvelope, type WireEnvelope } from './wire-envelope.js'

// ── Socket seam (injection point: browser WebSocket, node 'ws', tests) ──────

/** The minimal WebSocket surface the transport drives. The browser global
 *  and node's 'ws' both satisfy it structurally. */
export interface ChannelSocketLike {
  binaryType: string
  readyState: number
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null
  onerror: ((ev?: unknown) => void) | null
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

const SOCKET_OPEN = 1

// ── Public surface ──────────────────────────────────────────────────────────

export interface SubscribeAck {
  ok: boolean
  /** ok:true — record: the ack watermark/token; index: the membership tag. */
  cursor?: number
  /** ok:true, record subs: the record is destroyed at `d` (floor raised). */
  gone?: boolean
  d?: number
  /** ok:false — the refusal. */
  code?: string
  message?: string
}

export interface ChannelSubscription {
  /** Resolves at the FIRST ack (ok or refused). Never rejects — refusals
   *  resolve `{ ok:false, code, message }` and fire `onRefused`. */
  ready: Promise<SubscribeAck>
  unsubscribe(): void
}

export interface RecordSubscribeOptions {
  /** The door's basePath — e.g. '/gw-loans' or '/teams/:teamId/campaigns'. */
  door: string
  id: EntityPk
  /** Scope params (e.g. teamId) — the caller's closure, like every
   *  generated transport. */
  params?: Record<string, unknown>
  /** The codegen twin (mask + projId + transport callables). With it the
   *  SUB rides a cursor (the dry-run IS the WS3 validation) and SIGNAL/
   *  RESET revalidate through the ONE WS3 client module. Without it the
   *  SUB is cursor-less (full envelope CHANGE follows the ack). */
  validator?: ProjectionValidator
  /** TABLE name (store identity space) for gone-dispatch and rumor joins.
   *  Defaults to validator.model. */
  model?: string
  onReset?: (reason: string) => void
  onRefused?: (code: string, message: string) => void
}

export interface IndexSubscribeOptions {
  door: string
  params?: Record<string, unknown>
  /** Membership went stale: `tag` exceeded the last known tag. Invalidate
   *  the door's list family (applyEntityChange / RQ invalidation) — the
   *  structure-token guard makes a false alarm free. */
  onTag?: (tag: number) => void
  onReset?: (reason: string) => void
  onRefused?: (code: string, message: string) => void
}

/**
 * The transport seam. `connectChannels` returns the WebSocket
 * implementation; a SharedWorker tab-sharing implementation is a
 * documented TODO behind this SAME interface.
 */
export interface ChannelTransport {
  subscribeRecord(opts: RecordSubscribeOptions): ChannelSubscription
  subscribeIndex(opts: IndexSubscribeOptions): ChannelSubscription
  /** Register a mounted projection for reconnect revalidation: after every
   *  reconnect the transport runs revalidateProjection(force) over this
   *  registry (the gap is the rumor). Returns the unregister fn. */
  registerMount(spec: ProjectionValidator, pk: EntityPk): () => void
  /** Mint a fresh one-time token and swap the connection's ctx (the server
   *  re-checks every sub; failures RESET individually). Resolves the
   *  server's verdict; false when the socket is down or the mint failed. */
  reauth(): Promise<boolean>
  status(): 'connecting' | 'open' | 'closed'
  close(): void
}

export interface ConnectChannelsOptions {
  /** The WS endpoint — ws(s)://host + channels.path (default /cable). */
  url: string
  /** Mint a one-time upgrade token over the app's own AUTHED HTTP surface
   *  (the scaffold mounts POST `${path}/token`). Called before every dial
   *  and every reauth — tokens are single-use (landmine 6). */
  mintToken: () => Promise<string> | string
  store?: EntityStore
  /** Socket factory (tests, node, future SharedWorker port). Default:
   *  `new WebSocket(url)`. */
  socketFactory?: (url: string) => ChannelSocketLike
  /** App-level PING cadence (default 25000 — proxy idle timeouts). */
  heartbeatMs?: number
  /** Fired after every RE-connect, once resubscriptions are sent and the
   *  mount registry revalidation has been kicked off — the coherence hook
   *  (invalidate subscribed families / refetch what the gap may have
   *  cost). Not fired on the first connect. */
  onReconnect?: () => void
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Jitter source (tests inject a deterministic one). */
  random?: () => number
}

// ── Internals ───────────────────────────────────────────────────────────────

interface SubState {
  kind: 'record' | 'index'
  door: string
  id?: EntityPk
  params?: Record<string, unknown>
  validator?: ProjectionValidator
  model?: string
  onReset?: (reason: string) => void
  onRefused?: (code: string, message: string) => void
  onTag?: (tag: number) => void
  /** Index subs: last known membership tag. */
  tag: number | null
  /** Per-connection server-interned id; null = not currently acked. */
  subId: number | null
  active: boolean
  readyResolve: ((ack: SubscribeAck) => void) | null
  // revalidation coalescing (per sub — a signal burst is one round trip)
  revalidating: boolean
  revalidateQueued: boolean
  revalidateForce: boolean
}

const decoder = new TextDecoder()

export function connectChannels(options: ConnectChannelsOptions): ChannelTransport {
  const store = options.store ?? entityStore
  const heartbeatMs = options.heartbeatMs ?? 25_000
  const minBackoffMs = options.minBackoffMs ?? 1_000
  const maxBackoffMs = options.maxBackoffMs ?? 30_000
  const random = options.random ?? Math.random
  const socketFactory =
    options.socketFactory ??
    ((url: string) => new WebSocket(url) as unknown as ChannelSocketLike)

  // Connection-scoped state (cleared on every close — subIds and epochs
  // are per-connection namespaces).
  /** subId → current epoch: THE O16 filter table. A RESET keeps its entry
   *  (with the bumped epoch) so replayed old-generation frames stay
   *  outlawed for the life of the connection. */
  const epochs = new Map<number, number>()
  const bySubId = new Map<number, SubState>()
  const pendingByRef = new Map<number, SubState>()
  const pendingReauth = new Map<number, (ok: boolean) => void>()

  const subs = new Set<SubState>()
  const mounts = new Set<{ spec: ProjectionValidator; pk: EntityPk }>()

  let socket: ChannelSocketLike | null = null
  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let generation = 0            // guards stale socket callbacks
  let refCounter = 0
  let attempts = 0
  let everConnected = false
  let closedByUser = false
  let missedPongs = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function send(bytes: Uint8Array): void {
    if (socket && socket.readyState === SOCKET_OPEN) socket.send(bytes)
  }

  // ── Subscribe frames ──────────────────────────────────────────────────────

  function sendSub(sub: SubState): void {
    const ref = ++refCounter
    pendingByRef.set(ref, sub)
    const body: Record<string, unknown> = { ref, door: sub.door }
    if (sub.kind === 'record') {
      body['id'] = sub.id
      if (sub.params) body['params'] = sub.params
      const spec = sub.validator
      if (spec) {
        // The cursor is projFreshAt at SEND time — the coverage watermark
        // over HELD, TRACKED cells (never knownVersion — landmine 3). No
        // lawful W ⇒ cursor-less SUB: the server dry-runs get and the full
        // envelope rides back as a CHANGE.
        const entry = store.get(spec.model, sub.id as EntityPk)
        const w = entry ? projFreshAt(entry, spec.fields) : null
        if (w !== null) {
          body['cursor'] = w
          body['projId'] = spec.projId
        }
      }
    } else {
      if (sub.params) body['params'] = sub.params
      if (sub.tag !== null) body['cursor'] = sub.tag
    }
    send(encodeFrame({ type: FrameType.SUB, body }))
  }

  function resolveReady(sub: SubState, ack: SubscribeAck): void {
    const r = sub.readyResolve
    sub.readyResolve = null
    if (r) r(ack)
  }

  // ── Revalidation (the WS3 client path — ONE module, reused) ───────────────

  function scheduleRevalidate(sub: SubState, force: boolean): void {
    const spec = sub.validator
    if (!spec || sub.id === undefined) return
    if (force) sub.revalidateForce = true
    if (sub.revalidating) { sub.revalidateQueued = true; return }
    sub.revalidating = true
    const run = async (): Promise<void> => {
      const wasForce = sub.revalidateForce
      sub.revalidateForce = false
      try {
        await revalidateProjection(store, spec, sub.id as EntityPk, wasForce ? { force: true } : {})
      } catch {
        // Network failure: the sub stays live; the next signal/reconnect
        // retries (C1 — loss is harmless, staleness is bounded by pull).
      }
      if (sub.revalidateQueued) {
        sub.revalidateQueued = false
        void run()
      } else {
        sub.revalidating = false
      }
    }
    // Coalesce a same-burst signal storm into one round trip.
    queueMicrotask(() => { void run() })
  }

  // ── Frame dispatch (server → client) ──────────────────────────────────────

  function onFrameBytes(bytes: Uint8Array): void {
    let header
    try { header = peekHeader(bytes) } catch { return }        // corrupt: drop

    // THE EPOCH FILTER (O16): data frames are judged on the 9-byte peek
    // alone — epoch < current(subId), or an unknown/retired subId, drops
    // the frame BEFORE any msgpack/JSON parse (landmine 11: delivery order
    // is not a security boundary; this filter is).
    if (header.type === FrameType.CHANGE || header.type === FrameType.SIGNAL) {
      const current = epochs.get(header.subId)
      if (current === undefined || header.epoch < current) return
    }

    let frame
    try { frame = decodeFrame(bytes) } catch { return }
    const body = frame.body as Record<string, unknown>

    switch (frame.type) {
      case FrameType.CHANGE: {
        if (!bySubId.has(frame.subId)) return                  // retired sub
        let env: unknown
        try { env = JSON.parse(decoder.decode(frame.payload)) } catch { return }
        // The ONE decoder (A0): the payload is buildColumnarEnvelope's own
        // JSON bytes — per-field M1 merges at each row's token; `touched`
        // destroys raise floors (M2). Zero channel-specific merge logic.
        mergeEnvelope(store, env as WireEnvelope)
        return
      }

      case FrameType.SIGNAL: {
        const sub = bySubId.get(frame.subId)
        if (!sub) return
        const tag = body['tag']
        if (typeof tag === 'number') {
          // Membership tag: invalidate the list family only when the tag
          // ADVANCED (a stale/duplicate tag is silence).
          if (sub.kind === 'index' && (sub.tag === null || tag > sub.tag)) {
            sub.tag = tag
            sub.onTag?.(tag)
          }
          return
        }
        const table = body['table']
        const pk = body['pk']
        const token = body['token']
        if (typeof table === 'string' && (typeof pk === 'string' || typeof pk === 'number') &&
            typeof token === 'number') {
          store.signal(table, pk, token)                       // M3 — a rumor, never a value
          // C1: the rumor was a prepaid pull. Record subs with a validator
          // revalidate through WS3 (echo-merge skip ⇒ usually free).
          if (sub.kind === 'record') scheduleRevalidate(sub, false)
        }
        return
      }

      case FrameType.RESET: {
        // Adopt the NEW epoch first: every old-generation frame still in
        // flight (or replayed) is outlawed from this line on. MAX-JOIN,
        // never assignment (O16: every monotone quantity is a max-join) — a
        // replayed/forged RESET carrying an OLD epoch must not lower the
        // filter table and re-admit old-generation frames.
        epochs.set(frame.subId, Math.max(epochs.get(frame.subId) ?? 0, frame.epoch))
        const sub = bySubId.get(frame.subId)
        if (!sub) return
        bySubId.delete(frame.subId)
        sub.subId = null
        const reason = typeof body['reason'] === 'string' ? body['reason'] : 'reset'
        sub.onReset?.(reason)
        if (!sub.active) return
        // The server retired its side: revalidate through the door (force —
        // the RESET is the rumor) and re-SUB fresh (new subId, epoch 1).
        if (sub.kind === 'record') scheduleRevalidate(sub, true)
        sendSub(sub)
        return
      }

      case FrameType.SUB_ACK: {
        const ref = typeof body['ref'] === 'number' ? body['ref'] : null
        if (ref === null) return
        const sub = pendingByRef.get(ref)
        if (!sub) return
        pendingByRef.delete(ref)
        if (body['ok'] !== true) {
          const code = String(body['code'] ?? 'ERROR')
          const message = String(body['message'] ?? 'subscription refused')
          sub.onRefused?.(code, message)
          resolveReady(sub, { ok: false, code, message })
          return
        }
        if (!sub.active) {
          // Unsubscribed while the ack was in flight: release server-side.
          send(encodeFrame({ type: FrameType.UNSUB, subId: frame.subId, body: {} }))
          return
        }
        sub.subId = frame.subId
        bySubId.set(frame.subId, sub)
        // Max-join like RESET: the epoch filter must never regress (O16).
        epochs.set(frame.subId, Math.max(epochs.get(frame.subId) ?? 0, frame.epoch))
        const ack: SubscribeAck = { ok: true }
        const cursor = body['cursor']
        if (typeof cursor === 'number') ack.cursor = cursor
        if (sub.kind === 'record') {
          if (body['gone'] === true && typeof body['d'] === 'number') {
            ack.gone = true
            ack.d = body['d']
            const model = sub.model ?? sub.validator?.model
            // gone(D) is a REAL destroy token (T4): the monotone floor.
            if (model && sub.id !== undefined) store.destroy(model, sub.id, body['d'])
          }
          // NOTE: a bare ack cursor is deliberately NOT certified — the ack
          // cannot say whether the dirty CHANGE slice follows, and
          // certifying ahead of it would be the forbidden corruption
          // (landmine 3) if the connection died in the gap. See header.
        } else if (typeof cursor === 'number') {
          // RE-ack catch-up (reconnect / post-RESET re-SUB): the gap itself
          // is the rumor. Tag-equality is deliberately NOT consumed as a
          // skip here — O5's v1 bump covers lifecycle writes and scope-
          // column moves, but a value write crossing an arbitrary index
          // FILTER moves membership without bumping, so an equal tag across
          // a gap does not prove same-list. Invalidate on every re-ack; the
          // structure-token guard makes a false alarm cost one cheap 304.
          const isReAck = sub.tag !== null
          if (sub.tag === null || cursor > sub.tag) sub.tag = cursor
          if (isReAck) sub.onTag?.(cursor)
        }
        resolveReady(sub, ack)
        return
      }

      case FrameType.PONG:
        missedPongs = 0
        return

      case FrameType.PING:
        // Server-initiated app ping (not in v1, but the echo is free).
        send(encodeFrame({ type: FrameType.PONG, body }))
        return

      case FrameType.REAUTH: {
        const ref = typeof body['ref'] === 'number' ? body['ref'] : null
        if (ref === null) return
        const resolve = pendingReauth.get(ref)
        if (resolve) { pendingReauth.delete(ref); resolve(body['ok'] === true) }
        return
      }

      default:
        return                                                 // DOC/PRESENCE: reserved
    }
  }

  // ── Heartbeat (app-level: the browser cannot see protocol pings) ──────────

  function startHeartbeat(): void {
    stopHeartbeat()
    missedPongs = 0
    heartbeatTimer = setInterval(() => {
      if (missedPongs >= 2) {
        // Two missed app PONGs: the socket is a zombie (half-open TCP, a
        // dead proxy hop). close() → the reconnect path heals via pulls.
        try { socket?.close() } catch { /* already gone */ }
        return
      }
      missedPongs++
      send(encodeFrame({ type: FrameType.PING, body: { t: Date.now() } }))
    }, heartbeatMs)
    ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  }

  // ── Connect / reconnect ───────────────────────────────────────────────────

  async function connect(): Promise<void> {
    if (closedByUser) return
    state = 'connecting'
    const gen = ++generation
    let token: string
    try {
      token = await options.mintToken()
    } catch {
      if (gen === generation) scheduleReconnect(null)          // mint failed: retry with backoff
      return
    }
    if (closedByUser || gen !== generation) return
    const sep = options.url.includes('?') ? '&' : '?'
    let ws: ChannelSocketLike
    try {
      ws = socketFactory(`${options.url}${sep}token=${encodeURIComponent(token)}`)
    } catch {
      scheduleReconnect(null)
      return
    }
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.onopen = () => { if (gen === generation) onOpen() }
    ws.onmessage = (ev) => {
      if (gen !== generation) return
      const data = ev?.data
      if (data instanceof ArrayBuffer) onFrameBytes(new Uint8Array(data))
      else if (data instanceof Uint8Array) onFrameBytes(data)
      // text frames: not ours — all protocol messages are binary
    }
    ws.onclose = (ev) => { if (gen === generation) onClose(ev?.code) }
    ws.onerror = () => { /* the close event carries the verdict */ }
  }

  function onOpen(): void {
    state = 'open'
    attempts = 0
    startHeartbeat()
    const isReconnect = everConnected
    everConnected = true
    // Fresh subId/epoch namespace per connection; re-SUB every live sub
    // with cursors (record: projFreshAt recomputed NOW from the store —
    // the dry-run IS the catch-up validation; index: last known tag).
    for (const sub of subs) if (sub.active) sendSub(sub)
    if (isReconnect) {
      // The socket gap is itself the rumor: force-revalidate the mount
      // registry through the WS3 client path (the round trip is mandatory
      // — nothing "looks" stale, the gap makes it so).
      for (const m of mounts) {
        void revalidateProjection(store, m.spec, m.pk, { force: true }).catch(() => { /* retried by next gap/signal */ })
      }
      options.onReconnect?.()
    }
  }

  function onClose(code: number | undefined): void {
    stopHeartbeat()
    socket = null
    // The per-connection namespaces die with the connection.
    epochs.clear()
    bySubId.clear()
    pendingByRef.clear()
    for (const resolve of pendingReauth.values()) resolve(false)
    pendingReauth.clear()
    for (const sub of subs) sub.subId = null
    if (closedByUser) { state = 'closed'; return }
    scheduleReconnect(code ?? null)
  }

  function scheduleReconnect(code: number | null): void {
    if (closedByUser || reconnectTimer) return
    state = 'connecting'
    let delayMs: number
    if (code === 1001) {
      // Deploy drain: the server asked us to move — fast, jittered (spread
      // the herd across ~half a second, no backoff).
      delayMs = random() * 500
    } else if (code === 1013) {
      // Backpressure sever: give the server a moment, modest jitter.
      delayMs = 1_000 + random() * 2_000
    } else {
      attempts++
      const cap = Math.min(maxBackoffMs, minBackoffMs * 2 ** (attempts - 1))
      delayMs = random() * cap                                 // FULL jitter
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delayMs)
    ;(reconnectTimer as unknown as { unref?: () => void }).unref?.()
  }

  // ── Public handle ─────────────────────────────────────────────────────────

  function makeSubscription(sub: SubState): ChannelSubscription {
    subs.add(sub)
    const ready = new Promise<SubscribeAck>((resolve) => { sub.readyResolve = resolve })
    if (state === 'open') sendSub(sub)
    return {
      ready,
      unsubscribe() {
        if (!sub.active) return
        sub.active = false
        subs.delete(sub)
        if (sub.subId !== null) {
          send(encodeFrame({ type: FrameType.UNSUB, subId: sub.subId, body: {} }))
          bySubId.delete(sub.subId)
          epochs.delete(sub.subId)                             // unknown subId ⇒ frames drop
          sub.subId = null
        }
        resolveReady(sub, { ok: false, code: 'UNSUBSCRIBED', message: 'unsubscribed before ack' })
      },
    }
  }

  const transport: ChannelTransport = {
    subscribeRecord(opts) {
      const sub: SubState = {
        kind: 'record',
        door: opts.door,
        id: opts.id,
        tag: null,
        subId: null,
        active: true,
        readyResolve: null,
        revalidating: false,
        revalidateQueued: false,
        revalidateForce: false,
      }
      if (opts.params) sub.params = opts.params
      if (opts.validator) sub.validator = opts.validator
      const model = opts.model ?? opts.validator?.model
      if (model) sub.model = model
      if (opts.onReset) sub.onReset = opts.onReset
      if (opts.onRefused) sub.onRefused = opts.onRefused
      return makeSubscription(sub)
    },

    subscribeIndex(opts) {
      const sub: SubState = {
        kind: 'index',
        door: opts.door,
        tag: null,
        subId: null,
        active: true,
        readyResolve: null,
        revalidating: false,
        revalidateQueued: false,
        revalidateForce: false,
      }
      if (opts.params) sub.params = opts.params
      if (opts.onTag) sub.onTag = opts.onTag
      if (opts.onReset) sub.onReset = opts.onReset
      if (opts.onRefused) sub.onRefused = opts.onRefused
      return makeSubscription(sub)
    },

    registerMount(spec, pk) {
      const m = { spec, pk }
      mounts.add(m)
      return () => { mounts.delete(m) }
    },

    async reauth() {
      if (state !== 'open' || !socket) return false
      let token: string
      try { token = await options.mintToken() } catch { return false }
      if (state !== 'open' || !socket) return false
      const ref = ++refCounter
      return new Promise<boolean>((resolve) => {
        pendingReauth.set(ref, resolve)
        send(encodeFrame({ type: FrameType.REAUTH, body: { ref, token } }))
      })
    },

    status: () => state,

    close() {
      if (closedByUser) return
      closedByUser = true
      generation++                                             // orphan any in-flight connect
      stopHeartbeat()
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      const ws = socket
      socket = null
      state = 'closed'
      epochs.clear()
      bySubId.clear()
      pendingByRef.clear()
      for (const resolve of pendingReauth.values()) resolve(false)
      pendingReauth.clear()
      try { ws?.close(1000, 'client closing') } catch { /* gone */ }
    },
  }

  void connect()
  return transport
}
