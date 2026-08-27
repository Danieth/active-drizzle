/**
 * Channel gateway — transport WS4, node-level acceptance shape: REAL PG
 * through the REAL built routers on a REAL http server, with in-process
 * 'ws' clients (no browser).
 *
 * Pins:
 *  AUTH — bad Origin refused (CSWSH, landmine 6); missing / replayed /
 *  expired one-time tokens refused; the token is single-use by deletion.
 *  SUB — cursor-less record SUB answers SUB_ACK + the full door envelope as
 *  a CHANGE; a FRESH cursor answers SUB_ACK alone (the dry-run IS the WS3
 *  validation); a destroyed record answers gone(D); index SUB carries the
 *  membership tag as cursor.
 *  FRAMES — an edit reaches a subscribed client as a CHANGE whose payload
 *  is the columnar slice (frame-only: no request from the client); the
 *  SILENCE rule holds end-to-end (out-of-expose change ⇒ no frame);
 *  destroys ride as touched-only CHANGE frames; index subs get tag SIGNALs
 *  on membership changes.
 *  EPOCHS/RESET — revocation (scopeBy miss under revalidate:'always')
 *  produces RESET with a bumped epoch, and the sub goes quiet after; the
 *  INDEX lane re-checks too (hook-gated door ⇒ RESET — T9 on both lanes).
 *  LIFECYCLE — UNSUB stops frames; REAUTH swaps ctx (ok:true) and a bad
 *  REAUTH keeps the OLD ctx (ok:false); the one-time token survives a
 *  CONCURRENT double-upgrade exactly once; drain close()s with 1001; a
 *  client that never pongs is terminated by the heartbeat.
 *  TENANCY — URL-scoped doors deliver tenant-lane CHANGEs (extra SUB
 *  params cannot de-tune the lane hash), per-pk-gate door-wide record-less
 *  rumors, and bump the membership tag on scope-column flips (in-commit).
 *  CAPS — maxConnections 503, SUB_LIMIT, RATE_LIMITED (the token bucket).
 *  COALESCING — same-pk supersede is keep-LATEST, pinned deterministically
 *  through bus-injected events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { pgTable, serial, integer, varchar } from 'drizzle-orm/pg-core'
import WebSocket from 'ws'
import {
  ApplicationRecord, boot, MODEL_REGISTRY,
  model as modelDecorator,
  registerLoggedModel, resetWriteLogRegistry, resetCommitPublishers,
  WRITE_LOG_SCHEMA_SQL,
} from '@active-drizzle/core'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '@active-drizzle/core/frames'
import { ActiveController, controller, crud, scope, before, buildRouter, type BuildResult } from '@active-drizzle/controller'
import { resetColumnarDoorRegistry, validatableMask } from '../../src/validate-handler.js'
import { attachChannels, type ChannelsHandle } from '../../src/channels/gateway.js'
import { indexChannel, recordChannel } from '../../src/channels/emitter.js'

// ── Schema / models / doors ─────────────────────────────────────────────────

const gw_loans = pgTable('gw_loans', {
  id:          serial('id').primaryKey(),
  title:       varchar('title', { length: 255 }),
  stage:       integer('stage').notNull().default(0),
  brokerId:    integer('broker_id'),
  teamId:      integer('team_id'),
  secretRate:  integer('secret_rate'),
  lockVersion: integer('lock_version').notNull().default(0),
})
const schema = { gw_loans }

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('gw_loans')
class GwLoan extends ApplicationRecord {}

const LOAN_CONFIG: any = {
  index: { sortable: ['id'], defaultSort: { field: 'id', dir: 'asc' } },
  get: { expose: ['id', 'title', 'stage'], abilities: true },
  update: { permit: ['title', 'stage'], optimisticLock: true },
  wire: 'columnar',
}

@controller('/gw-loans')
@crud(GwLoan as any, LOAN_CONFIG)
class GwLoanController extends ActiveController {}

// The revocation fixture: ctx-scoped door (scopeBy) — flipping the scope
// column revokes the subscriber.
@controller('/gw-my')
@crud(GwLoan as any, {
  index: { sortable: ['id'] },
  get: { expose: ['id', 'title', 'brokerId'], abilities: true },
  update: { permit: ['title'], optimisticLock: true },
  scopeBy: (ctrl: any) => ({ brokerId: ctrl.context?.userId }),
  wire: 'columnar',
} as any)
class GwMyLoanController extends ActiveController {}

// URL-scoped fixture: the tenant lane, its hash canonicalization, per-pk
// gating of door-wide rumors, and the scope-column membership bump.
@scope('teamId')
@controller('/gw-team')
@crud(GwLoan as any, { ...LOAN_CONFIG } as any)
class GwTeamController extends ActiveController {}

// Hook-gated fixture: index-lane revocation (the T9 re-check must RESET).
const banned = new Set<number>()
@controller('/gw-guarded')
@crud(GwLoan as any, { ...LOAN_CONFIG } as any)
class GwGuardedController extends ActiveController {
  @before()
  guard(): void {
    if (banned.has((this as any).context?.userId)) throw new Error('banned')
  }
}

// ── Test client ─────────────────────────────────────────────────────────────

class TestClient {
  frames: Frame[] = []
  private waiters: Array<() => void> = []
  constructor(public ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.frames.push(decodeFrame(new Uint8Array(data)))
      for (const w of this.waiters.splice(0)) w()
    })
  }

  send(input: Parameters<typeof encodeFrame>[0]): void {
    this.ws.send(encodeFrame(input))
  }

  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const start = Date.now()
    for (;;) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      if (Date.now() - start > timeoutMs) {
        throw new Error(`frame not seen in ${timeoutMs}ms; got types [${this.frames.map(f => f.type).join(', ')}]`)
      }
      await new Promise<void>(r => {
        const t = setTimeout(r, 25)
        this.waiters.push(() => { clearTimeout(t); r() })
      })
    }
  }

  /** SUB and await the ack (throws on ok:false unless allowFail). */
  async sub(body: Record<string, unknown>, ref: number): Promise<Frame> {
    this.send({ type: FrameType.SUB, body: { ref, ...body } })
    return this.waitFor(f => f.type === FrameType.SUB_ACK && (f.body as any).ref === ref)
  }

  close(): void { try { this.ws.close() } catch { /* gone */ } }
}

function connect(url: string, opts: { origin?: string; autoPong?: boolean } = {}): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.origin) headers['origin'] = opts.origin
    const ws = new WebSocket(url, { headers, autoPong: opts.autoPong ?? true })
    ws.on('open', () => resolve(new TestClient(ws)))
    ws.on('error', reject)
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

const payloadJson = (f: Frame) => JSON.parse(new TextDecoder().decode(f.payload))

// ── Lifecycle ───────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: Pool
let loanBuild: BuildResult
let myBuild: BuildResult
let teamBuild: BuildResult
let guardedBuild: BuildResult
let mainServer: Server
let mainHandle: ChannelsHandle
let mainUrl = ''
let strictServer: Server               // originAllowlist + tiny token TTL + revalidate:'always' + fast heartbeat
let strictHandle: ChannelsHandle
let strictUrl = ''

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return (server.address() as any).port
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('gateway').withUsername('test').withPassword('test')
    .start()
  pool = new Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(`
    CREATE TABLE gw_loans (
      id serial PRIMARY KEY,
      title varchar(255),
      stage integer NOT NULL DEFAULT 0,
      broker_id integer,
      team_id integer,
      secret_rate integer,
      lock_version integer NOT NULL DEFAULT 0
    );
    ${WRITE_LOG_SCHEMA_SQL}
  `)
  boot(drizzle({ client: pool, schema }) as any, schema)
  resetWriteLogRegistry()
  resetColumnarDoorRegistry()
  resetCommitPublishers()
  loanBuild = buildRouter(GwLoanController as any)
  myBuild = buildRouter(GwMyLoanController as any)
  teamBuild = buildRouter(GwTeamController as any)
  guardedBuild = buildRouter(GwGuardedController as any)
  registerLoggedModel(GwLoan)          // idempotent with the router's registration

  mainServer = createServer((_req, res) => { res.statusCode = 404; res.end() })
  const mainPort = await listen(mainServer)
  mainHandle = await attachChannels(mainServer, {
    routers: [loanBuild, myBuild, teamBuild, guardedBuild],
    config: { channels: { coalesceMs: 20, revalidate: 30 } },
    env: 'development',
  })
  mainUrl = `ws://127.0.0.1:${mainPort}/cable`

  strictServer = createServer((_req, res) => { res.statusCode = 404; res.end() })
  const strictPort = await listen(strictServer)
  strictHandle = await attachChannels(strictServer, {
    routers: [loanBuild, myBuild, teamBuild, guardedBuild],
    config: { channels: {
      coalesceMs: 20, revalidate: 'always', tokenTtlMs: 150,
      originAllowlist: ['http://allowed.test'], heartbeatMs: 60,
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── AUTH ────────────────────────────────────────────────────────────────────

describe('upgrade auth (Origin gate + one-time token)', () => {
  it('refuses a missing token (401) and a bad token (401)', async () => {
    await expect(connect(mainUrl)).rejects.toThrow(/401/)
    await expect(connect(`${mainUrl}?token=forged`)).rejects.toThrow(/401/)
  })

  it('a token is SINGLE-USE: the replay is refused', async () => {
    const token = mainHandle.mintToken({ userId: 1 })
    const c = await connect(`${mainUrl}?token=${token}`)
    await expect(connect(`${mainUrl}?token=${token}`)).rejects.toThrow(/401/)
    c.close()
  })

  it('an expired token is refused (150ms TTL on the strict gateway)', async () => {
    const token = strictHandle.mintToken({ userId: 1 })
    await sleep(250)
    await expect(connect(`${strictUrl}?token=${token}`)).rejects.toThrow(/401/)
  })

  it('the Origin allowlist refuses evil (403) and admits the listed origin', async () => {
    const t1 = strictHandle.mintToken({ userId: 1 })
    await expect(connect(`${strictUrl}?token=${t1}`, { origin: 'https://evil.example' }))
      .rejects.toThrow(/403/)
    const t2 = strictHandle.mintToken({ userId: 1 })
    const ok = await connect(`${strictUrl}?token=${t2}`, { origin: 'http://allowed.test' })
    ok.close()
  })

  it('the dev default admits localhost origins only', async () => {
    const t1 = mainHandle.mintToken({})
    await expect(connect(`${mainUrl}?token=${t1}`, { origin: 'https://evil.example' }))
      .rejects.toThrow(/403/)
    const t2 = mainHandle.mintToken({})
    const ok = await connect(`${mainUrl}?token=${t2}`, { origin: 'http://localhost:5173' })
    ok.close()
  })
})

// ── SUB dry-run ─────────────────────────────────────────────────────────────

async function mainClient(ctx: any = {}): Promise<TestClient> {
  return connect(`${mainUrl}?token=${mainHandle.mintToken(ctx)}`)
}

describe('SUB = the door, dry-run', () => {
  it('cursor-less record SUB: SUB_ACK{cursor: v} + the full envelope as CHANGE', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'hello', stage: 1, secretRate: 42 })
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id }, 1)
    expect(ack.body).toMatchObject({ ref: 1, ok: true, cursor: loan.lockVersion })
    expect(ack.subId).toBeGreaterThan(0)
    expect(ack.epoch).toBe(1)
    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    const slice = payloadJson(change)
    const section = slice.entities.gw_loans
    expect(section.k).toEqual(['id', 'title', 'stage'])     // the door's ceiling — no secretRate
    expect(section.r[0]).toEqual([loan.id, 'hello', 1])
    c.close()
  })

  it('a FRESH cursor answers SUB_ACK alone — the dry-run IS the three-way validation', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'fresh' })
    const projId = validatableMask(GwLoan, LOAN_CONFIG).projId
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id, cursor: loan.lockVersion, projId }, 2)
    expect(ack.body).toMatchObject({ ok: true, cursor: loan.lockVersion })
    await sleep(120)
    expect(c.frames.filter(f => f.type === FrameType.CHANGE)).toHaveLength(0)
    c.close()
  })

  it('a STALE cursor gets the dirty slice immediately after the ack', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'v0' })
    await loan.update({ title: 'v1' })
    const projId = validatableMask(GwLoan, LOAN_CONFIG).projId
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id, cursor: 0, projId }, 3)
    expect(ack.body).toMatchObject({ ok: true, cursor: 1 })
    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    expect(payloadJson(change).entities.gw_loans.r[0][1]).toBe('v1')
    c.close()
  })

  it('a destroyed record answers gone(D) from the tombstone', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'doomed' })
    const id = loan.id
    await loan.destroy()
    const projId = validatableMask(GwLoan, LOAN_CONFIG).projId
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id, cursor: 0, projId }, 4)
    expect(ack.body).toMatchObject({ ok: true, gone: true, d: 1 })
    c.close()
  })

  it('an unknown door refuses with BAD_CHANNEL; a scope miss with NOT_FOUND', async () => {
    const c = await mainClient({ userId: 99 })
    const bad = await c.sub({ door: '/nope', id: 1 }, 5)
    expect(bad.body).toMatchObject({ ok: false, code: 'BAD_CHANNEL' })
    const loan: any = await (GwLoan as any).create({ title: 'not yours', brokerId: 7 })
    const miss = await c.sub({ door: '/gw-my', id: loan.id }, 6)   // ctx userId 99 ≠ brokerId 7
    expect((miss.body as any).ok).toBe(false)
    c.close()
  })

  it('index SUB: SUB_ACK carries the membership tag as cursor', async () => {
    await (GwLoan as any).create({ title: 'row' })
    const { rows } = await pool.query(`SELECT tag FROM membership_tags WHERE door = '/gw-loans'`)
    const tag = Number(rows[0].tag)
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans' }, 7)
    expect(ack.body).toMatchObject({ ok: true, cursor: tag })
    c.close()
  })
})

// ── Frames ──────────────────────────────────────────────────────────────────

describe('frames (the push lane)', () => {
  it('an edit reaches the subscribed client as a CHANGE with the columnar slice — frame-only', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'before', stage: 0 })
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id }, 10)
    await c.waitFor(f => f.type === FrameType.CHANGE)      // the initial envelope
    c.frames.length = 0

    await loan.update({ title: 'after', stage: 3 })
    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    expect(change.epoch).toBe(1)
    const section = payloadJson(change).entities.gw_loans
    expect(section.k).toEqual(['id', 'title', 'stage'])
    expect(section.r[0]).toEqual([loan.id, 'after', 3])
    expect(section.v[0]).toBe(loan.lockVersion)            // the committed token rides in v
    c.close()
  })

  it('THE SILENCE RULE end-to-end: a change outside expose produces no frame', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'quiet', secretRate: 1 })
    const c = await mainClient()
    await c.sub({ door: '/gw-loans', id: loan.id }, 11)
    await c.waitFor(f => f.type === FrameType.CHANGE)
    c.frames.length = 0

    await loan.update({ secretRate: 2 })                   // outside the ceiling
    await sleep(150)
    expect(c.frames).toHaveLength(0)
    c.close()
  })

  it('a destroy rides as a touched-only CHANGE (floor material, zero row data)', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'bye' })
    const id = loan.id
    const c = await mainClient()
    await c.sub({ door: '/gw-loans', id }, 12)
    await c.waitFor(f => f.type === FrameType.CHANGE)
    c.frames.length = 0

    await loan.destroy()
    const change = await c.waitFor(f => f.type === FrameType.CHANGE)
    expect(payloadJson(change)).toEqual({
      touched: [{ resource: 'gw_loans', id, op: 'destroy', version: 1 }],
    })
    c.close()
  })

  it('index subs hear membership as a tag SIGNAL and values as CHANGE', async () => {
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans' }, 13)
    const before = (ack.body as any).cursor as number
    c.frames.length = 0

    const loan: any = await (GwLoan as any).create({ title: 'newcomer' })
    const signal = await c.waitFor(f => f.type === FrameType.SIGNAL && typeof (f.body as any).tag === 'number')
    expect((signal.body as any).tag).toBeGreaterThan(before)

    c.frames.length = 0
    await loan.update({ title: 'renamed' })
    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    expect(payloadJson(change).entities.gw_loans.r[0][1]).toBe('renamed')
    c.close()
  })

  it('UNSUB stops the frames', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'unsub' })
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id }, 14)
    await c.waitFor(f => f.type === FrameType.CHANGE)
    c.send({ type: FrameType.UNSUB, subId: ack.subId })
    await sleep(50)
    c.frames.length = 0
    await loan.update({ title: 'still here?' })
    await sleep(150)
    expect(c.frames).toHaveLength(0)
    c.close()
  })
})

// ── Epochs / RESET / lifecycle ──────────────────────────────────────────────

describe('revocation, reauth, drain, heartbeat', () => {
  async function strictClient(ctx: any): Promise<TestClient> {
    return connect(`${strictUrl}?token=${strictHandle.mintToken(ctx)}`)
  }

  it("revocation under revalidate:'always': the re-check fails ⇒ RESET with a bumped epoch, then silence", async () => {
    const loan: any = await (GwLoan as any).create({ title: 'mine', brokerId: 7 })
    const c = await strictClient({ userId: 7 })
    const ack = await c.sub({ door: '/gw-my', id: loan.id }, 20)
    expect((ack.body as any).ok).toBe(true)
    await c.waitFor(f => f.type === FrameType.CHANGE)
    c.frames.length = 0

    await loan.update({ brokerId: 8 })                     // revoke: scopeBy now misses
    const reset = await c.waitFor(f => f.type === FrameType.RESET && f.subId === ack.subId)
    expect(reset.epoch).toBe(2)                            // O16: the bumped generation

    c.frames.length = 0
    await loan.update({ title: 'more churn' })
    await sleep(150)
    expect(c.frames.filter(f => f.type === FrameType.CHANGE)).toHaveLength(0)
    c.close()
  })

  it('REAUTH consumes a fresh one-time token and acks', async () => {
    const c = await mainClient({ userId: 1 })
    const token = mainHandle.mintToken({ userId: 2 })
    c.send({ type: FrameType.REAUTH, body: { ref: 30, token } })
    const ack = await c.waitFor(f => f.type === FrameType.REAUTH)
    expect(ack.body).toMatchObject({ ref: 30, ok: true })
    // The consumed token cannot open a NEW socket (single use).
    await expect(connect(`${mainUrl}?token=${token}`)).rejects.toThrow(/401/)
    c.close()
  })

  it('app-level PING answers PONG (browser-visible liveness)', async () => {
    const c = await mainClient()
    c.send({ type: FrameType.PING, body: { t: 123 } })
    const pong = await c.waitFor(f => f.type === FrameType.PONG)
    expect(pong.body).toEqual({ t: 123 })
    c.close()
  })

  it('drain: close() severs every socket with 1001 (deploy roll)', async () => {
    const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
    const port = await listen(server)
    const handle = await attachChannels(server, {
      routers: [loanBuild], config: { channels: {} }, env: 'development',
    })
    const c = await connect(`ws://127.0.0.1:${port}/cable?token=${handle.mintToken({})}`)
    const closed = new Promise<number>(r => c.ws.on('close', code => r(code)))
    await handle.close()
    expect(await closed).toBe(1001)
    await new Promise<void>(r => server.close(() => r()))
  })

  it('a client that never pongs is terminated by the heartbeat (2 missed)', async () => {
    const c = await strictClient({})                        // strict gateway: 60ms heartbeat
    ;(c.ws as any)._autoPong = false                        // deafen protocol pongs
    const closed = new Promise<void>(r => c.ws.on('close', () => r()))
    await Promise.race([
      closed,
      sleep(2000).then(() => { throw new Error('heartbeat never terminated the dead client') }),
    ])
  })

  it('REAUTH with a bad token answers ok:false and the connection KEEPS its old ctx', async () => {
    const mine: any = await (GwLoan as any).create({ title: 'still mine', brokerId: 55 })
    const c = await mainClient({ userId: 55 })
    c.send({ type: FrameType.REAUTH, body: { ref: 60, token: 'forged' } })
    const ack = await c.waitFor(f => f.type === FrameType.REAUTH && (f.body as any).ref === 60)
    expect(ack.body).toMatchObject({ ref: 60, ok: false })
    // The old ctx still authorizes: the scopeBy door admits userId 55's record.
    const sub = await c.sub({ door: '/gw-my', id: mine.id }, 61)
    expect((sub.body as any).ok).toBe(true)
    c.close()
  })

  it('concurrent double-upgrade with ONE token admits exactly one socket', async () => {
    const token = mainHandle.mintToken({})
    const results = await Promise.allSettled([
      connect(`${mainUrl}?token=${token}`),
      connect(`${mainUrl}?token=${token}`),
    ])
    const ok = results.filter(r => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    ;(ok[0] as any).value.close()
  })

  it("INDEX-lane revocation: the emission re-check fails under revalidate:'always' ⇒ RESET with a bumped epoch, then silence (T9 on both lanes)", async () => {
    const c = await strictClient({ userId: 77 })
    const ack = await c.sub({ door: '/gw-guarded' }, 44)     // hook passes: not banned yet
    expect((ack.body as any).ok).toBe(true)
    banned.add(77)
    try {
      c.frames.length = 0
      const loan: any = await (GwLoan as any).create({ title: 'trips the flush' })
      const reset = await c.waitFor(f => f.type === FrameType.RESET && f.subId === ack.subId)
      expect(reset.epoch).toBe(2)                            // O16: the bumped generation
      c.frames.length = 0
      await loan.update({ title: 'post-revocation churn' })
      await sleep(200)
      expect(c.frames.filter(f => f.type === FrameType.CHANGE || f.type === FrameType.SIGNAL))
        .toHaveLength(0)
    } finally {
      banned.delete(77)
      c.close()
    }
  })
})

// ── URL-scoped doors (tenant isolation, end-to-end) ─────────────────────────

describe('URL-scoped doors', () => {
  const TEAM_DOOR = '/teams/:teamId/gw-team'

  it("a tenant index sub hears its OWN tenant's value CHANGEs — extra SUB params cannot de-tune the lane hash", async () => {
    const mine: any = await (GwLoan as any).create({ title: 'ours', teamId: 1 })
    const theirs: any = await (GwLoan as any).create({ title: 'theirs', teamId: 2 })
    const c = await mainClient()
    // Filters/pagination ride the dry-run but must NOT enter the lane hash
    // (the publish side hashes only the record's scope columns).
    const ack = await c.sub({ door: TEAM_DOOR, params: { teamId: 1, perPage: 10, page: 0 } }, 40)
    expect((ack.body as any).ok).toBe(true)
    await sleep(60)
    c.frames.length = 0

    await mine.update({ title: 'ours-live' })
    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    expect(payloadJson(change).entities.gw_loans.r[0][1]).toBe('ours-live')

    // The OTHER tenant's value write: no CHANGE, no per-pk SIGNAL — nothing.
    c.frames.length = 0
    await theirs.update({ title: 'theirs-live' })
    await sleep(200)
    expect(c.frames.filter(f => f.type === FrameType.CHANGE)).toHaveLength(0)
    expect(c.frames.filter(f => f.type === FrameType.SIGNAL && (f.body as any).pk !== undefined))
      .toHaveLength(0)
    c.close()
  })

  it("record-less (cross-process shape) door-wide events are per-pk dry-run-gated: another tenant's pk/token/op rumor never reaches this socket", async () => {
    const mine: any = await (GwLoan as any).create({ title: 'm', teamId: 1 })
    const theirs: any = await (GwLoan as any).create({ title: 't', teamId: 2 })
    const c = await mainClient()
    const ack = await c.sub({ door: TEAM_DOOR, params: { teamId: 1 } }, 41)
    expect((ack.body as any).ok).toBe(true)
    await sleep(60)
    c.frames.length = 0

    // Simulate pg-notify receipt: ids-only events on the door-wide lane —
    // on a multi-process bus EVERY remote event arrives exactly like this.
    const idsOnly = (pk: number, token: number) => ({
      table: 'gw_loans', pk, token, op: 'update' as const, changedKeys: ['title'],
    })
    mainHandle.bus.publish(indexChannel(TEAM_DOOR), idsOnly(theirs.id, 5))
    mainHandle.bus.publish(indexChannel(TEAM_DOOR), idsOnly(mine.id, 5))

    // Only OUR pk's rumor arrives (the foreign pk failed the per-pk dry-run).
    const sig = await c.waitFor(f => f.type === FrameType.SIGNAL && (f.body as any).pk !== undefined)
    expect((sig.body as any).pk).toBe(mine.id)
    await sleep(200)
    const pkSignals = c.frames.filter(f => f.type === FrameType.SIGNAL && (f.body as any).pk !== undefined)
    expect(pkSignals).toHaveLength(1)
    expect(pkSignals.some(f => (f.body as any).pk === theirs.id)).toBe(false)
    c.close()
  })

  it('a SCOPE-COLUMN flip bumps the membership tag IN-COMMIT (plain value writes do not) and reaches other tenants as a tag SIGNAL', async () => {
    const c = await mainClient()
    const ack = await c.sub({ door: TEAM_DOOR, params: { teamId: 1 } }, 42)
    expect((ack.body as any).ok).toBe(true)
    await sleep(60)

    const wanderer: any = await (GwLoan as any).create({ title: 'w', teamId: 2 })
    const tagOf = async () => Number(
      (await pool.query(`SELECT tag FROM membership_tags WHERE door = $1`, [TEAM_DOOR])).rows[0].tag)
    const t0 = await tagOf()

    await wanderer.update({ title: 'no move' })              // plain value write: NO bump
    expect(await tagOf()).toBe(t0)

    c.frames.length = 0
    await wanderer.update({ teamId: 1 })                     // re-tenanting: THE bump
    const t1 = await tagOf()
    expect(t1).toBe(t0 + 1)

    // The membershipHint fanned door-wide: this tenant's sub re-reads the
    // tag and the SIGNAL carries the advanced value.
    const sig = await c.waitFor(f => f.type === FrameType.SIGNAL && typeof (f.body as any).tag === 'number')
    expect((sig.body as any).tag).toBe(t1)
    c.close()
  })
})

// ── Resource caps (authenticated-DoS bounds) ────────────────────────────────

describe('resource caps', () => {
  let server: Server
  let handle: ChannelsHandle
  let url = ''

  beforeAll(async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end() })
    const port = await listen(server)
    handle = await attachChannels(server, {
      routers: [loanBuild],
      config: { channels: { maxConnections: 1, maxSubsPerConnection: 3, coalesceMs: 20 } },
      env: 'development',
    })
    url = `ws://127.0.0.1:${port}/cable`
  })

  afterAll(async () => {
    await handle?.close()
    await new Promise<void>(r => server?.close(() => r()))
  })

  it('maxConnections: the (N+1)th upgrade is refused 503 — and admitted again after a slot frees', async () => {
    const c1 = await connect(`${url}?token=${handle.mintToken({})}`)
    await expect(connect(`${url}?token=${handle.mintToken({})}`)).rejects.toThrow(/503/)
    c1.close()
    await sleep(50)
    const c2 = await connect(`${url}?token=${handle.mintToken({})}`)
    c2.close()
    await sleep(50)
  })

  it('SUB flooding drains the token bucket into RATE_LIMITED; live subs beyond the cap answer SUB_LIMIT', async () => {
    const c = await connect(`${url}?token=${handle.mintToken({})}`)
    // Burst 5 SUBs back-to-back (bad door — no DB, so no refill window
    // opens): capacity 3 ⇒ exactly 3 BAD_CHANNEL, then 2 RATE_LIMITED.
    for (let i = 1; i <= 5; i++) c.send({ type: FrameType.SUB, body: { ref: 100 + i, door: '/nope' } })
    await c.waitFor(f => f.type === FrameType.SUB_ACK && (f.body as any).ref === 105)
    const codes = c.frames
      .filter(f => f.type === FrameType.SUB_ACK)
      .map(f => (f.body as any).code)
    expect(codes.filter(x => x === 'BAD_CHANNEL')).toHaveLength(3)
    expect(codes.filter(x => x === 'RATE_LIMITED')).toHaveLength(2)

    // Refill (20/s) restores the burst budget; 3 LIVE subs then hit the cap.
    await sleep(400)
    c.frames.length = 0
    const loan: any = await (GwLoan as any).create({ title: 'cap' })
    const s1 = await c.sub({ door: '/gw-loans', id: loan.id }, 110)
    expect((s1.body as any).ok).toBe(true)
    const s2 = await c.sub({ door: '/gw-loans' }, 111)
    expect((s2.body as any).ok).toBe(true)
    const s3 = await c.sub({ door: '/gw-loans', id: loan.id }, 112)
    expect((s3.body as any).ok).toBe(true)
    const s4 = await c.sub({ door: '/gw-loans' }, 113)
    expect((s4.body as any).code).toBe('SUB_LIMIT')
    c.close()
    await sleep(50)
  })
})

// ── Coalescing supersede (deterministic — the bus is the seam) ──────────────

describe('coalescing supersede', () => {
  it('two same-pk events in ONE window emit ONE CHANGE at the LATER token (keep-latest, never keep-oldest)', async () => {
    const loan: any = await (GwLoan as any).create({ title: 'v0' })
    const c = await mainClient()
    const ack = await c.sub({ door: '/gw-loans', id: loan.id }, 70)
    await c.waitFor(f => f.type === FrameType.CHANGE)
    await sleep(60)
    c.frames.length = 0

    // Two committed states injected synchronously into one coalesce window —
    // no timing race: both are pending before the flush timer can fire.
    const rec = (token: number, title: string) =>
      new (GwLoan as any)({ id: loan.id, title, stage: 0, lockVersion: token }, false)
    const evt = (token: number, title: string) => ({
      table: 'gw_loans', pk: loan.id, token, op: 'update' as const,
      changedKeys: ['title'], record: rec(token, title),
    })
    mainHandle.bus.publish(recordChannel('/gw-loans', loan.id), evt(1, 'older'))
    mainHandle.bus.publish(recordChannel('/gw-loans', loan.id), evt(2, 'newer'))

    const change = await c.waitFor(f => f.type === FrameType.CHANGE && f.subId === ack.subId)
    const section = payloadJson(change).entities.gw_loans
    expect(section.r).toHaveLength(1)
    expect(section.r[0][1]).toBe('newer')                    // the SUPERSEDING value…
    expect(section.v[0]).toBe(2)                             // …at the LATER token
    await sleep(150)
    expect(c.frames.filter(f => f.type === FrameType.CHANGE)).toHaveLength(1)
    c.close()
  })
})
