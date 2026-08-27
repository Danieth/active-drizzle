/**
 * The channel bus — transport WS4, tiers 0/1/2 (+ a typed stub for 3).
 *
 * ONE publish/subscribe interface carrying COMMIT EVENTS — ids-only facts
 * (table, pk, token, op, changed keys), NEVER serialized frame slices:
 *
 *   (a) the epoch (O16) is per-connection subscription state stamped at
 *       socket-write time by the serving node — it CANNOT ride the bus, so
 *       neither can anything epoch-stamped;
 *   (b) Postgres NOTIFY's ~8000-byte payload cap forces ids-only anyway —
 *       so ONE payload shape serves every tier.
 *
 * Delivery is BEST-EFFORT by doctrine (no outbox): C1 — push is prepaid
 * pull — makes a lost event harmless (the client's revalidation pull heals).
 *
 * Tier 0, MemoryBus (default): same-process. Its events may carry the live
 * `record` instance — the short-circuit that lets the serving side build a
 * CHANGE slice with no reload. `record` NEVER crosses a process boundary.
 *
 * Tier 1, PgNotifyBus ('pg-notify'): the OPT-IN fallback, never a default
 * (landmine 9). Operational facts, recorded where the pain will start:
 *   - NOTIFY serializes commits through a GLOBAL lock in PreCommit_Notify.
 *     The overload symptom in pg logs / pg_locks is waits on
 *     `class 1262 … database 0` (the database-object lock NOTIFY takes on
 *     database id 0) — if you see those, this tier is saturated; move to
 *     the redis/nats tier.
 *   - LISTEN requires a SESSION-mode connection. This adapter creates its
 *     own DEDICATED `pg` client directly from the url it is given — never
 *     the app pool. Pointing it at PgBouncer in transaction-pooling mode
 *     silently swallows notifications, which is why start() runs a
 *     self-NOTIFY round-trip probe and refuses with a teaching error when
 *     its own listener hears nothing (pool_mode is not queryable from an
 *     ordinary connection — the probe is the only honest detector).
 *   - Payloads are BATCHED (a small window packs many events into one
 *     NOTIFY) and CHUNKED under 7.5KB (UTF-8 bytes) to stay clear of the
 *     8000B cap; a single event over the cap is dropped from the WIRE with
 *     a loud log (local delivery already happened — C1 heals remotely).
 *   - A dropped LISTEN session (PG restart, idle kill, network blip)
 *     RECONNECTS with backoff and re-LISTENs — without it this node would
 *     go permanently deaf to remote commits while its own sockets stay
 *     heartbeat-healthy. The boot probe does NOT re-run on reconnect (the
 *     topology already proved itself; a blip must not become a fatal
 *     misconfiguration claim).
 *
 * Tier 2, RedisBus ('redis'): THE multi-process tier — no global commit
 * lock, no 8000B cap, no pooler landmine. Plain pub/sub (at-most-once),
 * deliberately NOT Redis Streams: C1 already makes the client's
 * revalidation pull the replay mechanism, so a Stream's persistence and
 * consumer groups would buy nothing and cost trimming policy, group
 * bookkeeping, and pending-entry babysitting. Loss during a reconnect gap
 * is the same non-event it is on pg-notify: logged loudly, healed by pull,
 * NEVER surfaced as a subscription RESET (RESET is the gateway's
 * revocation signal, not a transport signal).
 */
import { createHash, randomUUID } from 'node:crypto'
import type { CommitOp } from '@active-drizzle/core'

// ── Event + interface ───────────────────────────────────────────────────────

export interface BusCommitEvent {
  table: string
  pk: string | number
  token: number
  op: CommitOp
  changedKeys: string[]
  /** Tier-0 short-circuit ONLY — never serialized across processes. */
  record?: any
  /** A value write that moved membership (a scope-column re-tenanting) —
   *  index subs must re-read the door tag even though op is 'update'. */
  membershipHint?: boolean
}

export type BusListener = (channel: string, event: BusCommitEvent) => void

export interface ChannelBus {
  /** Fire-and-forget publish of one commit event to one channel key. */
  publish(channel: string, event: BusCommitEvent): void
  /**
   * Subscribe to a channel key. A key ending in '*' subscribes to the
   * PREFIX before it (the gateway itself subscribes only EXACT keys today —
   * prefix subscription exists for tooling, tests, and custom-bus
   * consumers). Returns unsubscribe.
   */
  subscribe(channel: string, cb: BusListener): () => void
  close(): void | Promise<void>
}

// ── Shared subscription bookkeeping ─────────────────────────────────────────

class SubscriptionTable {
  private exact = new Map<string, Set<BusListener>>()
  private prefixes = new Map<string, Set<BusListener>>()

  add(channel: string, cb: BusListener): () => void {
    const isPrefix = channel.endsWith('*')
    const key = isPrefix ? channel.slice(0, -1) : channel
    const map = isPrefix ? this.prefixes : this.exact
    let set = map.get(key)
    if (!set) { set = new Set(); map.set(key, set) }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) map.delete(key)
    }
  }

  dispatch(channel: string, event: BusCommitEvent): void {
    for (const cb of this.exact.get(channel) ?? []) safeCall(cb, channel, event)
    for (const [prefix, set] of this.prefixes) {
      if (channel.startsWith(prefix)) for (const cb of set) safeCall(cb, channel, event)
    }
  }

  clear(): void {
    this.exact.clear()
    this.prefixes.clear()
  }
}

function safeCall(cb: BusListener, channel: string, event: BusCommitEvent): void {
  try { cb(channel, event) } catch (err) {
    // Best-effort: a broken subscriber must not sever the bus for the rest.
    // eslint-disable-next-line no-console
    console.error('[active-drizzle] channel bus subscriber threw:', err)
  }
}

/**
 * Loud but bounded drop accounting. The loss itself is doctrine (C1 — pull
 * is correctness), and silence would hide an outage; but with a ~10ms batch
 * window under sustained write load, one line per flush would emit ~100
 * error lines/second — a log storm that buries the signal during the exact
 * incident it reports. So: the FIRST drop logs immediately, further drops
 * fold into a counted summary at most once per window.
 */
class DropLog {
  private count = 0
  private lastAt = 0
  constructor(private readonly windowMs = 5_000) {}
  record(n: number, message: (total: number) => string): void {
    this.count += n
    const now = Date.now()
    if (now - this.lastAt < this.windowMs) return
    // eslint-disable-next-line no-console
    console.error(message(this.count))
    this.count = 0
    this.lastAt = now
  }
}

// ── Tier 0: in-memory ───────────────────────────────────────────────────────

export class MemoryBus implements ChannelBus {
  private subs = new SubscriptionTable()

  publish(channel: string, event: BusCommitEvent): void {
    this.subs.dispatch(channel, event)
  }

  subscribe(channel: string, cb: BusListener): () => void {
    return this.subs.add(channel, cb)
  }

  close(): void {
    this.subs.clear()
  }
}

// ── The ONE wire shape (shared by every cross-process tier) ─────────────────

/** Compact wire form of one commit event + its channel key. The payload law
 *  (WS4): ids only, epochs never, record instances never. */
interface WireEvent { c: string; t: string; pk: string | number; k: number; o: CommitOp; ch: string[]; m?: 1 }

function toWireEvent(channel: string, event: BusCommitEvent): WireEvent {
  const wire: WireEvent = {
    c: channel, t: event.table, pk: event.pk, k: event.token,
    o: event.op, ch: event.changedKeys,
  }
  if (event.membershipHint) wire.m = 1
  return wire
}

/** One batch = one wire payload: `{ o: originId, e: WireEvent[] }`. */
function encodeWireBatch(originId: string, events: WireEvent[]): string {
  return JSON.stringify({ o: originId, e: events })
}

/** One well-shaped wire event or null — never a throw. The dispatch path
 *  hangs off an EventEmitter data event ('message' on ioredis,
 *  'notification' on pg), where an escaped throw becomes an
 *  uncaughtException and kills the whole server. */
function decodeWireEvent(e: any): BusCommitEvent | null {
  if (
    e === null || typeof e !== 'object'
    || typeof e.c !== 'string' || typeof e.t !== 'string'
    || (typeof e.pk !== 'string' && typeof e.pk !== 'number')
    || typeof e.k !== 'number' || typeof e.o !== 'string'
    || !Array.isArray(e.ch) || !e.ch.every((k: unknown) => typeof k === 'string')
  ) return null
  const event: BusCommitEvent = { table: e.t, pk: e.pk, token: e.k, op: e.o, changedKeys: e.ch }
  if (e.m === 1) event.membershipHint = true
  return event
}

/**
 * Decode one wire batch and dispatch it locally. Self-published batches
 * (same originId) are skipped — local delivery already happened at publish
 * time, record short-circuit intact. Malformed payloads — undecodable OR
 * parseable-but-misshapen — are skipped LOUDLY, per event: the bus is
 * best-effort rumor (C1 — pull is correctness), but a foreign writer on
 * the broadcast channel, or an old node hearing a future wire shape during
 * a rolling deploy, must neither crash the node nor vanish silently.
 */
function dispatchWireBatch(payload: string, selfOriginId: string, subs: SubscriptionTable): void {
  let parsed: any
  try { parsed = JSON.parse(payload) } catch {
    // eslint-disable-next-line no-console
    console.error(
      `[active-drizzle] channel bus: undecodable wire payload skipped (a foreign writer on the ` +
      `broadcast channel?): ${payload.slice(0, 120)}`,
    )
    return
  }
  if (parsed?.o === selfOriginId) return       // self-published — delivered locally already
  if (!Array.isArray(parsed?.e)) {
    // eslint-disable-next-line no-console
    console.error(
      `[active-drizzle] channel bus: wire batch without an events array skipped (a foreign ` +
      `writer on the broadcast channel?): ${payload.slice(0, 120)}`,
    )
    return
  }
  for (const e of parsed.e as unknown[]) {
    try {
      const event = decodeWireEvent(e)
      if (!event) {
        // eslint-disable-next-line no-console
        console.error(
          `[active-drizzle] channel bus: malformed wire event skipped (foreign writer, or a ` +
          `newer wire shape mid-rolling-deploy?): ${JSON.stringify(e)?.slice(0, 120)}`,
        )
        continue
      }
      subs.dispatch((e as any).c, event)
    } catch (err) {
      // Belt over the braces above: nothing riding an EventEmitter data
      // path may throw — the rest of the batch still delivers.
      // eslint-disable-next-line no-console
      console.error('[active-drizzle] channel bus: wire event dispatch failed (skipped):', err)
    }
  }
}

// ── Tier 1: Postgres NOTIFY ─────────────────────────────────────────────────

const NOTIFY_CHANNEL = 'adrz_cable'
const PROBE_PREFIX = '__adrz_probe__'
/** Hard NOTIFY payload cap is ~8000 bytes; chunk with headroom. */
const CHUNK_BYTES = 7_500

export interface PgNotifyBusOptions {
  /** Direct Postgres url — a SESSION-mode connection this adapter owns.
   *  NEVER the app pool, NEVER PgBouncer in transaction mode. */
  databaseUrl: string
  /** Publish batching window, ms (default 10). */
  batchMs?: number
  /** Self-NOTIFY probe timeout, ms (default 5000). */
  probeTimeoutMs?: number
}

export function pgBouncerTeachingError(): Error {
  return new Error(
    `[active-drizzle] channels bus 'pg-notify': the boot self-NOTIFY probe heard nothing — this ` +
    `connection cannot LISTEN. The usual cause is PgBouncer (or another pooler) in TRANSACTION ` +
    `pooling mode: LISTEN registers on the server session, but transaction pooling hands every ` +
    `statement a different session, so notifications are delivered to a session nobody holds — ` +
    `silently. pool_mode is not queryable from an ordinary connection, which is why this probe ` +
    `exists. Point channels at a DIRECT database url (or a session-mode pool): ` +
    `channels: { bus: 'pg-notify' } uses the database.url — give it the direct one.`,
  )
}

export class PgNotifyBus implements ChannelBus {
  private subs = new SubscriptionTable()
  private client: any = null
  private pending: WireEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** crypto-random and fixed-length: a Math.random collision between two
   *  server processes would make each permanently discard the other's
   *  batches via the self-origin dedupe — silent partial deafness that
   *  pull-healing masks into "realtime feels laggy between these pods". */
  private readonly originId = randomUUID()
  private readonly opts: Required<PgNotifyBusOptions>
  private closed = false
  private readonly dropLog = new DropLog()

  constructor(opts: PgNotifyBusOptions) {
    this.opts = { batchMs: 10, probeTimeoutMs: 5_000, ...opts }
  }

  /** Connect the dedicated session, LISTEN, and run the PgBouncer probe. */
  async start(): Promise<void> {
    if (this.client) {
      throw new Error(
        `[active-drizzle] PgNotifyBus.start() called twice — the dedicated LISTEN session ` +
        `already exists. close() this bus (or construct a new one) instead: a second start() ` +
        `would orphan a live session with no handle left to end it.`,
      )
    }
    this.closed = false
    await this.connectSession()

    // The PgBouncer-transaction-mode probe: our own listener must hear us.
    // Boot-only — a mid-life reconnect re-joins the SAME topology and must
    // not turn a transient network blip into a fatal misconfiguration claim.
    const nonce = `${PROBE_PREFIX}${this.originId}:${Date.now()}`
    let heard!: () => void
    const heardPromise = new Promise<void>(resolve => { heard = resolve })
    this.probeWaiters.set(nonce, heard)
    await this.client.query(`SELECT pg_notify('${NOTIFY_CHANNEL}', $1)`, [nonce])
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(pgBouncerTeachingError()), this.opts.probeTimeoutMs).unref?.())
    try {
      await Promise.race([heardPromise, timeout])
    } finally {
      this.probeWaiters.delete(nonce)
    }
  }

  /** Dial the dedicated session and LISTEN. Shared by boot and reconnect. */
  private async connectSession(): Promise<void> {
    const { Client } = await importPg()
    const client = new Client({ connectionString: this.opts.databaseUrl })
    this.client = client
    await client.connect()
    client.on('notification', (msg: { channel: string; payload?: string }) => {
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return
      this.receive(msg.payload)
    })
    // A dropped LISTEN session would otherwise leave this node permanently
    // deaf to remote commits while its own sockets stay heartbeat-healthy —
    // C1 heals lost EVENTS via pull, not a severed bus. Reconnect with
    // backoff and re-LISTEN.
    client.on('error', (err: unknown) => {
      if (this.closed) return
      // eslint-disable-next-line no-console
      console.error('[active-drizzle] pg-notify bus connection error (reconnecting):', err)
      this.scheduleReconnect(client)
    })
    client.on('end', () => {
      if (this.closed) return
      // eslint-disable-next-line no-console
      console.error('[active-drizzle] pg-notify bus LISTEN session ended (reconnecting)')
      this.scheduleReconnect(client)
    })
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`)
    this.reconnectAttempts = 0
  }

  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleReconnect(deadClient: any): void {
    if (this.closed || this.reconnectTimer) return
    if (deadClient !== null && this.client !== null && this.client !== deadClient) {
      return                                              // a replaced client's death rattle
    }
    if (this.client === deadClient) this.client = null    // stop publishing into a corpse
    try { void deadClient?.end?.().catch?.(() => {}) } catch { /* already gone */ }
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connectSession().catch((err: unknown) => {
        if (this.closed) return
        // eslint-disable-next-line no-console
        console.error('[active-drizzle] pg-notify bus reconnect failed (retrying):', err)
        this.scheduleReconnect(this.client)
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private probeWaiters = new Map<string, () => void>()

  private receive(payload: string): void {
    if (payload.startsWith(PROBE_PREFIX)) {
      this.probeWaiters.get(payload)?.()
      return
    }
    dispatchWireBatch(payload, this.originId, this.subs)
  }

  publish(channel: string, event: BusCommitEvent): void {
    // Local delivery first — same-process subscribers keep the tier-0
    // short-circuit (record instance intact); the wire carries ids only.
    this.subs.dispatch(channel, event)
    this.pending.push(toWireEvent(channel, event))
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush() }, this.opts.batchMs)
      this.flushTimer.unref?.()
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null
    if (this.pending.length === 0) return
    const events = this.pending
    this.pending = []
    if (!this.client) {
      // The reconnect gap — THE cross-process gap convention (both tiers):
      // the wire copy is DROPPED loudly, never queued — an unbounded
      // offline queue would trade bounded loss (healed by pull, C1) for
      // unbounded memory over the outage, then ship stale on reconnect.
      // Local delivery already happened at publish time.
      if (!this.closed) this.dropLog.record(events.length, total =>
        `[active-drizzle] pg-notify bus LISTEN session down — ${total} event(s) not relayed ` +
        `cross-process (local delivery done; remote nodes heal via revalidation pulls)`)
      return
    }
    // Chunk under the NOTIFY payload cap. Greedy: pack events until the
    // serialized chunk would exceed CHUNK_BYTES, then start a new one.
    // Sizes are UTF-8 BYTES (Buffer.byteLength) — the cap is a byte cap,
    // and multibyte channel keys / column names are legal.
    const chunks: WireEvent[][] = []
    let current: WireEvent[] = []
    let size = 0
    for (const e of events) {
      const len = Buffer.byteLength(JSON.stringify(e), 'utf8') + 1
      if (len > CHUNK_BYTES) {
        // A single event that alone exceeds the NOTIFY cap cannot be split
        // and would only bounce off pg_notify. Drop its WIRE copy loudly
        // (local delivery already happened; remote nodes heal via pull —
        // C1) instead of shipping a chunk we know Postgres refuses.
        // eslint-disable-next-line no-console
        console.error(
          `[active-drizzle] pg-notify: one commit event serializes to ${len}B — over the ~8000B ` +
          `NOTIFY payload cap — and was not relayed cross-process (local delivery done; remote ` +
          `nodes heal via revalidation pulls). Usual cause: an enormous changedKeys set.`,
        )
        continue
      }
      if (current.length > 0 && size + len > CHUNK_BYTES) {
        chunks.push(current)
        current = []
        size = 0
      }
      current.push(e)
      size += len
    }
    if (current.length > 0) chunks.push(current)
    for (const chunk of chunks) {
      try {
        await this.client.query(
          `SELECT pg_notify('${NOTIFY_CHANNEL}', $1)`,
          [encodeWireBatch(this.originId, chunk)],
        )
      } catch (err) {
        // Best-effort (C1): local subscribers were already served; remote
        // nodes heal via revalidation pulls.
        // eslint-disable-next-line no-console
        if (!this.closed) console.error('[active-drizzle] pg-notify publish failed:', err)
      }
    }
  }

  subscribe(channel: string, cb: BusListener): () => void {
    return this.subs.add(channel, cb)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.subs.clear()
    if (this.client) {
      try { await this.client.end() } catch { /* already gone */ }
      this.client = null
    }
  }
}

async function importPg(): Promise<any> {
  try {
    return await import('pg' as string)
  } catch {
    throw new Error(
      `[active-drizzle] channels bus 'pg-notify' needs the 'pg' driver (a dedicated session-mode ` +
      `connection is created directly — never through the app pool). npm install pg.`,
    )
  }
}

// ── Tier 2: Redis pub/sub ───────────────────────────────────────────────────

/** One broadcast Redis channel; SubscriptionTable routes locally — exactly
 *  the pg-notify topology, so prefix subs need no PSUBSCRIBE machinery. */
const REDIS_CHANNEL = 'adrz_cable'

/**
 * The deployment discriminator suffixed onto the broadcast channel.
 *
 * On pg-notify the bare channel name is safe because LISTEN/NOTIFY is
 * scoped per Postgres DATABASE — staging and prod on different databases
 * are isolated for free. Redis pub/sub is INSTANCE-wide (the db index in
 * the url does not partition it), so two deployments sharing one Redis
 * (staging + prod on one ElastiCache, or two apps) would cross-deliver
 * batches: originId dedupe only filters SELF, and channel keys collide
 * across environments of the same app (`rec:/loans:7` is `rec:/loans:7`
 * everywhere) — every foreign commit would then drive dry-run queries and
 * reload-through-door work on the wrong deployment, a write-rate-coupled
 * load amplifier between environments.
 *
 * So the namespace defaults to a hash of the DATABASE url's host+port+
 * dbname (same data ⇒ same channel; different database ⇒ isolated —
 * recovering exactly the isolation pg-notify gets for free). Credentials
 * and query params are deliberately EXCLUDED: two processes reaching the
 * same database through different users must still share a channel.
 */
export function redisNamespaceFor(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined
  try {
    const u = new URL(databaseUrl)
    const identity = `${u.hostname}:${u.port || '5432'}${u.pathname}`
    return createHash('sha256').update(identity).digest('hex').slice(0, 12)
  } catch {
    return undefined
  }
}

export interface RedisBusOptions {
  /** redis:// or rediss:// url — TLS, auth, and db index all ride the url.
   *  TWO dedicated connections are dialed from it: Redis command-restricts
   *  a subscribing connection, so publisher and subscriber cannot share. */
  redisUrl: string
  /** Deployment discriminator: the broadcast channel becomes
   *  `adrz_cable:<namespace>`. Pub/sub is instance-wide, so deployments
   *  sharing one Redis MUST NOT share a channel — createBus derives this
   *  from database.url (see redisNamespaceFor); set it explicitly when
   *  constructing a RedisBus by hand for a shared instance. */
  namespace?: string | undefined
  /** Publish batching window, ms (default 10). */
  batchMs?: number
  /** Boot loopback-probe timeout, ms (default 5000). */
  probeTimeoutMs?: number
}

export function redisProbeTeachingError(timeoutMs: number): Error {
  return new Error(
    `[active-drizzle] channels bus 'redis': the boot loopback probe published to itself and heard ` +
    `nothing within ${timeoutMs}ms. Either the server at channels.redisUrl is unreachable (its ` +
    `connection errors were logged above), or it accepts commands but does not deliver pub/sub — ` +
    `seen with Redis-compatible proxies and serverless providers that do not support SUBSCRIBE, ` +
    `and with load balancers that route the two connections to DIFFERENT isolated instances. ` +
    `Point redisUrl at one real Redis. (Pub/sub is instance-wide — the db index in the url does ` +
    `not partition it; in cluster mode a PUBLISH reaches subscribers on any node.)`,
  )
}

/**
 * THE multi-process tier. Plain pub/sub — at-most-once, no replay — is the
 * DESIGNED contract, not a compromise: C1 (push is prepaid pull) makes the
 * client's revalidation pull the replay mechanism, so Redis Streams would
 * add trimming policy and consumer-group bookkeeping to deliver a guarantee
 * nothing needs. Reconnects (both connections) are ioredis' built-in
 * backoff, capped to the house 30s; the subscriber connection re-SUBSCRIBEs
 * itself on reconnect. Events published during a gap are lost the same way
 * a pg-notify reconnect loses them: logged loudly, healed by pull, NEVER
 * surfaced as a subscription RESET — RESET is the gateway's revocation
 * signal (a failed door re-check), never a transport signal.
 */
export class RedisBus implements ChannelBus {
  private subs = new SubscriptionTable()
  private pub: any = null
  private sub: any = null
  private pending: WireEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** crypto-random and fixed-length — see PgNotifyBus.originId. */
  private readonly originId = randomUUID()
  private readonly opts: Required<Omit<RedisBusOptions, 'namespace'>>
  /** The namespaced broadcast channel (see redisNamespaceFor). */
  private readonly channel: string
  private closed = false
  private probeWaiters = new Map<string, () => void>()
  private readonly dropLog = new DropLog()

  constructor(opts: RedisBusOptions) {
    const { namespace, ...rest } = opts
    this.opts = { batchMs: 10, probeTimeoutMs: 5_000, ...rest }
    this.channel = namespace ? `${REDIS_CHANNEL}:${namespace}` : REDIS_CHANNEL
  }

  /** Dial the connection pair, SUBSCRIBE, and run the loopback probe.
   *  Boot-only probe — a mid-life reconnect re-joins the SAME topology and
   *  must not turn a blip into a fatal misconfiguration claim. */
  async start(): Promise<void> {
    if (this.pub || this.sub) {
      throw new Error(
        `[active-drizzle] RedisBus.start() called twice — the connection pair already exists. ` +
        `close() this bus (or construct a new one) instead: a second start() would orphan a ` +
        `live, forever-reconnecting pair with no handle left to disconnect it.`,
      )
    }
    this.closed = false            // a bus closed after a failed boot may start again
    const Redis = await importIORedis()
    // House backoff (1s doubling, 30s cap) as ioredis' retryStrategy — the
    // client owns reconnection AND re-SUBSCRIBE, so unlike pg-notify there
    // is no hand-rolled reconnect loop to maintain here.
    const retryStrategy = (times: number) => Math.min(30_000, 1_000 * 2 ** times)
    this.pub = new Redis(this.opts.redisUrl, { retryStrategy, maxRetriesPerRequest: null })
    this.sub = new Redis(this.opts.redisUrl, { retryStrategy, maxRetriesPerRequest: null })
    for (const [role, client] of [['publisher', this.pub], ['subscriber', this.sub]] as const) {
      // Mandatory: an ioredis client with no 'error' listener throws
      // uncaught. Also our loud-log duty — a gap heals via pull, silently
      // never.
      client.on('error', (err: unknown) => {
        if (this.closed) return
        // eslint-disable-next-line no-console
        console.error(
          `[active-drizzle] redis bus ${role} connection error (reconnecting with backoff; ` +
          `events missed during the gap heal via revalidation pulls):`, err,
        )
      })
    }
    this.sub.on('message', (channel: string, payload: string) => {
      if (channel !== this.channel) return
      this.receive(payload)
    })

    const nonce = `${PROBE_PREFIX}${this.originId}:${Date.now()}`
    let heard!: () => void
    const heardPromise = new Promise<void>(resolve => { heard = resolve })
    this.probeWaiters.set(nonce, heard)
    const ready = (async () => {
      await this.sub.subscribe(this.channel)
      await this.pub.publish(this.channel, nonce)    // offline queue holds it until ready
      await heardPromise
    })()
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(redisProbeTeachingError(this.opts.probeTimeoutMs)), this.opts.probeTimeoutMs).unref?.())
    try {
      await Promise.race([ready, timeout])
    } catch (err) {
      void ready.catch(() => {})     // the loser must not become an unhandled rejection
      await this.close()             // a refused boot leaves no dialing clients behind
      throw err
    } finally {
      this.probeWaiters.delete(nonce)
    }
  }

  private receive(payload: string): void {
    if (payload.startsWith(PROBE_PREFIX)) {
      this.probeWaiters.get(payload)?.()
      return
    }
    dispatchWireBatch(payload, this.originId, this.subs)
  }

  publish(channel: string, event: BusCommitEvent): void {
    // Local delivery first — same-process subscribers keep the tier-0
    // short-circuit (record instance intact); the wire carries ids only.
    this.subs.dispatch(channel, event)
    this.pending.push(toWireEvent(channel, event))
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush() }, this.opts.batchMs)
      this.flushTimer.unref?.()
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null
    if (this.pending.length === 0) return
    const events = this.pending
    this.pending = []
    // No chunking: Redis has no NOTIFY-style payload cap worth designing
    // for (proto-max-bulk-len defaults to 512MB) — one PUBLISH per window.
    if (!this.pub || this.pub.status !== 'ready') {
      // Best-effort by doctrine (C1): during a reconnect gap the wire copy
      // is DROPPED, not queued — an unbounded offline queue would trade
      // bounded loss (healed by pull) for unbounded memory. Local delivery
      // already happened. Same convention as PgNotifyBus.flush.
      if (!this.closed) this.dropLog.record(events.length, total =>
        `[active-drizzle] redis bus publisher not connected — ${total} event(s) not ` +
        `relayed cross-process (local delivery done; remote nodes heal via revalidation pulls)`)
      return
    }
    try {
      await this.pub.publish(this.channel, encodeWireBatch(this.originId, events))
    } catch (err) {
      // eslint-disable-next-line no-console
      if (!this.closed) console.error('[active-drizzle] redis bus publish failed:', err)
    }
  }

  subscribe(channel: string, cb: BusListener): () => void {
    return this.subs.add(channel, cb)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    this.subs.clear()
    // disconnect(), not quit() — quit awaits a round-trip that may never
    // return through a dead connection; a best-effort bus tears down the
    // same way it delivers.
    try { this.sub?.disconnect() } catch { /* already gone */ }
    try { this.pub?.disconnect() } catch { /* already gone */ }
    this.sub = null
    this.pub = null
  }
}

/** ioredis over node-redis, deliberately: (a) its reconnect owns
 *  re-SUBSCRIBE — subscriptions on the dedicated subscriber connection are
 *  restored by the client itself, so a bus gap needs no hand-rolled
 *  re-subscribe loop (node-redis v4/5 re-subscribes too, but couples it to
 *  its own reconnect-strategy/offline-queue matrix); (b) retryStrategy maps
 *  1:1 onto the house backoff (1s doubling, 30s cap); (c) redis:// and
 *  rediss:// urls carry TLS, auth, and db index with zero option plumbing. */
async function importIORedis(): Promise<any> {
  try {
    const mod: any = await import('ioredis' as string)
    return mod.Redis ?? mod.default
  } catch {
    throw new Error(
      `[active-drizzle] channels bus 'redis' needs the 'ioredis' client (two dedicated ` +
      `connections are dialed — Redis command-restricts a subscribing connection, so publisher ` +
      `and subscriber cannot share one). npm install ioredis.`,
    )
  }
}

// ── Tier 3: typed stub (teaching constructor) ───────────────────────────────

export class NatsBus implements ChannelBus {
  constructor() {
    throw new Error(
      `[active-drizzle] channels bus 'nats' (tier 3) is not implemented yet — the interface is ` +
      `frozen by DESIGN-transport-work WS4 (publish/subscribe of ids-only commit events; epochs ` +
      `never ride the bus). Use bus: 'redis' (the multi-process tier), 'pg-notify' (multi-process ` +
      `fallback), or 'memory' (single process) today, or implement ChannelBus over your NATS ` +
      `client and pass it to attachChannels({ bus }).`,
    )
  }
  publish(): void { /* unreachable */ }
  subscribe(): () => void { return () => {} }
  close(): void { /* unreachable */ }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export interface CreateBusOptions {
  /** Direct database url for 'pg-notify' (usually config.database.url). */
  databaseUrl?: string
  /** Redis url for 'redis' (usually config.channels.redisUrl). */
  redisUrl?: string | undefined
}

/**
 * Build (and for the connected tiers, START) the configured bus. The
 * returned promise resolves once the bus is usable — boot probes included.
 */
export async function createBus(
  bus: 'memory' | 'pg-notify' | 'redis' | 'nats',
  opts: CreateBusOptions = {},
): Promise<ChannelBus> {
  switch (bus) {
    case 'memory': return new MemoryBus()
    case 'pg-notify': {
      if (!opts.databaseUrl) {
        throw new Error(
          `[active-drizzle] channels bus 'pg-notify' needs a database url for its DEDICATED ` +
          `session-mode connection — set database: { url } in trails.config (or pass ` +
          `databaseUrl to createBus).`,
        )
      }
      const b = new PgNotifyBus({ databaseUrl: opts.databaseUrl })
      await b.start()
      return b
    }
    case 'redis': {
      if (!opts.redisUrl) {
        throw new Error(
          `[active-drizzle] channels bus 'redis' needs a redis url for its DEDICATED connection ` +
          `pair (Redis command-restricts a subscribing connection, so publish and subscribe ` +
          `cannot share one) — set channels: { redisUrl: process.env.REDIS_URL } in trails.config ` +
          `(or pass redisUrl to createBus).`,
        )
      }
      // Namespaced per deployment off database.url (see redisNamespaceFor):
      // pub/sub is instance-wide, and deployments sharing one Redis must
      // not cross-deliver each other's commit rumors.
      const namespace = redisNamespaceFor(opts.databaseUrl)
      const b = new RedisBus({ redisUrl: opts.redisUrl, ...(namespace ? { namespace } : {}) })
      await b.start()
      return b
    }
    case 'nats': return new NatsBus()
  }
}
