/**
 * RedisBus — transport WS4 tier 2, against real Redis (testcontainers).
 *
 * Cross-instance delivery of ids-only events (the record never rides the
 * wire; local delivery keeps it), the batching window packing one PUBLISH,
 * the self-origin dedupe (pinned AFTER the wire round trip — the echo had
 * every chance to double-deliver), the loopback boot probe (green path =
 * start() resolving), the not-connected drop (best-effort, loud, throttled),
 * malformed-wire survival (loud per-event skip, never a crash), the
 * per-deployment channel namespace, the double-start() teaching error, and
 * reconnect with auto-re-SUBSCRIBE after a server-side CLIENT KILL —
 * delivery resumes, the gap heals via pull, no new signal shape is invented.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { Redis } from 'ioredis'
import { RedisBus, createBus, redisNamespaceFor, type BusCommitEvent } from '../../src/channels/bus.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Positive assertions wait on the condition with a deadline (a loaded CI
 *  box can push a container round trip past any fixed sleep); fixed short
 *  sleeps remain ONLY for negative assertions ("nothing arrived"). */
async function until(pred: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${what} not reached in ${timeoutMs}ms`)
    await sleep(10)
  }
}

const ev = (over: Partial<BusCommitEvent> = {}): BusCommitEvent => ({
  table: 'loans', pk: 1, token: 3, op: 'update', changedKeys: ['title'], ...over,
})

describe('RedisBus (tier 2 — real Redis)', () => {
  let container: StartedRedisContainer
  let a: RedisBus
  let b: RedisBus

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start()
    // Two instances = two "server processes". start() runs the loopback
    // probe — its resolution IS the green-path probe assertion.
    a = new RedisBus({ redisUrl: container.getConnectionUrl(), batchMs: 5 })
    b = new RedisBus({ redisUrl: container.getConnectionUrl(), batchMs: 5 })
    await a.start()
    await b.start()
  }, 120_000)

  afterAll(async () => {
    await a?.close()
    await b?.close()
    await container?.stop()
  })

  /** Collect deliveries into a live array (assert with `until`). */
  const collect = (bus: RedisBus, channel: string): BusCommitEvent[] => {
    const got: BusCommitEvent[] = []
    bus.subscribe(channel, (_ch, e) => { got.push(e) })
    return got
  }

  it('delivers ids-only events across instances; local delivery keeps the record; the self-echo never re-delivers', async () => {
    const remote = collect(b, 'rec:/loans:7')
    const local: BusCommitEvent[] = []
    a.subscribe('rec:/loans:7', (_ch, e) => { local.push(e) })
    a.publish('rec:/loans:7', ev({ pk: 7, record: { live: true } }))

    expect(local).toHaveLength(1)                           // synchronous local delivery
    expect(local[0]!.record).toEqual({ live: true })        // tier-0 path intact
    expect(local[0]!.token).toBe(3)

    await until(() => remote.length >= 1, 5_000, 'remote delivery')
    expect(remote[0]).toMatchObject({ table: 'loans', pk: 7, token: 3, op: 'update', changedKeys: ['title'] })
    expect(remote[0]!.record).toBeUndefined()               // the wire is ids-only, always

    // THE SELF-DEDUPE PIN — asserted AFTER the wire round trip completed
    // (remote heard, so a's own echo had every chance to arrive): a heard
    // its own commit exactly once, record intact. Without the originId
    // skip, the echo would land as a SECOND, record-less delivery.
    await sleep(200)                                        // settle: let any echo surface
    expect(local).toHaveLength(1)
    expect(local[0]!.record).toEqual({ live: true })
    expect(remote).toHaveLength(1)                          // and b heard exactly once too
  })

  it('membershipHint survives the wire (the m:1 flag)', async () => {
    const remote = collect(b, 'idx:/loans')
    a.publish('idx:/loans', ev({ pk: 8, membershipHint: true }))
    a.publish('idx:/loans', ev({ pk: 9 }))
    await until(() => remote.length >= 2, 5_000, 'both events')
    expect(remote.find(e => e.pk === 8)?.membershipHint).toBe(true)
    expect(remote.find(e => e.pk === 9)?.membershipHint).toBeUndefined()
  })

  it("a trailing '*' prefix subscription hears every matching wire event", async () => {
    const got: string[] = []
    b.subscribe('idx:/notes*', (ch) => got.push(ch))
    a.publish('idx:/notes', ev())
    a.publish('idx:/notes?abc123', ev())
    a.publish('idx:/loans', ev())
    await until(() => got.length >= 2, 5_000, 'both prefix matches')
    await sleep(200)                                        // settle: idx:/loans must NOT arrive
    expect(got.sort()).toEqual(['idx:/notes', 'idx:/notes?abc123'])
  })

  it('batches the window into one PUBLISH — no cap, no chunking, nothing dropped', async () => {
    const bigKeys = Array.from({ length: 12 }, (_, i) => `column_name_number_${i}`)
    const remote = collect(b, 'idx:/batch')
    for (let i = 0; i < 60; i++) a.publish('idx:/batch', ev({ pk: i, changedKeys: bigKeys }))
    await until(() => remote.length >= 60, 10_000, 'all 60 events')
    expect(remote).toHaveLength(60)
    expect(new Set(remote.map(e => e.pk)).size).toBe(60)
    expect(remote[0]!.changedKeys).toEqual(bigKeys)
  })

  it('the wire payload is byte-for-byte the shared encoder output — ids only, the record stripped', async () => {
    const solo = new RedisBus({ redisUrl: container.getConnectionUrl(), batchMs: 5 })
    await solo.start()
    // A raw subscriber on the broadcast channel captures the EXACT bytes
    // PUBLISHed — the shared-helper (toWireEvent + encodeWireBatch) output.
    const raw = new Redis(container.getConnectionUrl())
    try {
      const messages: string[] = []
      raw.on('message', (_ch: string, msg: string) => { messages.push(msg) })
      await raw.subscribe('adrz_cable')

      const roundTripped: BusCommitEvent[] = []
      b.subscribe('rec:/wire:41', (_ch, e) => roundTripped.push(e))
      b.subscribe('idx:/wire', (_ch, e) => roundTripped.push(e))

      solo.publish('rec:/wire:41', ev({ pk: 41, token: 9, record: { never: 'rides' } }))
      solo.publish('idx:/wire', ev({ pk: 42, op: 'create', membershipHint: true }))
      const originId = (solo as any).originId as string
      await until(
        () => roundTripped.length >= 2 && messages.some(m => m.startsWith('{') && m.includes(originId)),
        5_000, 'wire batch + round trip',
      )
      const batch = messages.find(m => m.startsWith('{') && m.includes(originId))
      expect(batch).toBeDefined()
      // Byte-for-byte against the ONE wire shape both cross-process tiers
      // share (hoisted from PgNotifyBus): `{o, e:[{c,t,pk,k,o,ch,m?}]}`,
      // exact key order, one batch per window, membershipHint as m:1, and
      // the record instance NEVER serialized (the payload law).
      expect(batch).toBe(JSON.stringify({
        o: originId,
        e: [
          { c: 'rec:/wire:41', t: 'loans', pk: 41, k: 9, o: 'update', ch: ['title'] },
          { c: 'idx:/wire', t: 'loans', pk: 42, k: 3, o: 'create', ch: ['title'], m: 1 },
        ],
      }))
      // And the decode half restores the exact commit-event shape (no
      // record key, membershipHint re-inflated) — the full round trip.
      expect(roundTripped).toEqual([
        { table: 'loans', pk: 41, token: 9, op: 'update', changedKeys: ['title'] },
        { table: 'loans', pk: 42, token: 3, op: 'create', changedKeys: ['title'], membershipHint: true },
      ])
    } finally {
      raw.disconnect()
      await solo.close()
    }
  }, 20_000)

  it('unsubscribed channels stay silent, and unsubscribe() actually stops delivery', async () => {
    const other: BusCommitEvent[] = []
    const got: BusCommitEvent[] = []
    b.subscribe('rec:/iso:1', (_ch, e) => other.push(e))       // never published to
    const unsub = b.subscribe('rec:/iso:2', (_ch, e) => got.push(e))
    a.publish('rec:/iso:2', ev({ pk: 2 }))
    await until(() => got.length >= 1, 5_000, 'delivery')
    expect(other).toHaveLength(0)                              // no cross-channel bleed
    expect(got).toHaveLength(1)
    unsub()
    a.publish('rec:/iso:2', ev({ pk: 22 }))
    await sleep(400)                                           // negative: nothing may arrive
    expect(got).toHaveLength(1)                                // delivery stopped
    expect(other).toHaveLength(0)
  }, 20_000)

  it('close() tears down BOTH connections (publisher and subscriber) — nothing left dialing', async () => {
    const solo = new RedisBus({ redisUrl: container.getConnectionUrl() })
    await solo.start()
    const pub = (solo as any).pub
    const sub = (solo as any).sub
    expect(pub.status).toBe('ready')
    expect(sub.status).toBe('ready')
    await solo.close()
    expect((solo as any).pub).toBeNull()
    expect((solo as any).sub).toBeNull()
    // disconnect() severs without a round trip; both clients settle to
    // 'end' (poll — the event lands a tick later). A leaked handle here is
    // ALSO caught suite-wide: vitest would hang at exit on a live socket.
    const start = Date.now()
    while ((pub.status !== 'end' || sub.status !== 'end') && Date.now() - start < 2_000) await sleep(25)
    expect(pub.status).toBe('end')
    expect(sub.status).toBe('end')
  }, 20_000)

  it('publishing while the publisher is down DROPS the wire copy loudly (never queues unboundedly)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const solo = new RedisBus({ redisUrl: container.getConnectionUrl(), batchMs: 5 })
    await solo.start()
    try {
      ;(solo as any).pub.disconnect()                      // simulate the reconnect gap
      let local = false
      solo.subscribe('idx:/gap', () => { local = true })
      const remote = collect(b, 'idx:/gap')
      solo.publish('idx:/gap', ev({ pk: 'gap' }))
      await sleep(300)                                     // negative: nothing may arrive
      expect(local).toBe(true)                             // local delivery already served
      expect((solo as any).pending).toHaveLength(0)        // dropped, NOT retained for later
      expect(remote).toHaveLength(0)                       // wire copy dropped, not queued
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/not\s+relayed cross-process.*heal via revalidation pulls/s))
    } finally {
      await solo.close()
      err.mockRestore()
    }
  }, 20_000)

  it('a malformed-but-parseable wire payload is skipped LOUDLY per event — the node survives, good events still deliver', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const raw = new Redis(container.getConnectionUrl())
    try {
      const got: BusCommitEvent[] = []
      b.subscribe('rec:/mal:1', (_ch, e) => got.push(e))
      b.subscribe('idx:/mal*', () => {})                 // a live prefix sub — the startsWith path
      await raw.publish('adrz_cable', '{"o":"foreign","e":1}')          // e is not an array
      await raw.publish('adrz_cable', 'not json at all')                // undecodable
      // null entry + non-string channel + one GOOD event in the SAME batch
      await raw.publish('adrz_cable', '{"o":"foreign","e":[null,{"c":42},' +
        '{"c":"rec:/mal:1","t":"loans","pk":1,"k":5,"o":"update","ch":["title"]}]}')
      await until(() => got.length >= 1, 5_000, 'the good event')
      expect(got[0]).toMatchObject({ table: 'loans', pk: 1, token: 5, op: 'update' })
      // The garbage was skipped LOUDLY — never a throw into ioredis'
      // 'message' emit (that would be an uncaughtException, node down).
      expect(err.mock.calls.some(c => String(c[0]).includes('wire batch without an events array'))).toBe(true)
      expect(err.mock.calls.some(c => String(c[0]).includes('undecodable wire payload'))).toBe(true)
      expect(err.mock.calls.some(c => String(c[0]).includes('malformed wire event skipped'))).toBe(true)
      // And the bus still works: a normal publish flows end to end.
      a.publish('rec:/mal:1', ev({ pk: 1, token: 6 }))
      await until(() => got.length >= 2, 5_000, 'the follow-up event')
      expect(got[1]!.token).toBe(6)
    } finally {
      raw.disconnect()
      err.mockRestore()
    }
  }, 20_000)

  it('namespaces isolate deployments sharing one Redis: same namespace hears, different namespace never does', async () => {
    const url = container.getConnectionUrl()
    const staging = new RedisBus({ redisUrl: url, namespace: 'stg', batchMs: 5 })
    const prod = new RedisBus({ redisUrl: url, namespace: 'prd', batchMs: 5 })
    const prod2 = new RedisBus({ redisUrl: url, namespace: 'prd', batchMs: 5 })
    await Promise.all([staging.start(), prod.start(), prod2.start()])
    try {
      const heardStaging = collect(staging, 'rec:/loans:7')
      const heardProd2 = collect(prod2, 'rec:/loans:7')
      prod.publish('rec:/loans:7', ev({ pk: 7 }))
      await until(() => heardProd2.length >= 1, 5_000, 'same-namespace delivery')
      await sleep(300)                                   // negative: staging must stay deaf
      expect(heardStaging).toHaveLength(0)               // no cross-environment bleed
      expect(heardProd2).toHaveLength(1)
    } finally {
      await Promise.all([staging.close(), prod.close(), prod2.close()])
    }
  }, 30_000)

  it('redisNamespaceFor keys on database HOST+PORT+DBNAME only — creds and params never split a deployment', () => {
    const base = redisNamespaceFor('postgres://app:secret@db.internal:5432/prod_main')
    expect(base).toMatch(/^[0-9a-f]{12}$/)
    // Different credentials / query params → the SAME channel (two
    // processes reaching the same data must hear each other).
    expect(redisNamespaceFor('postgres://other:pw@db.internal:5432/prod_main?sslmode=require')).toBe(base)
    // Default port normalizes.
    expect(redisNamespaceFor('postgres://db.internal/prod_main')).toBe(base)
    // A different database (staging next to prod) → a different channel.
    expect(redisNamespaceFor('postgres://app:secret@db.internal:5432/staging_main')).not.toBe(base)
    // No url / garbage → no namespace (the bare broadcast channel).
    expect(redisNamespaceFor(undefined)).toBeUndefined()
    expect(redisNamespaceFor('::not a url::')).toBeUndefined()
  })

  it('start() on a started bus throws the teaching error instead of orphaning a live connection pair', async () => {
    await expect(a.start()).rejects.toThrow(/start\(\) called twice.*orphan/s)
  })

  // LAST on purpose: it kills b's subscriber connection server-side.
  it('a killed subscriber connection RECONNECTS and re-SUBSCRIBES — delivery resumes, no RESET, pull covers the gap', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Server-side kill of b's subscriber connection (the pub/sub one).
      const killed = await (a as any).pub.call('client', 'kill', 'type', 'pubsub')
      expect(Number(killed)).toBeGreaterThan(0)

      const got: BusCommitEvent[] = []
      b.subscribe('rec:/loans:99', (_ch, e) => got.push(e))
      // Publish repeatedly until the reconnected, auto-re-SUBSCRIBEd
      // connection hears (ioredis backoff starts ~1s; each publish is an
      // independent probe — exactly the pg-notify reconnect drill).
      const start = Date.now()
      while (got.length === 0 && Date.now() - start < 15_000) {
        a.publish('rec:/loans:99', ev({ pk: 99 }))
        await new Promise<void>(r => setTimeout(r, 250))
      }
      expect(got.length).toBeGreaterThan(0)
    } finally {
      err.mockRestore()
    }
  }, 30_000)
})

describe('RedisBus teaching errors (no server needed)', () => {
  it("createBus('redis') without a redisUrl refuses at construction, naming the fix", async () => {
    await expect(createBus('redis', {})).rejects.toThrow(
      /DEDICATED connection pair.*redisUrl: process\.env\.REDIS_URL/s,
    )
  })

  it('an unreachable redis at boot REFUSES loudly (probe timeout) — never a silent background retry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Port 1 answers nothing: ioredis' dials fail instantly and its backoff
    // would retry forever — the boot loopback probe is what turns that into
    // a refusal instead of a server that "starts" deaf.
    const bus = new RedisBus({ redisUrl: 'redis://127.0.0.1:1', probeTimeoutMs: 700 })
    try {
      let thrown: Error | null = null
      try { await bus.start() } catch (e) { thrown = e as Error }
      expect(thrown).not.toBeNull()
      // The teaching error names the knob (channels.redisUrl), the symptom
      // (nothing heard), and both SILENT failure modes beyond plain
      // unreachability (pub/sub-less proxies; LBs splitting the pair).
      expect(thrown!.message).toMatch(/loopback probe/)
      expect(thrown!.message).toMatch(/channels\.redisUrl.*unreachable/s)
      expect(thrown!.message).toMatch(/do(es)? not support SUBSCRIBE/)
      expect(thrown!.message).toMatch(/DIFFERENT isolated instances/)
      // The connection errors were logged LOUDLY before the refusal…
      expect(err.mock.calls.some(c =>
        String(c[0]).includes('redis bus') && String(c[0]).includes('connection error'),
      )).toBe(true)
      // …and the refused boot left no dialing clients behind (start()'s
      // failure path closes the pair — pinned: fail loud, not retry-quietly).
      expect((bus as any).pub).toBeNull()
      expect((bus as any).sub).toBeNull()
    } finally {
      err.mockRestore()
      await bus.close()          // idempotent — belt and braces for the green path
    }
  }, 15_000)
})
