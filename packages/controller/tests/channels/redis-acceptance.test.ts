/**
 * Redis-tier ACCEPTANCE — the WS4 e2e lane over the tier-2 bus: REAL PG
 * (testcontainers) → REAL routers over REAL HTTP → REAL 'ws' gateways →
 * the REAL react client store — with TWO gateways on SEPARATE RedisBus
 * instances wired through a REAL Redis container. This is the multi-process
 * topology MemoryBus cannot serve: an HTTP write through server A's process
 * converges client B's store with the commit event riding Redis pub/sub.
 *
 * THE ONE-PROCESS HONESTY TRICK: both gateways live in this node process,
 * so BOTH emitters are on core's commit tap (registerCommitPublisher is
 * process-global) — gateway B would otherwise hear A's commits locally,
 * record short-circuit intact, and the test would pass with Redis unplugged.
 * Gateway B therefore gets a bus wrapper whose publish() is a NO-OP (in a
 * real deployment B's process never sees A's commit tap at all), so the
 * ONLY input into B's subscription table is the Redis wire. Structurally,
 * convergence at B proves the redis lane or nothing.
 *
 * The pins:
 *  R1. CROSS-PROCESS CONVERGENCE, ZERO REFETCH — A mutates over its own
 *      HTTP surface; B's STORE converges via redis (B's gateway reloads
 *      through the door — remote events are record-less by the payload
 *      law); B's validator callables never fire and B's http server sees
 *      NOTHING.
 *  R2. RECONNECT GAP = the landed convention — kill every pub/sub
 *      connection server-side; a write during the outage is LOST on the
 *      wire (expected: at-most-once by design); after ioredis'
 *      auto-reconnect + auto-re-SUBSCRIBE, NEW publishes flow, and the
 *      healing frame's full-record reload carries the lost write's effect
 *      too (pull heals). No RESET is ever surfaced (RESET stays the
 *      gateway's revocation signal), and the client's ws never reconnects
 *      (a bus gap is invisible to sockets).
 *  R3. TEACHING ERROR — attachChannels with bus:'redis' and no redisUrl
 *      refuses at construction in assertChannelsServable's house style.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pgTable, serial, integer, varchar } from 'drizzle-orm/pg-core'
import WebSocket from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { RPCHandler } from '@orpc/server/node'
import {
  ApplicationRecord, boot, MODEL_REGISTRY,
  model as modelDecorator,
  registerLoggedModel, resetWriteLogRegistry, resetCommitPublishers,
  WRITE_LOG_SCHEMA_SQL,
} from '@active-drizzle/core'
import { peekHeader, FrameType } from '@active-drizzle/core/frames'
import { ActiveController, controller, crud, buildRouter, type BuildResult } from '@active-drizzle/controller'
import { resetColumnarDoorRegistry, validatableMask } from '../../src/validate-handler.js'
import { attachChannels, type ChannelsHandle } from '../../src/channels/gateway.js'
import { RedisBus, type ChannelBus, type BusListener, type BusCommitEvent } from '../../src/channels/bus.js'
import { connectChannels, type ChannelSocketLike, type ChannelTransport } from '../../../react/src/channels.js'
import { EntityStore, visibleFields } from '../../../react/src/entity-store.js'
import type { ProjectionValidator } from '../../../react/src/validation-client.js'

// ── Schema / model / door ───────────────────────────────────────────────────

const racc_loans = pgTable('racc_loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }),
  stage:       integer('stage').notNull().default(0),
  lockVersion: integer('lock_version').notNull().default(0),
})
const schema = { racc_loans }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('racc_loans')
class RaccLoan extends ApplicationRecord {}

const LOAN_CONFIG: any = {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' } },
  get: { expose: ['id', 'title', 'stage'], abilities: true },
  update: { permit: ['title', 'stage'], optimisticLock: true },
  wire: 'columnar',
}

@controller('/racc-loans')
@crud(RaccLoan as any, LOAN_CONFIG)
class RaccLoanController extends ActiveController {}

// ── The one-process honesty trick (see the file header) ─────────────────────

/** Gateway B's bus: subscription side is the REAL RedisBus; the publish
 *  side is severed because in a real multi-process deployment B's process
 *  never sees A's commit tap — registerCommitPublisher is process-global
 *  only because both "processes" share this test's node. */
class OtherProcessBus implements ChannelBus {
  constructor(private inner: RedisBus) {}
  publish(_channel: string, _event: BusCommitEvent): void { /* other process's tap — not ours */ }
  subscribe(channel: string, cb: BusListener): () => void { return this.inner.subscribe(channel, cb) }
  close(): Promise<void> { return this.inner.close() }
}

// ── Spy socket (the acceptance harness's, trimmed to what R1/R2 read) ───────

class SpySocket implements ChannelSocketLike {
  inner: WebSocket
  received: Uint8Array[] = []
  binaryType = 'arraybuffer'
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null

  constructor(url: string) {
    this.inner = new WebSocket(url)
    this.inner.binaryType = 'arraybuffer'
    this.inner.onopen = () => this.onopen?.()
    this.inner.onmessage = (ev: any) => {
      const buf = ev.data as ArrayBuffer
      this.received.push(new Uint8Array(buf.slice(0)))
      this.onmessage?.({ data: buf })
    }
    this.inner.onclose = (ev: any) => this.onclose?.({ code: ev?.code })
    this.inner.onerror = () => this.onerror?.()
  }

  get readyState(): number { return this.inner.readyState }
  set readyState(_v: number) { /* interface shape — the inner socket owns it */ }
  send(data: Uint8Array): void { this.inner.send(data) }
  close(code?: number, reason?: string): void { this.inner.close(code, reason) }
}

function spyFactory(): { box: { sock: SpySocket | null }; factory: (url: string) => ChannelSocketLike } {
  const box: { sock: SpySocket | null } = { sock: null }
  return { box, factory: (url: string) => (box.sock = new SpySocket(url)) }
}

// ── Lifecycle: two servers, two gateways, one Redis between them ────────────

let pgContainer: StartedPostgreSqlContainer
let redisContainer: StartedRedisContainer
let pool: Pool
let build: BuildResult
let serverA: Server
let serverB: Server
let handleA: ChannelsHandle
let handleB: ChannelsHandle
let portA = 0
let portB = 0
let wsUrlA = ''
let wsUrlB = ''
/** Per-server HTTP ledgers — the zero-refetch instrument. */
const logA: string[] = []
const logB: string[] = []

const contextFor = (req: IncomingMessage) =>
  ({ userId: Number(req.headers['x-user-id']) || undefined })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return (server.address() as any).port
}

function appServer(log: string[], handle: () => ChannelsHandle): Server {
  const rpc = new RPCHandler({ raccLoans: build.router })
  return createServer((req, res) => {
    log.push(`${req.method} ${req.url}`)
    void (async () => {
      if (req.method === 'POST' && req.url === '/cable/token') {
        const token = handle().mintToken(contextFor(req))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ token }))
        return
      }
      if (req.url?.startsWith('/rpc')) {
        const { matched } = await rpc.handle(req, res, { prefix: '/rpc', context: contextFor(req) })
        if (matched) return
      }
      res.statusCode = 404
      res.end()
    })().catch(() => { try { res.statusCode = 500; res.end() } catch { /* gone */ } })
  })
}

beforeAll(async () => {
  ;[pgContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('redisacc').withUsername('test').withPassword('test')
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ])
  pool = new Pool({ connectionString: pgContainer.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE racc_loans (
      id serial PRIMARY KEY,
      title varchar(255),
      stage integer NOT NULL DEFAULT 0,
      lock_version integer NOT NULL DEFAULT 0
    );
    ${WRITE_LOG_SCHEMA_SQL}
  `)
  boot(drizzle({ client: pool, schema }) as any, schema)
  resetWriteLogRegistry()
  resetColumnarDoorRegistry()
  resetCommitPublishers()
  build = buildRouter(RaccLoanController as any)
  registerLoggedModel(RaccLoan)

  const redisUrl = redisContainer.getConnectionUrl()

  // Server A — "the writing process": its gateway builds its bus THROUGH
  // createBus from config (bus:'redis' + redisUrl — the scaffold's exact
  // shape), boot loopback probe included.
  serverA = appServer(logA, () => handleA)
  portA = await listen(serverA)
  handleA = await attachChannels(serverA, {
    routers: [build],
    config: { channels: { bus: 'redis', redisUrl, coalesceMs: 25, revalidate: 30 } },
    env: 'development',
  })
  wsUrlA = `ws://127.0.0.1:${portA}/cable`

  // Server B — "the other process": a separate RedisBus instance (own
  // connection pair, own probe), publish lane severed (see OtherProcessBus).
  const innerB = new RedisBus({ redisUrl })
  await innerB.start()
  serverB = appServer(logB, () => handleB)
  portB = await listen(serverB)
  handleB = await attachChannels(serverB, {
    routers: [build],
    config: { channels: { coalesceMs: 25, revalidate: 30 } },
    bus: new OtherProcessBus(innerB),
    env: 'development',
  })
  wsUrlB = `ws://127.0.0.1:${portB}/cable`
}, 240_000)

afterAll(async () => {
  await handleA?.close()
  await handleB?.close()     // closes OtherProcessBus → the inner RedisBus pair
  await new Promise<void>(r => serverA?.close(() => r()))
  await new Promise<void>(r => serverB?.close(() => r()))
  resetCommitPublishers()
  resetColumnarDoorRegistry()
  resetWriteLogRegistry()
  await pool?.end()
  await Promise.all([pgContainer?.stop(), redisContainer?.stop()])
})

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function until(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${what} not reached in ${timeoutMs}ms`)
    await sleep(10)
  }
}

function httpClient(port: number, userId?: number): any {
  const link = new RPCLink({
    url: `http://127.0.0.1:${port}/rpc`,
    headers: userId !== undefined ? { 'x-user-id': String(userId) } : {},
  })
  return createORPCClient(link)
}

async function mintOverHttp(port: number, userId?: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/cable/token`, {
    method: 'POST',
    headers: userId !== undefined ? { 'x-user-id': String(userId) } : {},
  })
  if (!res.ok) throw new Error(`mint failed: HTTP ${res.status}`)
  return ((await res.json()) as any).token
}

function httpValidator(counters: { validate: number; fetch: number }, port: number): ProjectionValidator {
  const client = httpClient(port)
  const mask = validatableMask(RaccLoan, LOAN_CONFIG)
  return {
    model: 'racc_loans',
    fields: mask.fields,
    projId: mask.projId,
    validate: async (input) => { counters.validate++; return client.raccLoans.validate(input) },
    fetch: async (id) => { counters.fetch++; return client.raccLoans.get({ id }) },
  }
}

let transports: ChannelTransport[] = []

function makeTransport(opts: {
  store: EntityStore
  url: string
  mint: () => Promise<string> | string
  onReconnect?: () => void
}): { transport: ChannelTransport; box: { sock: SpySocket | null } } {
  const { box, factory } = spyFactory()
  const transport = connectChannels({
    url: opts.url,
    mintToken: opts.mint,
    store: opts.store,
    socketFactory: factory,
    random: () => 0,
    heartbeatMs: 60_000,
    ...(opts.onReconnect ? { onReconnect: opts.onReconnect } : {}),
  })
  transports.push(transport)
  return { transport, box }
}

afterEach(() => {
  for (const t of transports) t.close()
  transports = []
  logA.length = 0
  logB.length = 0
})

// ── The scenarios ───────────────────────────────────────────────────────────

describe('redis-tier acceptance (two gateways, separate RedisBus instances, real Redis between)', () => {
  it('R1. an HTTP write through process A converges client B\'s store via redis — zero refetch', async () => {
    const loan: any = await (RaccLoan as any).create({ title: 'before', stage: 0 })
    const storeA = new EntityStore()
    const storeB = new EntityStore()
    const countersB = { validate: 0, fetch: 0 }

    const a = makeTransport({ store: storeA, url: wsUrlA, mint: () => mintOverHttp(portA, 1) })
    const b = makeTransport({ store: storeB, url: wsUrlB, mint: () => mintOverHttp(portB, 2) })
    const subA = a.transport.subscribeRecord({ door: '/racc-loans', id: loan.id, model: 'racc_loans' })
    const subB = b.transport.subscribeRecord({ door: '/racc-loans', id: loan.id, validator: httpValidator(countersB, portB) })
    expect((await subA.ready).ok).toBe(true)
    expect((await subB.ready).ok).toBe(true)
    await until(() => {
      const ea = storeA.get('racc_loans', loan.id)
      const eb = storeB.get('racc_loans', loan.id)
      return !!ea && !!eb && visibleFields(eb)['title'] === 'before'
    }, 5000, 'initial envelopes')

    logA.length = 0
    logB.length = 0
    const clientA = httpClient(portA, 1)
    await clientA.raccLoans.update({ id: loan.id, data: { title: 'after', stage: 3 } })
    // B's convergence rides: A's emitter → A's RedisBus → the Redis wire →
    // B's RedisBus (ids-only by the payload law) → B's gateway reloads
    // through the door → CHANGE frame → B's store. Nothing else feeds B.
    await until(() => {
      const e = storeB.get('racc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'after' && visibleFields(e)['stage'] === 3
    }, 5000, 'cross-process convergence via redis')

    // ZERO refetch: B's validator callables never fired, and B's http server
    // saw NOTHING — no get, no validate, no re-mint. A's saw only the write.
    expect(countersB).toEqual({ validate: 0, fetch: 0 })
    expect(logB).toEqual([])
    expect(logA.length).toBeGreaterThanOrEqual(1)
    expect(logA.every(l => l.includes('update'))).toBe(true)

    // A's own store converged off its local (tier-0) lane too.
    await until(() => {
      const e = storeA.get('racc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'after'
    }, 3000, "A's convergence")
  })

  it('R2. reconnect gap: a write during the outage is lost on the wire; new publishes flow after auto-re-SUBSCRIBE and the reload heals the gap — no RESET, no ws reconnect', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const loan: any = await (RaccLoan as any).create({ title: 'g0', stage: 0 })
      const storeB = new EntityStore()
      let resetReason: string | null = null
      let wsReconnected = false
      const b = makeTransport({
        store: storeB, url: wsUrlB,
        mint: () => mintOverHttp(portB, 2),
        onReconnect: () => { wsReconnected = true },
      })
      const sub = b.transport.subscribeRecord({
        door: '/racc-loans', id: loan.id, model: 'racc_loans',
        onReset: r => { resetReason = r },
      })
      expect((await sub.ready).ok).toBe(true)
      await until(() => {
        const e = storeB.get('racc_loans', loan.id)
        return !!e && visibleFields(e)['title'] === 'g0'
      }, 5000, 'initial envelope')

      // Server-side outage: kill EVERY pub/sub connection (A's subscriber
      // and B's subscriber). A's publisher connection survives, so its next
      // publish succeeds — into zero subscribers. At-most-once, by design.
      const killed = await redisContainer.exec(['redis-cli', 'CLIENT', 'KILL', 'TYPE', 'pubsub'])
      expect(killed.exitCode).toBe(0)
      expect(Number((killed.output.match(/\d+/) ?? ['0'])[0])).toBeGreaterThan(0)

      const clientA = httpClient(portA, 1)
      await clientA.raccLoans.update({ id: loan.id, data: { title: 'g1', stage: 11 } })
      await sleep(700)                                   // < ioredis' first retry (~2s)
      const during = storeB.get('racc_loans', loan.id)!
      expect(visibleFields(during)['title']).toBe('g0')  // the wire copy is LOST — expected
      expect(visibleFields(during)['stage']).toBe(0)

      // Restore is automatic: ioredis reconnects with the house backoff and
      // re-SUBSCRIBEs on its own. Each fresh write is an independent probe;
      // the first one that lands makes B's gateway reload the FULL record
      // through the door — so the lost write's stage=11 arrives with it.
      // That is the claimed gap convention, happening: pull heals, no RESET.
      let i = 0
      const start = Date.now()
      while (Date.now() - start < 25_000) {
        i++
        await clientA.raccLoans.update({ id: loan.id, data: { title: `g-heal-${i}` } })
        await sleep(300)
        const e = storeB.get('racc_loans', loan.id)
        if (e && String(visibleFields(e)['title']).startsWith('g-heal-')) break
      }
      const after = storeB.get('racc_loans', loan.id)!
      expect(String(visibleFields(after)['title'])).toMatch(/^g-heal-/)  // NEW publishes flow
      expect(visibleFields(after)['stage']).toBe(11)                     // the GAP healed via the reload pull

      // The convention, pinned: the gap never masqueraded as revocation and
      // never touched the client's socket.
      expect(resetReason).toBeNull()
      expect(wsReconnected).toBe(false)
      const resetFrames = b.box.sock!.received.filter(f => peekHeader(f).type === FrameType.RESET)
      expect(resetFrames).toHaveLength(0)
    } finally {
      err.mockRestore()
    }
  }, 60_000)

  it("R3. teaching error: attachChannels refuses bus:'redis' without redisUrl at construction", async () => {
    const throwaway = createServer((_req, res) => { res.statusCode = 404; res.end() })
    await expect(attachChannels(throwaway, {
      routers: [build],
      config: { channels: { bus: 'redis' } },
      env: 'development',
    })).rejects.toThrow(/channels\.redisUrl.*TWO dedicated.*process\.env\.REDIS_URL/s)
  })
})
