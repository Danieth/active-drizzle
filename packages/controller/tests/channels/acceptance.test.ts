/**
 * Transport WS4 ACCEPTANCE — the cross-package, node-level, five-scenario
 * suite (work doc §3 WS4 step 10): REAL PG (testcontainers) → REAL built
 * routers served over REAL HTTP (@orpc/server/node RPCHandler — the
 * scaffold's own serving shape) → REAL 'ws' sockets through the gateway →
 * the REAL react client (`connectChannels` + EntityStore), in one process.
 * No fakes anywhere in the pipeline; the only test-double is a SPY around
 * the node WebSocket (capture incoming raw bytes / inject bytes / kill).
 *
 * The six pins:
 *  1. FRAME-ONLY CONVERGENCE — two connected clients on one record's door
 *     channel; A mutates via the real HTTP controller endpoint; B's STORE
 *     converges with ZERO refetch (HTTP request log + validator-callable
 *     counters both flat) inside 500ms.
 *  2. SILENCE RULE — changed ∩ expose = ∅ ⇒ NO frame at B's socket.
 *  3. KILL + CATCH-UP — sever B, mutate 10×, reconnect ⇒ convergence via
 *     the revalidation/pull path (the cursor-carrying re-SUB dry-run IS the
 *     WS3 validation; the mount registry force-revalidates over HTTP too);
 *     per-field lastSeen ends at the final token.
 *  4. EPOCH REPLAY (O16 / T9(ii)) — revoke B ⇒ RESET; a captured pre-RESET
 *     CHANGE frame (and a forged would-win-the-merge frame under the old
 *     epoch) injected at the socket is dropped by the 9-byte peek filter;
 *     the store is untouched.
 *  5. UPGRADE AUTH — no token ⇒ 401; the token (minted over the app's own
 *     HTTP surface) is single-use; wrong Origin ⇒ 403 (landmine 6).
 *  6. HEARTBEAT + BACKPRESSURE smoke — an idle socket outlives many
 *     heartbeat intervals; a write burst coalesces into fewer CHANGE frames
 *     than writes with the same final state (supersede under Rule M).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
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
import { encodeFrame, decodeFrame, peekHeader, FrameType } from '@active-drizzle/core/frames'
import { ActiveController, controller, crud, buildRouter, type BuildResult } from '@active-drizzle/controller'
import { resetColumnarDoorRegistry, validatableMask } from '../../src/validate-handler.js'
import { attachChannels, type ChannelsHandle } from '../../src/channels/gateway.js'
// The REAL client half — imported from source modules directly (the react
// package index re-exports .tsx surfaces this node config doesn't resolve).
import { connectChannels, type ChannelSocketLike, type ChannelTransport } from '../../../react/src/channels.js'
import { EntityStore, visibleFields, lastSeenOf } from '../../../react/src/entity-store.js'
import type { ProjectionValidator } from '../../../react/src/validation-client.js'

// ── Schema / models / doors ─────────────────────────────────────────────────

const acc_loans = pgTable('acc_loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  secretRate:  integer('secret_rate'),
  lockVersion: integer('lock_version').notNull().default(0),
})
const schema = { acc_loans }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('acc_loans')
class AccLoan extends ApplicationRecord {}

const LOAN_CONFIG: any = {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' } },
  get: { expose: ['id', 'title', 'stage'], abilities: true },
  update: { permit: ['title', 'stage'], optimisticLock: true },
  wire: 'columnar',
}

@controller('/acc-loans')
@crud(AccLoan as any, LOAN_CONFIG)
class AccLoanController extends ActiveController {}

// Revocation fixture: ctx-scoped door — flipping brokerId revokes.
@controller('/acc-my')
@crud(AccLoan as any, {
  index: { sortable: ['id'] },
  get: { expose: ['id', 'title', 'brokerId'], abilities: true },
  update: { permit: ['title'], optimisticLock: true },
  scopeBy: (ctrl: any) => ({ brokerId: ctrl.context?.userId }),
  wire: 'columnar',
} as any)
class AccMyLoanController extends ActiveController {}

// ── Spy socket: the real node 'ws' with byte-level capture + injection ──────

class SpySocket implements ChannelSocketLike {
  inner: WebSocket
  /** Every incoming binary message, raw (copies — safe to keep). */
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

  /** Hard sever — no close frame (a dying network, not a polite goodbye). */
  kill(): void { this.inner.terminate() }
  /** Deliver arbitrary bytes AS IF the server sent them (the replay harness). */
  inject(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    this.onmessage?.({ data: buf })
  }
  changesSince(idx: number): Uint8Array[] {
    return this.received.slice(idx).filter(b => peekHeader(b).type === FrameType.CHANGE)
  }
}

function spyFactory(): { box: { sock: SpySocket | null }; factory: (url: string) => ChannelSocketLike } {
  const box: { sock: SpySocket | null } = { sock: null }
  return { box, factory: (url: string) => (box.sock = new SpySocket(url)) }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: Pool
let loanBuild: BuildResult
let myBuild: BuildResult
let mainServer: Server
let mainHandle: ChannelsHandle
let mainPort = 0
let mainUrl = ''
let strictServer: Server          // revalidate:'always' + fast heartbeat + Origin allowlist
let strictHandle: ChannelsHandle
let strictUrl = ''

/** Every HTTP request the main server saw — the zero-refetch ledger. */
const requestLog: string[] = []

const contextFor = (req: IncomingMessage) =>
  ({ userId: Number(req.headers['x-user-id']) || undefined })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return (server.address() as any).port
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('acceptance').withUsername('test').withPassword('test')
    .start()
  pool = new Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE acc_loans (
      id serial PRIMARY KEY,
      title varchar(255),
      stage integer NOT NULL DEFAULT 0,
      broker_id integer,
      secret_rate integer,
      lock_version integer NOT NULL DEFAULT 0
    );
    ${WRITE_LOG_SCHEMA_SQL}
  `)
  boot(drizzle({ client: pool, schema }) as any, schema)
  resetWriteLogRegistry()
  resetColumnarDoorRegistry()
  resetCommitPublishers()
  loanBuild = buildRouter(AccLoanController as any)
  myBuild = buildRouter(AccMyLoanController as any)
  registerLoggedModel(AccLoan)

  // The main server: the scaffold's serving shape — RPC over HTTP at /rpc,
  // the one-time-token mint at POST /cable/token, channels on the SAME
  // http server. Client A's mutations and client B's mint/validate/fetch
  // all pass through here, so requestLog is a complete refetch ledger.
  const rpc = new RPCHandler({ accLoans: loanBuild.router, accMy: myBuild.router })
  mainServer = createServer((req, res) => {
    requestLog.push(`${req.method} ${req.url}`)
    void (async () => {
      if (req.method === 'POST' && req.url === '/cable/token') {
        const token = mainHandle.mintToken(contextFor(req))
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
  mainPort = await listen(mainServer)
  mainHandle = await attachChannels(mainServer, {
    routers: [loanBuild, myBuild],
    config: { channels: { coalesceMs: 50, revalidate: 30 } },
    env: 'development',
  })
  mainUrl = `ws://127.0.0.1:${mainPort}/cable`

  strictServer = createServer((_req, res) => { res.statusCode = 404; res.end() })
  const strictPort = await listen(strictServer)
  strictHandle = await attachChannels(strictServer, {
    routers: [loanBuild, myBuild],
    config: { channels: {
      coalesceMs: 20, revalidate: 'always',
      originAllowlist: ['http://allowed.test'], heartbeatMs: 100,
    } },
    env: 'development',
  })
  strictUrl = `ws://127.0.0.1:${strictPort}/cable`
}, 180_000)

afterAll(async () => {
  await mainHandle?.close()
  await strictHandle?.close()
  await new Promise<void>(r => mainServer?.close(() => r()))
  await new Promise<void>(r => strictServer?.close(() => r()))
  resetCommitPublishers()
  resetColumnarDoorRegistry()
  resetWriteLogRegistry()
  await pool?.end()
  await container?.stop()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const decoder = new TextDecoder()
const payloadJson = (bytes: Uint8Array) => JSON.parse(decoder.decode(decodeFrame(bytes).payload))

async function until(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${what} not reached in ${timeoutMs}ms`)
    await sleep(10)
  }
}

/** A real oRPC client over the real HTTP server (what a browser tab runs). */
function httpClient(userId?: number): any {
  const link = new RPCLink({
    url: `http://127.0.0.1:${mainPort}/rpc`,
    headers: userId !== undefined ? { 'x-user-id': String(userId) } : {},
  })
  return createORPCClient(link)
}

/** Mint over the app's own HTTP surface — the scaffold's token route. */
async function mintOverHttp(userId?: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${mainPort}/cable/token`, {
    method: 'POST',
    headers: userId !== undefined ? { 'x-user-id': String(userId) } : {},
  })
  if (!res.ok) throw new Error(`mint failed: HTTP ${res.status}`)
  return ((await res.json()) as any).token
}

/** The codegen twin: door mask + projId + HTTP transport callables, with
 *  call counters — the zero-refetch instrument. */
function httpValidator(counters: { validate: number; fetch: number }): ProjectionValidator {
  const client = httpClient()
  const mask = validatableMask(AccLoan, LOAN_CONFIG)
  return {
    model: 'acc_loans',
    fields: mask.fields,
    projId: mask.projId,
    validate: async (input) => { counters.validate++; return client.accLoans.validate(input) },
    fetch: async (id) => { counters.fetch++; return client.accLoans.get({ id }) },
  }
}

let transports: ChannelTransport[] = []

function makeTransport(opts: {
  store: EntityStore
  mint: () => Promise<string> | string
  url?: string
  onReconnect?: () => void
}): { transport: ChannelTransport; box: { sock: SpySocket | null } } {
  const { box, factory } = spyFactory()
  const transport = connectChannels({
    url: opts.url ?? mainUrl,
    mintToken: opts.mint,
    store: opts.store,
    socketFactory: factory,
    random: () => 0,               // deterministic (zero-delay) backoff
    heartbeatMs: 60_000,           // app pings stay out of the frame counts
    ...(opts.onReconnect ? { onReconnect: opts.onReconnect } : {}),
  })
  transports.push(transport)
  return { transport, box }
}

function rawConnect(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (origin) headers['origin'] = origin
    const ws = new WebSocket(url, { headers })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

afterEach(() => {
  for (const t of transports) t.close()
  transports = []
  requestLog.length = 0
})

// ── The scenarios ───────────────────────────────────────────────────────────

describe('WS4 acceptance (real PG → real HTTP → real ws → real client store)', () => {
  it('1. FRAME-ONLY CONVERGENCE: A mutates over HTTP; B\'s store converges with zero refetch, <500ms', async () => {
    const loan: any = await (AccLoan as any).create({ title: 'before', stage: 0 })
    const storeA = new EntityStore()
    const storeB = new EntityStore()
    const counters = { validate: 0, fetch: 0 }

    const a = makeTransport({ store: storeA, mint: () => mintOverHttp(1) })
    const b = makeTransport({ store: storeB, mint: () => mintOverHttp(2) })
    const subA = a.transport.subscribeRecord({ door: '/acc-loans', id: loan.id, model: 'acc_loans' })
    const subB = b.transport.subscribeRecord({ door: '/acc-loans', id: loan.id, validator: httpValidator(counters) })
    expect((await subA.ready).ok).toBe(true)
    expect((await subB.ready).ok).toBe(true)
    // Both stores hold the initial envelope (the cursor-less SUB's CHANGE).
    await until(() => {
      const ea = storeA.get('acc_loans', loan.id)
      const eb = storeB.get('acc_loans', loan.id)
      return !!ea && !!eb && visibleFields(eb)['title'] === 'before'
    }, 3000, 'initial envelopes')

    requestLog.length = 0
    const clientA = httpClient(1)
    const t0 = Date.now()
    await clientA.accLoans.update({ id: loan.id, data: { title: 'after', stage: 3 } })
    await until(() => {
      const e = storeB.get('acc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'after' && visibleFields(e)['stage'] === 3
    }, 1500, 'frame-only convergence')
    expect(Date.now() - t0).toBeLessThan(500)

    // ZERO refetch: B's validator callables never fired, and the server saw
    // ONLY A's update — no get, no validate, no token re-mint.
    expect(counters).toEqual({ validate: 0, fetch: 0 })
    expect(requestLog.length).toBeGreaterThanOrEqual(1)
    expect(requestLog.every(l => l.includes('update'))).toBe(true)

    // A's store converged off its own frame too, and the committed token
    // rode in as per-field lastSeen (Rule M, not a refetch echo).
    await until(() => {
      const e = storeA.get('acc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'after'
    }, 1500, "A's convergence")
    const eb = storeB.get('acc_loans', loan.id)!
    expect(lastSeenOf(eb, 'title')).toBe(1)
  })

  it('2. SILENCE RULE: changed ∩ expose = ∅ ⇒ no frame at B\'s socket', async () => {
    const loan: any = await (AccLoan as any).create({ title: 'quiet', secretRate: 1 })
    const storeB = new EntityStore()
    const b = makeTransport({ store: storeB, mint: () => mintOverHttp(2) })
    const sub = b.transport.subscribeRecord({ door: '/acc-loans', id: loan.id, model: 'acc_loans' })
    expect((await sub.ready).ok).toBe(true)
    await until(() => !!storeB.get('acc_loans', loan.id), 3000, 'initial envelope')
    await sleep(120)                              // let the initial CHANGE fully land

    const sock = b.box.sock!
    const seen = sock.received.length
    // secretRate is outside the door's expose (and outside permit — this is
    // a server-side write, e.g. a job): the emitter must publish NOTHING.
    await loan.update({ secretRate: 2 })
    await sleep(300)                              // > coalesce window + delivery
    expect(sock.received.length).toBe(seen)       // asserted AT THE SOCKET
  })

  it('3. KILL + CATCH-UP: sever B, mutate 10×, reconnect ⇒ pull-path convergence; lastSeen at the final tokens', async () => {
    const loan: any = await (AccLoan as any).create({ title: 'k0', stage: 0 })
    const storeB = new EntityStore()
    const counters = { validate: 0, fetch: 0 }
    let release: (() => void) | null = null
    let gate: Promise<void> | null = null
    let reconnected = false
    const b = makeTransport({
      store: storeB,
      // The gate holds the reconnect's token mint until the mutations land —
      // a deterministic network gap.
      mint: async () => { if (gate) await gate; return mintOverHttp(1) },
      onReconnect: () => { reconnected = true },
    })
    const spec = httpValidator(counters)
    const sub = b.transport.subscribeRecord({ door: '/acc-loans', id: loan.id, validator: spec })
    b.transport.registerMount(spec, loan.id)
    expect((await sub.ready).ok).toBe(true)
    await until(() => {
      const e = storeB.get('acc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'k0'
    }, 3000, 'initial envelope')
    expect(counters).toEqual({ validate: 0, fetch: 0 })

    // Sever (no close frame), then mutate 10× through the real endpoint.
    gate = new Promise<void>(r => { release = r })
    b.box.sock!.kill()
    const clientA = httpClient(1)
    for (let i = 1; i <= 10; i++) {
      await clientA.accLoans.update({ id: loan.id, data: { title: `k${i}`, stage: i } })
    }
    release!()

    // Reconnect: the cursor-carrying re-SUB dry-run IS the WS3 validation —
    // stale ⇒ ack + dirty slice; the mount registry force-revalidates over
    // HTTP as well (the gap is the rumor).
    await until(() => {
      const e = storeB.get('acc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'k10' && visibleFields(e)['stage'] === 10
    }, 5000, 'catch-up convergence')
    expect(reconnected).toBe(true)
    expect(counters.validate).toBeGreaterThanOrEqual(1)   // the pull path ran

    const e = storeB.get('acc_loans', loan.id)!
    for (const f of spec.fields) {
      expect(lastSeenOf(e, f)).toBe(10)                   // per-field, at the FINAL token
    }
  })

  it('4. EPOCH REPLAY (O16/T9(ii)): a captured pre-RESET CHANGE injected after RESET is dropped; store untouched', async () => {
    const loan: any = await (AccLoan as any).create({ title: 'orig', brokerId: 7 })
    const storeB = new EntityStore()
    let resetReason: string | null = null
    let refused: string | null = null
    const b = makeTransport({
      store: storeB,
      url: strictUrl,                                     // revalidate:'always'
      mint: () => strictHandle.mintToken({ userId: 7 }),
    })
    const sub = b.transport.subscribeRecord({
      door: '/acc-my', id: loan.id, model: 'acc_loans',
      onReset: r => { resetReason = r },
      onRefused: c => { refused = c },
    })
    expect((await sub.ready).ok).toBe(true)
    await until(() => {
      const e = storeB.get('acc_loans', loan.id)
      return !!e && visibleFields(e)['title'] === 'orig'
    }, 3000, 'initial envelope')

    await loan.update({ title: 'v1' })
    await until(() => visibleFields(storeB.get('acc_loans', loan.id)!)['title'] === 'v1', 3000, 'v1 frame')
    // Capture the genuine v1 CHANGE frame bytes off the wire.
    const captured = b.box.sock!.received.find(bytes => {
      if (peekHeader(bytes).type !== FrameType.CHANGE) return false
      return payloadJson(bytes)?.entities?.acc_loans?.r?.[0]?.[1] === 'v1'
    })
    expect(captured).toBeDefined()
    const capturedHeader = peekHeader(captured!)
    expect(capturedHeader.epoch).toBe(1)

    await loan.update({ title: 'v2' })
    await until(() => visibleFields(storeB.get('acc_loans', loan.id)!)['title'] === 'v2', 3000, 'v2 frame')
    const lsBefore = lastSeenOf(storeB.get('acc_loans', loan.id)!, 'title')

    // Revoke: scopeBy now misses ⇒ emission-time re-check fails ⇒ RESET
    // (bumped epoch); the client's automatic re-SUB is refused.
    await loan.update({ brokerId: 8 })
    await until(() => resetReason !== null, 3000, 'RESET')
    await until(() => refused !== null, 3000, 're-SUB refusal')

    // The replay: the genuine pre-RESET frame, then a FORGED frame under the
    // old epoch whose token (999) would win any merge — the epoch filter,
    // not the token floor, must be what stops it.
    b.box.sock!.inject(captured!)
    const forged = encodeFrame({
      type: FrameType.CHANGE, subId: capturedHeader.subId, epoch: capturedHeader.epoch, body: {},
      payload: new TextEncoder().encode(JSON.stringify({
        entities: { acc_loans: { k: ['id', 'title', 'brokerId'], v: [999], r: [[loan.id, 'FORGED', 8]] } },
      })),
    })
    b.box.sock!.inject(forged)
    await sleep(150)

    const after = storeB.get('acc_loans', loan.id)!
    expect(visibleFields(after)['title']).toBe('v2')      // untouched
    expect(lastSeenOf(after, 'title')).toBe(lsBefore)     // not even a lawful re-merge
  })

  it('5. UPGRADE AUTH: no token ⇒ 401; the HTTP-minted token is single-use; wrong Origin ⇒ 403', async () => {
    await expect(rawConnect(mainUrl)).rejects.toThrow(/401/)

    const token = await mintOverHttp(1)                   // the app's own HTTP surface
    const ok = await rawConnect(`${mainUrl}?token=${token}`)
    await expect(rawConnect(`${mainUrl}?token=${token}`)).rejects.toThrow(/401/)  // replay refused
    ok.close()

    const strictToken = strictHandle.mintToken({})
    await expect(rawConnect(`${strictUrl}?token=${strictToken}`, 'https://evil.example'))
      .rejects.toThrow(/403/)                             // CSWSH gate — landmine 6
  })

  it('6a. HEARTBEAT smoke: an idle socket outlives many heartbeat intervals', async () => {
    // The strict gateway pings every 100ms; node ws auto-pongs. 6+ intervals
    // idle and the socket is still open — the heartbeat sustains, it does
    // not sever a responsive-but-quiet client.
    const ws = await rawConnect(`${strictUrl}?token=${strictHandle.mintToken({})}`, 'http://allowed.test')
    await sleep(650)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('6b. BACKPRESSURE/coalescing smoke: a write burst emits fewer CHANGE frames than writes, same final state', async () => {
    const loan: any = await (AccLoan as any).create({ title: 'burst-0' })
    const storeB = new EntityStore()
    const b = makeTransport({ store: storeB, mint: () => mintOverHttp(2) })
    const sub = b.transport.subscribeRecord({ door: '/acc-loans', id: loan.id, model: 'acc_loans' })
    expect((await sub.ready).ok).toBe(true)
    await until(() => !!storeB.get('acc_loans', loan.id), 3000, 'initial envelope')
    await sleep(120)

    const sock = b.box.sock!
    const mark = sock.received.length
    const WRITES = 8
    for (let i = 1; i <= WRITES; i++) await loan.update({ title: `burst-${i}` })
    await until(() => visibleFields(storeB.get('acc_loans', loan.id)!)['title'] === `burst-${WRITES}`,
      3000, 'burst convergence')
    await sleep(250)                                      // drain the last coalesce window

    const changes = sock.changesSince(mark)
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes.length).toBeLessThan(WRITES)           // coalesced (supersede under Rule M)

    // Same final state: the last frame carries the final value AT the final
    // committed token, and the store agrees.
    const last = payloadJson(changes[changes.length - 1]!)
    expect(last.entities.acc_loans.r[0][1]).toBe(`burst-${WRITES}`)
    expect(last.entities.acc_loans.v[0]).toBe(WRITES)
    const e = storeB.get('acc_loans', loan.id)!
    expect(lastSeenOf(e, 'title')).toBe(WRITES)
  })
})
