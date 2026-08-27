/**
 * The channel gateway — transport WS4's serving half (O16 lands here).
 *
 * `attachChannels(httpServer, { routers, config })` mounts a `ws` upgrade
 * handler on the SAME http server the app already serves (the scaffold's
 * @hono/node-server instance), at `channels.path` (default /cable).
 *
 * AUTH (landmine 6 — browsers cannot set upgrade headers; cookies alone are
 * CSWSH): Origin allowlist FIRST, then a short-lived ONE-TIME upgrade token
 * minted over the app's own authed HTTP surface (`mintToken(ctx)` — the
 * attach-guard pattern) and consumed from `?token=`. Single-use + ~10s TTL
 * is why a query-string token is acceptable here. The token map is
 * in-memory: mint and upgrade must hit the SAME process (sticky LB) until a
 * shared store ships — a documented limitation, not a surprise.
 *
 * SUBSCRIBE = THE DOOR, DRY-RUN, VIA THE BUILT PROCEDURES: a SUB invokes
 * the door's already-built oRPC procedures in-process (`call()` with the
 * connection's ctx) — validate (record SUB with cursor: the SUB dry-run IS
 * the WS3 three-way validation), get (cursor-less), index perPage:1 (index
 * SUB; the membership tag is the cursor). scope, scopeBy, and only:-scoped
 * hook aliases all run — NO second permission system exists anywhere.
 *
 * EPOCHS (O16): per (connection, subscription) uint32 starting at 1, bumped
 * only by RESET (emission-time re-verification failure, REAUTH re-check
 * failure, backpressure hard recovery). Stamped at socket-write time —
 * epochs NEVER ride the bus. The epoch filter — not delivery order — is the
 * revocation boundary (landmine 11): a failed re-check sends RESET, never a
 * silent drop.
 *
 * REVOCATION RE-CHECK (BOTH lanes): `channels.revalidate` seconds of TTL
 * cache a door pass per subscription. RECORD subs: inside the TTL, tier-0
 * events (record snapshot in hand) serialize directly; events without a
 * record — and every event once the TTL lapses, and always under
 * revalidate:'always' — REBUILD the slice by reloading the record THROUGH
 * the door (`call(get)`) with the subscription's ctx: the reload IS the
 * re-check, paid once for two things. Destroy frames are ALSO gated on a
 * valid pass (an expired pass downgrades to RESET — a reload cannot
 * re-check a destroyed record, and pk+destroy+token past the TTL is the
 * tombstone-oracle triple). INDEX subs: an expired pass re-runs the index
 * dry-run before any flush emits; failure RESETs. Scoped doors' index
 * events additionally pass a per-pk TTL'd dry-run before EITHER a value
 * slice OR an ids-only SIGNAL reaches the socket — on a multi-process bus
 * every remote event is record-less, so that gate IS the tenant boundary
 * for pk/token/op metadata, not a fallback.
 *
 * RESOURCE CAPS (authenticated-DoS bounds): `ws` maxPayload 64KB (client
 * frames are control-sized); maxConnections refuses upgrades 503 at the
 * cap; maxSubsPerConnection caps live subs (SUB_LIMIT) and doubles as the
 * SUB token-bucket burst (refill SUB_REFILL_PER_SECOND — every SUB dry-run
 * is a real DB query and must not be free to spam).
 *
 * BACKPRESSURE (per socket, at send): bufferedAmount > 1MB soft ⇒ queued
 * CHANGE degrades to SIGNAL (tokens only — the rumor is enough, C1 heals
 * via pull); > 4MB hard ⇒ close 1013, reconnect + revalidate heals.
 * PRESENCE dropping is reserved prose (no PRESENCE in v1); DOC frames, when
 * WS5 lands, must NEVER be dropped or degraded (RESET-to-cursor instead) —
 * recorded here so the doc lane doesn't inherit a trap.
 *
 * HEARTBEAT: protocol-level ws pings every heartbeatMs (terminate after 2
 * missed pongs). App-level PING/PONG frames answer CLIENT liveness probes —
 * the browser WebSocket API cannot observe protocol pings. Both, each cheap.
 * DRAIN: close() sends 1001 to every socket (deploy roll — the client
 * treats 1001 as fast reconnect-with-jitter).
 */
import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { call } from '@orpc/server'
import {
  resolveChannelsConfig,
  assertChannelsServable,
  currentMembershipTag,
  type TrailsConfig,
  type ResolvedChannelsConfig,
} from '@active-drizzle/core'
import { encodeFrame, decodeFrame, FrameType } from '@active-drizzle/core/frames'
import {
  columnarDoorFor,
  type ColumnarDoorTransportEntry,
} from '../validate-handler.js'
import { createBus, type ChannelBus, type BusCommitEvent } from './bus.js'
import {
  startChannelEmitter,
  recordChannel,
  indexChannelsFor,
  buildChangeSliceBytes,
  destroySliceBytes,
  sliceBytesFromEnvelope,
} from './emitter.js'

export const SOFT_BUFFERED_BYTES = 1 * 1024 * 1024
export const HARD_BUFFERED_BYTES = 4 * 1024 * 1024
/** Client→server frames are control-sized (SUB/UNSUB/PING/REAUTH — CHANGE
 *  is server→client only). Without a cap, `ws` buffers up to 100MiB per
 *  frame: one authenticated socket could OOM the shared gateway. */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024
/** Sustained SUB budget per connection once the burst bucket (sized to
 *  maxSubsPerConnection — a reconnect re-SUBs everything at once) drains.
 *  Every SUB dry-run is a real DB query; a tight SUB loop is a DB DoS. */
export const SUB_REFILL_PER_SECOND = 20

// ── The backpressure seam (exported: the thresholds and the degrade are
//    testable against a fake socket without a stalled TCP peer) ─────────────

/** The minimal socket surface backpressure decisions read/drive. */
export interface BackpressureSocket {
  readyState: number
  bufferedAmount: number
  send(bytes: Uint8Array): void
  close(code?: number, reason?: string): void
}

const WS_OPEN = 1

/** Raw frame send with the HARD limit: a consumer that cannot keep up is
 *  severed (1013 Try Again Later) — reconnect + revalidation heal (C1). */
export function sendFrameWithBackpressure(ws: BackpressureSocket, bytes: Uint8Array): void {
  if (ws.readyState !== WS_OPEN) return
  if (ws.bufferedAmount > HARD_BUFFERED_BYTES) {
    ws.close(1013, 'backpressure')
    return
  }
  ws.send(bytes)
}

/**
 * CHANGE send with the SOFT degrade: above SOFT_BUFFERED_BYTES the payload
 * is dropped and only the tokens ride as SIGNALs (each with its HONEST op —
 * a degraded destroy must not announce itself as an update). Safe ONLY
 * because frames are absolute values under Rule M — a future DOC lane must
 * bypass this path entirely (never-drop-DOC).
 */
export function sendChangeWithBackpressure(
  ws: BackpressureSocket,
  meta: { subId: number; epoch: number; table: string },
  payload: Uint8Array,
  tokens: Array<{ pk: string | number; token: number; op: string }>,
): void {
  if (ws.readyState !== WS_OPEN) return
  if (ws.bufferedAmount > SOFT_BUFFERED_BYTES) {
    for (const t of tokens) {
      sendFrameWithBackpressure(ws, encodeFrame({
        type: FrameType.SIGNAL, subId: meta.subId, epoch: meta.epoch,
        body: { table: meta.table, pk: t.pk, token: t.token, op: t.op },
      }))
    }
    return
  }
  sendFrameWithBackpressure(ws, encodeFrame({
    type: FrameType.CHANGE, subId: meta.subId, epoch: meta.epoch, body: {}, payload,
  }))
}

// ── Options / handle ────────────────────────────────────────────────────────

export interface AttachChannelsOptions {
  /** The built doors — buildRouter results (basePath is the door id). */
  routers: Array<{ basePath: string; router: Record<string, any> }>
  /** The resolved trails config (channels + database.url are read). */
  config?: TrailsConfig
  /** Pre-built bus (tests / custom tiers); otherwise created from config. */
  bus?: ChannelBus
  /** NODE_ENV override for the production origin gate. */
  env?: string
}

export interface ChannelsHandle {
  /** Mint a one-time upgrade token bound to this ctx (mount this behind
   *  your own auth: POST `${path}/token` in the scaffold). */
  mintToken(ctx: any): string
  /** The WS mount path (config.channels.path). */
  path: string
  bus: ChannelBus
  connectionCount(): number
  close(): Promise<void>
}

// ── Connection / subscription state ─────────────────────────────────────────

interface Sub {
  subId: number
  epoch: number
  kind: 'record' | 'index'
  entry: ColumnarDoorTransportEntry
  router: Record<string, any>
  pk?: string | number
  params: Record<string, any>
  unsubs: Array<() => void>
  /** Door-pass expiry (ms epoch). 0 = must re-check on next emit. */
  passUntil: number
  /** scopeBy index subs: per-pk dry-run pass expiry. */
  pkPass: Map<string | number, number>
  /** Coalescer: pk → latest event (supersede older tokens). */
  pendingByPk: Map<string | number, BusCommitEvent>
  pendingMembership: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
}

interface Conn {
  ws: WebSocket
  ctx: any
  subs: Map<number, Sub>
  nextSubId: number
  missedPongs: number
  /** SUB rate limiting (token bucket; capacity = maxSubsPerConnection). */
  subTokens: number
  subTokensAt: number
}

// ── attachChannels ──────────────────────────────────────────────────────────

export async function attachChannels(
  server: HttpServer,
  options: AttachChannelsOptions,
): Promise<ChannelsHandle> {
  const cfg: ResolvedChannelsConfig = resolveChannelsConfig(options.config?.channels ?? {})
  const env = options.env ?? process.env.NODE_ENV ?? 'development'
  assertChannelsServable(cfg, env)

  const routers = new Map(options.routers.map(r => [r.basePath, r.router]))
  const bus = options.bus
    ?? await createBus(cfg.bus, { databaseUrl: (options.config?.database as any)?.url })
  const stopEmitter = startChannelEmitter({ bus })

  // ── One-time upgrade tokens (attach-guard pattern; in-memory, sticky-LB) ──
  const tokens = new Map<string, { ctx: any; exp: number }>()
  function mintToken(ctx: any): string {
    const now = Date.now()
    for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t)   // opportunistic prune
    const token = randomBytes(24).toString('base64url')
    tokens.set(token, { ctx, exp: now + cfg.tokenTtlMs })
    return token
  }
  function consumeToken(token: string | null): { ok: boolean; ctx?: any } {
    if (!token) return { ok: false }
    const entry = tokens.get(token)
    tokens.delete(token)                        // single use, even when expired
    if (!entry || entry.exp < Date.now()) return { ok: false }
    return { ok: true, ctx: entry.ctx }
  }

  function originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true       // non-browser client; token still gates
    if (cfg.originAllowlist && cfg.originAllowlist.length > 0) {
      return cfg.originAllowlist.includes(origin)
    }
    // Development default: localhost origins only.
    try {
      const host = new URL(origin).hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    } catch { return false }
  }

  // ── The socket server ─────────────────────────────────────────────────────
  // maxPayload: client frames are control-sized; the `ws` default (100MiB)
  // would let one authenticated socket buffer the gateway into OOM.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES })
  const conns = new Set<Conn>()

  function refuseUpgrade(socket: any, status: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    } catch { /* already gone */ }
    socket.destroy()
  }

  const onUpgrade = (req: any, socket: any, head: Buffer): void => {
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') } catch { return refuseUpgrade(socket, 400, 'Bad Request') }
    if (url.pathname !== cfg.path) return       // not ours — leave for other handlers
    if (!originAllowed(req.headers.origin)) {
      return refuseUpgrade(socket, 403, 'Forbidden')  // CSWSH gate — landmine 6
    }
    if (conns.size >= cfg.maxConnections) {
      // Before the token look: a refused client keeps its unspent token for
      // the retry. 503 = capacity, not auth.
      return refuseUpgrade(socket, 503, 'Service Unavailable')
    }
    const consumed = consumeToken(url.searchParams.get('token'))
    if (!consumed.ok) return refuseUpgrade(socket, 401, 'Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Conn = {
        ws, ctx: consumed.ctx, subs: new Map(), nextSubId: 0, missedPongs: 0,
        subTokens: cfg.maxSubsPerConnection, subTokensAt: Date.now(),
      }
      conns.add(conn)
      ws.on('pong', () => { conn.missedPongs = 0 })
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return
        void handleFrame(conn, new Uint8Array(data)).catch(() => { /* per-frame errors answered inline */ })
      })
      ws.on('close', () => {
        for (const sub of conn.subs.values()) teardownSub(sub)
        conns.delete(conn)
      })
    })
  }
  server.on('upgrade', onUpgrade)

  // ── Heartbeat (protocol-level; terminate after 2 missed pongs) ────────────
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (conn.missedPongs >= 2) { conn.ws.terminate(); continue }
      conn.missedPongs++
      try { conn.ws.ping() } catch { /* closing */ }
    }
  }, cfg.heartbeatMs)
  heartbeat.unref?.()

  // ── Frame sending (the exported backpressure seam, bound to this conn) ────
  function sendRaw(conn: Conn, bytes: Uint8Array): void {
    sendFrameWithBackpressure(conn.ws as unknown as BackpressureSocket, bytes)
  }

  function sendChange(conn: Conn, sub: Sub, payload: Uint8Array, tokens: Array<{ pk: string | number; token: number; op: string }>): void {
    sendChangeWithBackpressure(
      conn.ws as unknown as BackpressureSocket,
      { subId: sub.subId, epoch: sub.epoch, table: sub.entry.tableName },
      payload, tokens,
    )
  }

  function sendReset(conn: Conn, sub: Sub, reason: string): void {
    sub.epoch += 1
    sendRaw(conn, encodeFrame({
      type: FrameType.RESET, subId: sub.subId, epoch: sub.epoch, body: { reason },
    }))
    // The sub is retired: the client re-subscribes (fresh dry-run, new
    // subId). Its bus lanes close now; the bumped epoch already outlaws any
    // frame the old generation could still emit (O16 — the filter, not
    // delivery order, is the boundary).
    teardownSub(sub)
    conn.subs.delete(sub.subId)
  }

  function teardownSub(sub: Sub): void {
    for (const u of sub.unsubs) u()
    sub.unsubs = []
    if (sub.flushTimer) { clearTimeout(sub.flushTimer); sub.flushTimer = null }
  }

  // ── Emission → per-sub coalescing → frames ────────────────────────────────
  function enqueue(conn: Conn, sub: Sub, event: BusCommitEvent): void {
    const existing = sub.pendingByPk.get(event.pk)
    // Supersede: same-pk older tokens die in the window (absolute values
    // under Rule M make dropping the older payload safe — C1). At EQUAL
    // tokens keep the record-carrying copy (a scoped event can arrive on
    // both lanes: value on the tenant lane, ids-only hint door-wide).
    const wins = !existing
      || event.token > existing.token
      || (event.token === existing.token
          && (event.record !== undefined || existing.record === undefined))
    if (wins) sub.pendingByPk.set(event.pk, event)
    if (sub.kind === 'index' && (event.op !== 'update' || event.membershipHint)) {
      sub.pendingMembership = true
    }
    if (!sub.flushTimer) {
      sub.flushTimer = setTimeout(() => { void flushSub(conn, sub) }, cfg.coalesceMs)
      sub.flushTimer.unref?.()
    }
  }

  const revalidateMs = cfg.revalidate === 'always' ? 0 : cfg.revalidate * 1000

  async function flushSub(conn: Conn, sub: Sub): Promise<void> {
    sub.flushTimer = null
    if (conn.ws.readyState !== conn.ws.OPEN || !conn.subs.has(sub.subId)) return
    const events = [...sub.pendingByPk.values()]
    sub.pendingByPk.clear()
    const membership = sub.pendingMembership
    sub.pendingMembership = false
    try {
      if (sub.kind === 'record') await flushRecordSub(conn, sub, events)
      else await flushIndexSub(conn, sub, events, membership)
    } catch {
      // A flush must never take the connection down; the client's
      // revalidation pull heals whatever this window lost (C1).
    }
  }

  async function flushRecordSub(conn: Conn, sub: Sub, events: BusCommitEvent[]): Promise<void> {
    const now = Date.now()
    const passValid = revalidateMs > 0 && now < sub.passUntil
    const direct: any[] = []
    let needsReload = false
    for (const event of events) {
      if (event.op === 'destroy') {
        // Destroys never need the record — the tombstone facts suffice —
        // but they ARE gated on a valid pass: pk + destruction + the destroy
        // token is exactly the fact triple the tombstone-oracle fences
        // guard (proof §6), and a subscriber revoked past the TTL must not
        // receive it here when the validate lane would refuse it. A reload
        // cannot re-check a destroyed record, so an expired pass downgrades
        // to RESET: the client's forced re-SUB re-answers the destroy
        // through the door's own validate/tombstone fences (gone(D) on an
        // unscoped door, 404 on a scoped one).
        if (!passValid) return sendReset(conn, sub, 'revoked')
        sendChange(conn, sub, destroySliceBytes(sub.entry, event.pk, event.token),
          [{ pk: event.pk, token: event.token, op: 'destroy' }])
        continue
      }
      if (event.record !== undefined && passValid) direct.push(event.record)
      else needsReload = true
    }
    if (direct.length > 0) {
      const slice = buildChangeSliceBytes(sub.entry, direct)
      sendChange(conn, sub, slice.bytes, slice.tokens)
    }
    if (needsReload) {
      // Reload THROUGH the door with this subscription's ctx — the reload IS
      // the revocation re-check (T9; a failure is a RESET, never a silent
      // drop — the epoch filter is the security boundary).
      try {
        const envelope: any = await call(sub.router['get'], { id: sub.pk, ...sub.params } as any, { context: conn.ctx })
        sub.passUntil = Date.now() + revalidateMs
        const slice = sliceBytesFromEnvelope(envelope)
        const root = envelope?.entities?.[sub.entry.tableName]
        const tokens = root && root.r?.[0]?.[0] != null && typeof root.v?.[0] === 'number'
          ? [{ pk: root.r[0][0], token: root.v[0], op: 'update' }]
          : []
        sendChange(conn, sub, slice, tokens)
      } catch {
        sendReset(conn, sub, 'revoked')
      }
    }
  }

  /** The TTL-cached per-pk dry-run through the door (scoped index lanes):
   *  a record outside this ctx's scope is simply not this channel's —
   *  routing, not revocation, so a miss is a skip, never a RESET. Gates
   *  BOTH value slices and ids-only SIGNALs: pk + token + op metadata is
   *  exactly what a tenant boundary must hide (§6 tombstone-oracle class). */
  async function pkPassCheck(conn: Conn, sub: Sub, pk: string | number, now: number): Promise<boolean> {
    const pass = sub.pkPass.get(pk)
    if (pass !== undefined && now < pass) return true
    try {
      await call(sub.router['get'], { id: pk, ...sub.params } as any, { context: conn.ctx })
      sub.pkPass.set(pk, now + Math.max(revalidateMs, 1))
      return true
    } catch {
      sub.pkPass.delete(pk)
      return false
    }
  }

  async function flushIndexSub(conn: Conn, sub: Sub, events: BusCommitEvent[], membership: boolean): Promise<void> {
    const now = Date.now()
    // T9 on the INDEX lane too: the door pass has the same TTL as the
    // record lane — an expired pass re-runs the index dry-run with this
    // subscription's ctx, and a failure is a RESET, never a silent drop or
    // an unbounded stream. Without this, revocation (a hook-gated door, a
    // banned session) would never be re-detected on index subs.
    if (!(revalidateMs > 0 && now < sub.passUntil)) {
      try {
        await call(sub.router['index'], { ...sub.params, perPage: 1 } as any, { context: conn.ctx })
        sub.passUntil = Date.now() + revalidateMs
      } catch {
        return sendReset(conn, sub, 'revoked')
      }
    }
    const urlScoped = sub.entry.scopes.length > 0
    const scoped = urlScoped || sub.entry.hasScopeBy
    const changeRecords: any[] = []
    const signals: BusCommitEvent[] = []
    for (const event of events) {
      if (event.op !== 'update') continue       // membership lane handles below
      if (urlScoped && event.record !== undefined) {
        // Tenant-lane events were routed by the emitter from the record's
        // OWN scope columns (the emitter strips records it cannot place, so
        // a record here is a tenant-lane fact) — already this tenant's.
        changeRecords.push(event.record)
        continue
      }
      if (scoped) {
        // scopeBy events (record or not) and a scoped door's door-wide
        // ids-only events: per-pk dry-run before ANYTHING reaches the
        // socket. A multi-process deployment makes every remote event
        // record-less, so this gate is the tenant boundary, not a fallback.
        if (!(await pkPassCheck(conn, sub, event.pk, now))) continue
      }
      if (event.record !== undefined) changeRecords.push(event.record)
      else signals.push(event)
    }
    if (changeRecords.length > 0) {
      const slice = buildChangeSliceBytes(sub.entry, changeRecords)
      sendChange(conn, sub, slice.bytes, slice.tokens)
    }
    for (const s of signals) {
      // Ids-only value events (bulk paths / cross-process) — the rumor lane.
      sendRaw(conn, encodeFrame({
        type: FrameType.SIGNAL, subId: sub.subId, epoch: sub.epoch,
        body: { table: s.table, pk: s.pk, token: s.token, op: s.op },
      }))
    }
    // The per-pk pass cache must not grow with table churn for the life of
    // a long subscription: prune expired entries once it gets large.
    if (sub.pkPass.size > 512) {
      for (const [pk, until] of sub.pkPass) if (until <= now) sub.pkPass.delete(pk)
    }
    if (membership) {
      // The tag SIGNAL: the client invalidates the door's list family only
      // when tag > known; a false alarm hits the structure-token guard and
      // costs nothing.
      try {
        const tag = await currentMembershipTag(sub.entry.doorId, sub.entry.tableName)
        sendRaw(conn, encodeFrame({
          type: FrameType.SIGNAL, subId: sub.subId, epoch: sub.epoch, body: { tag },
        }))
      } catch { /* unmigrated transport tables — reads degrade by omission */ }
    }
  }

  // ── Frame dispatch (client → server) ──────────────────────────────────────
  async function handleFrame(conn: Conn, bytes: Uint8Array): Promise<void> {
    let frame
    try { frame = decodeFrame(bytes) } catch { return }
    switch (frame.type) {
      case FrameType.SUB: return handleSub(conn, frame.body as any)
      case FrameType.UNSUB: {
        const sub = conn.subs.get(frame.subId)
        if (sub) { teardownSub(sub); conn.subs.delete(frame.subId) }
        return
      }
      case FrameType.PING:
        // App-level liveness for browser clients (they cannot see ws pings).
        sendRaw(conn, encodeFrame({ type: FrameType.PONG, body: frame.body }))
        return
      case FrameType.PONG: return
      case FrameType.REAUTH: return handleReauth(conn, frame.body as any)
      default: return                            // server never accepts data frames
    }
  }

  /** SUB token bucket: capacity maxSubsPerConnection (a reconnect re-SUBs
   *  everything at once and must pass), refilling at SUB_REFILL_PER_SECOND. */
  function takeSubToken(conn: Conn): boolean {
    const now = Date.now()
    const elapsed = (now - conn.subTokensAt) / 1000
    conn.subTokens = Math.min(cfg.maxSubsPerConnection,
      conn.subTokens + elapsed * SUB_REFILL_PER_SECOND)
    conn.subTokensAt = now
    if (conn.subTokens < 1) return false
    conn.subTokens -= 1
    return true
  }

  function ackError(conn: Conn, ref: unknown, code: string, message: string): void {
    sendRaw(conn, encodeFrame({
      type: FrameType.SUB_ACK, body: { ref, ok: false, code, message },
    }))
  }

  async function handleSub(conn: Conn, body: {
    ref?: unknown; door?: string; id?: string | number
    params?: Record<string, any>; cursor?: number; projId?: string
  }): Promise<void> {
    const { ref, door, id } = body
    // ── Resource caps BEFORE the dry-run (every dry-run is a DB query) ──────
    if (conn.subs.size >= cfg.maxSubsPerConnection) {
      return ackError(conn, ref, 'SUB_LIMIT',
        `this connection holds ${conn.subs.size} subscriptions — the per-connection cap ` +
        `(channels.maxSubsPerConnection, default 256). UNSUB what you no longer render, or raise the cap.`)
    }
    if (!takeSubToken(conn)) {
      return ackError(conn, ref, 'RATE_LIMITED',
        `SUB rate exceeded — the burst budget equals channels.maxSubsPerConnection and refills at ` +
        `${SUB_REFILL_PER_SECOND}/s (every SUB dry-runs a real door query). Space out subscriptions.`)
    }
    if (typeof door !== 'string') return ackError(conn, ref, 'BAD_CHANNEL', 'SUB body needs a door path')
    const entry = columnarDoorFor(door)
    const router = routers.get(door)
    if (!entry || !router) {
      return ackError(conn, ref, 'BAD_CHANNEL',
        `no columnar door at '${door}' — channels exist only for wire:'columnar' doors built into this gateway`)
    }
    const params = body.params ?? {}
    const kind: Sub['kind'] = id === undefined ? 'index' : 'record'

    // ── The dry-run: the door's OWN procedures, this connection's ctx ───────
    let ackCursor: number | undefined
    let gone: { d: number } | null = null
    let staleEnvelope: any = null
    try {
      if (kind === 'record') {
        if (typeof body.cursor === 'number' && typeof body.projId === 'string') {
          // SUB dry-run IS the WS3 three-way validation.
          const res: any = await call(router['validate'],
            { id, projId: body.projId, ifNoneMatch: body.cursor, ...params } as any,
            { context: conn.ctx })
          if (res.status === 'fresh') ackCursor = res.v
          else if (res.status === 'gone') gone = { d: res.d }
          else { staleEnvelope = res.envelope }
        } else {
          staleEnvelope = await call(router['get'], { id, ...params } as any, { context: conn.ctx })
        }
        if (staleEnvelope) {
          const root = staleEnvelope?.entities?.[entry.tableName]
          const tok = root?.v?.[0]
          if (typeof tok === 'number') ackCursor = tok
        }
      } else {
        const env: any = await call(router['index'], { ...params, perPage: 1 } as any, { context: conn.ctx })
        const tag = env?.membership?.tag
        if (typeof tag === 'number') ackCursor = tag
      }
    } catch (err: any) {
      const code = err?.code ?? err?.status ?? 'ERROR'
      return ackError(conn, ref, String(code), String(err?.message ?? 'subscription refused'))
    }

    // ── Intern the sub, open its bus lanes, ack ─────────────────────────────
    const subId = ++conn.nextSubId
    const sub: Sub = {
      subId, epoch: 1, kind, entry, router,
      params, unsubs: [],
      passUntil: Date.now() + revalidateMs,
      pkPass: new Map(),
      pendingByPk: new Map(),
      pendingMembership: false,
      flushTimer: null,
    }
    if (kind === 'record' && id !== undefined) sub.pk = id
    conn.subs.set(subId, sub)
    const listener = (_channel: string, event: BusCommitEvent) => {
      if (!conn.subs.has(subId)) return
      if (kind === 'record' && String(event.pk) !== String(id)) return
      enqueue(conn, sub, event)
    }
    if (kind === 'record') {
      sub.unsubs.push(bus.subscribe(recordChannel(door, id!), listener))
    } else {
      for (const ch of indexChannelsFor(entry, params)) sub.unsubs.push(bus.subscribe(ch, listener))
    }

    const ack: Record<string, unknown> = { ref, ok: true, door }
    if (id !== undefined) ack['id'] = id
    if (ackCursor !== undefined) ack['cursor'] = ackCursor
    if (gone) { ack['gone'] = true; ack['d'] = gone.d }
    sendRaw(conn, encodeFrame({ type: FrameType.SUB_ACK, subId, epoch: sub.epoch, body: ack }))
    if (staleEnvelope) {
      // The stale dirty slice rides immediately after the ack — the client
      // starts synchronized in one round trip.
      const slice = sliceBytesFromEnvelope(staleEnvelope)
      const root = staleEnvelope?.entities?.[entry.tableName]
      const tokens = root && root.r?.[0]?.[0] != null && typeof root.v?.[0] === 'number'
        ? [{ pk: root.r[0][0], token: root.v[0], op: 'update' }]
        : []
      sendChange(conn, sub, slice, tokens)
    }
  }

  async function handleReauth(conn: Conn, body: { ref?: unknown; token?: string }): Promise<void> {
    const consumed = consumeToken(typeof body.token === 'string' ? body.token : null)
    if (!consumed.ok) {
      sendRaw(conn, encodeFrame({ type: FrameType.REAUTH, body: { ref: body.ref, ok: false } }))
      return
    }
    conn.ctx = consumed.ctx
    // Every sub re-checks under the new ctx; failures RESET per sub.
    for (const sub of [...conn.subs.values()]) {
      try {
        if (sub.kind === 'record') {
          await call(sub.router['get'], { id: sub.pk, ...sub.params } as any, { context: conn.ctx })
        } else {
          await call(sub.router['index'], { ...sub.params, perPage: 1 } as any, { context: conn.ctx })
        }
        sub.passUntil = Date.now() + revalidateMs
        sub.pkPass.clear()
      } catch {
        sendReset(conn, sub, 'reauth')
      }
    }
    sendRaw(conn, encodeFrame({ type: FrameType.REAUTH, body: { ref: body.ref, ok: true } }))
  }

  // ── Handle ────────────────────────────────────────────────────────────────
  return {
    mintToken,
    path: cfg.path,
    bus,
    connectionCount: () => conns.size,
    async close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade)
      stopEmitter()
      for (const conn of conns) {
        for (const sub of conn.subs.values()) teardownSub(sub)
        try { conn.ws.close(1001, 'server draining') } catch { /* gone */ }
      }
      conns.clear()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await bus.close()
    },
  }
}
