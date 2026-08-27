/**
 * The channel bus — transport WS4, tiers 0/1 (+ typed stubs for 2/3).
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
 */
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

interface WireEvent { c: string; t: string; pk: string | number; k: number; o: CommitOp; ch: string[]; m?: 1 }

export class PgNotifyBus implements ChannelBus {
  private subs = new SubscriptionTable()
  private client: any = null
  private pending: WireEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly originId = Math.random().toString(36).slice(2)
  private readonly opts: Required<PgNotifyBusOptions>
  private closed = false

  constructor(opts: PgNotifyBusOptions) {
    this.opts = { batchMs: 10, probeTimeoutMs: 5_000, ...opts }
  }

  /** Connect the dedicated session, LISTEN, and run the PgBouncer probe. */
  async start(): Promise<void> {
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
    let parsed: { o: string; e: WireEvent[] }
    try { parsed = JSON.parse(payload) } catch { return }
    if (parsed?.o === this.originId) return      // self-published — delivered locally already
    for (const e of parsed?.e ?? []) {
      const event: BusCommitEvent = { table: e.t, pk: e.pk, token: e.k, op: e.o, changedKeys: e.ch }
      if (e.m === 1) event.membershipHint = true
      this.subs.dispatch(e.c, event)
    }
  }

  publish(channel: string, event: BusCommitEvent): void {
    // Local delivery first — same-process subscribers keep the tier-0
    // short-circuit (record instance intact); the wire carries ids only.
    this.subs.dispatch(channel, event)
    const wire: WireEvent = {
      c: channel, t: event.table, pk: event.pk, k: event.token,
      o: event.op, ch: event.changedKeys,
    }
    if (event.membershipHint) wire.m = 1
    this.pending.push(wire)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush() }, this.opts.batchMs)
      this.flushTimer.unref?.()
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null
    if (!this.client || this.pending.length === 0) return
    const events = this.pending
    this.pending = []
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
          [JSON.stringify({ o: this.originId, e: chunk })],
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

// ── Tiers 2/3: typed stubs (teaching constructors) ──────────────────────────

export class RedisBus implements ChannelBus {
  constructor() {
    throw new Error(
      `[active-drizzle] channels bus 'redis' (tier 2) is not implemented yet — the interface is ` +
      `frozen by DESIGN-transport-work WS4 (publish/subscribe of ids-only commit events; epochs ` +
      `never ride the bus). Use bus: 'memory' (single process) or 'pg-notify' (multi-process ` +
      `fallback) today, or implement ChannelBus over your Redis client and pass it to ` +
      `attachChannels({ bus }).`,
    )
  }
  publish(): void { /* unreachable */ }
  subscribe(): () => void { return () => {} }
  close(): void { /* unreachable */ }
}

export class NatsBus implements ChannelBus {
  constructor() {
    throw new Error(
      `[active-drizzle] channels bus 'nats' (tier 3) is not implemented yet — the interface is ` +
      `frozen by DESIGN-transport-work WS4 (publish/subscribe of ids-only commit events; epochs ` +
      `never ride the bus). Use bus: 'memory' (single process) or 'pg-notify' (multi-process ` +
      `fallback) today, or implement ChannelBus over your NATS client and pass it to ` +
      `attachChannels({ bus }).`,
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
}

/**
 * Build (and for pg-notify, START) the configured bus tier. The returned
 * promise resolves once the bus is usable — pg-notify's probe included.
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
    case 'redis': return new RedisBus()
    case 'nats': return new NatsBus()
  }
}
