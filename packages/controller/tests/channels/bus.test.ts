/**
 * Channel bus — transport WS4 tiers 0/1 (+ stub teaching).
 *
 * MemoryBus: exact + prefix subscription, unsubscribe, best-effort listener
 * isolation, the tier-0 record short-circuit.
 * PgNotifyBus (real PG): cross-instance delivery of ids-only events, the
 * batching window packing one NOTIFY, chunking under the payload cap, the
 * self-origin dedupe (local delivery keeps the record; the wire copy is
 * skipped), and the PgBouncer probe (green path + the teaching error text).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import {
  MemoryBus, PgNotifyBus, RedisBus, NatsBus, pgBouncerTeachingError,
  type BusCommitEvent,
} from '../../src/channels/bus.js'

const ev = (over: Partial<BusCommitEvent> = {}): BusCommitEvent => ({
  table: 'loans', pk: 1, token: 3, op: 'update', changedKeys: ['title'], ...over,
})

describe('MemoryBus (tier 0)', () => {
  it('delivers to exact subscribers; unsubscribe stops delivery', () => {
    const bus = new MemoryBus()
    const heard: string[] = []
    const un = bus.subscribe('rec:/loans:1', (ch) => heard.push(ch))
    bus.publish('rec:/loans:1', ev())
    bus.publish('rec:/loans:2', ev({ pk: 2 }))   // different channel — silent
    expect(heard).toEqual(['rec:/loans:1'])
    un()
    bus.publish('rec:/loans:1', ev())
    expect(heard).toEqual(['rec:/loans:1'])
  })

  it("a trailing '*' subscribes the prefix", () => {
    const bus = new MemoryBus()
    const heard: string[] = []
    bus.subscribe('idx:/loans*', (ch) => heard.push(ch))
    bus.publish('idx:/loans', ev())
    bus.publish('idx:/loans?abc123', ev())
    bus.publish('idx:/notes', ev())
    expect(heard).toEqual(['idx:/loans', 'idx:/loans?abc123'])
  })

  it('the tier-0 short-circuit: the record instance rides the event', () => {
    const bus = new MemoryBus()
    const marker = { iAmTheLiveRecord: true }
    let got: any = null
    bus.subscribe('rec:/loans:1', (_ch, e) => { got = e.record })
    bus.publish('rec:/loans:1', ev({ record: marker }))
    expect(got).toBe(marker)
  })

  it('a throwing subscriber never severs the bus for the rest', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new MemoryBus()
    const heard: number[] = []
    bus.subscribe('c', () => { throw new Error('broken') })
    bus.subscribe('c', () => heard.push(1))
    bus.publish('c', ev())
    expect(heard).toEqual([1])
    err.mockRestore()
  })
})

describe('stub tiers teach', () => {
  it('redis/nats constructors name the tier, the design, and the working options', () => {
    expect(() => new RedisBus()).toThrow(/'redis' \(tier 2\).*DESIGN-transport-work WS4.*pg-notify/s)
    expect(() => new NatsBus()).toThrow(/'nats' \(tier 3\).*epochs.*never ride the bus/s)
  })

  it('the PgBouncer probe teaching error explains the silent-swallow mechanism', () => {
    expect(pgBouncerTeachingError().message)
      .toMatch(/TRANSACTION\s+pooling.*LISTEN.*silently.*direct/s)
  })
})

describe('PgNotifyBus (tier 1 — real PG)', () => {
  let container: StartedPostgreSqlContainer
  let a: PgNotifyBus
  let b: PgNotifyBus

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('busdb').withUsername('test').withPassword('test')
      .start()
    // Two instances = two "server processes". start() runs the self-NOTIFY
    // probe — its resolution IS the green-path probe assertion.
    a = new PgNotifyBus({ databaseUrl: container.getConnectionUri(), batchMs: 5 })
    b = new PgNotifyBus({ databaseUrl: container.getConnectionUri(), batchMs: 5 })
    await a.start()
    await b.start()
  }, 120_000)

  afterAll(async () => {
    await a?.close()
    await b?.close()
    await container?.stop()
  })

  const heardOn = (bus: PgNotifyBus, channel: string): Promise<BusCommitEvent[]> =>
    new Promise((resolve) => {
      const got: BusCommitEvent[] = []
      bus.subscribe(channel, (_ch, e) => { got.push(e) })
      setTimeout(() => resolve(got), 400)
    })

  it('delivers ids-only events across instances; local delivery keeps the record', async () => {
    const remote = heardOn(b, 'rec:/loans:7')
    let local: BusCommitEvent | null = null
    a.subscribe('rec:/loans:7', (_ch, e) => { local = e })
    a.publish('rec:/loans:7', ev({ pk: 7, record: { live: true } }))

    expect(local).not.toBeNull()
    expect((local as any).record).toEqual({ live: true })   // tier-0 path intact

    const events = await remote
    expect(events).toHaveLength(1)                          // exactly once (self-dedupe on a)
    expect(events[0]).toMatchObject({ table: 'loans', pk: 7, token: 3, op: 'update', changedKeys: ['title'] })
    expect(events[0]!.record).toBeUndefined()               // the wire is ids-only, always
  })

  it('batches the window into NOTIFYs and chunks under the payload cap', async () => {
    // 60 events × ~180B of changedKeys ≈ 3 chunks — all must arrive.
    const bigKeys = Array.from({ length: 12 }, (_, i) => `column_name_number_${i}`)
    const remote = heardOn(b, 'idx:/loans')
    for (let i = 0; i < 60; i++) a.publish('idx:/loans', ev({ pk: i, changedKeys: bigKeys }))
    const events = await remote
    expect(events).toHaveLength(60)
    expect(new Set(events.map(e => e.pk)).size).toBe(60)
    expect(events[0]!.changedKeys).toEqual(bigKeys)
  })

  it('chunk sizing counts UTF-8 BYTES, not UTF-16 length — multibyte keys never overflow the NOTIFY cap', async () => {
    // ~2KB UTF-8 per event but only ~1KB in UTF-16 code units: length-based
    // sizing would pack chunks past the 8000-byte cap, pg_notify would
    // refuse them, and whole chunks of events would silently vanish.
    const wideKeys = Array.from({ length: 30 }, (_, i) => `列名_编号_${i}_${'é'.repeat(25)}`)
    const remote = heardOn(b, 'idx:/utf8')
    for (let i = 0; i < 40; i++) a.publish('idx:/utf8', ev({ pk: i, changedKeys: wideKeys }))
    const events = await remote
    expect(events).toHaveLength(40)
  })

  it('a single event OVER the cap is dropped from the wire LOUDLY; the rest of its batch still delivers', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const hugeKeys = Array.from({ length: 400 }, (_, i) => `very_long_column_name_padding_${i}_xxxxxxxxxxxxxxxxxxxx`)
      const remote = heardOn(b, 'idx:/big')
      let localHuge = false
      a.subscribe('idx:/big', (_ch, e) => { if (e.pk === 'huge') localHuge = true })
      a.publish('idx:/big', ev({ pk: 'huge', changedKeys: hugeKeys }))
      for (let i = 0; i < 5; i++) a.publish('idx:/big', ev({ pk: i }))
      const events = await remote
      expect(events.some(e => e.pk === 'huge')).toBe(false)   // wire copy dropped…
      expect(localHuge).toBe(true)                            // …local delivery already served
      expect(events.filter(e => typeof e.pk === 'number')).toHaveLength(5)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('NOTIFY payload cap'))
    } finally {
      err.mockRestore()
    }
  })

  it('the probe times out into the teaching error when the listener cannot hear', async () => {
    const deaf = new PgNotifyBus({
      databaseUrl: container.getConnectionUri(), probeTimeoutMs: 300,
    })
    // Simulate transaction-pooling deafness: the notification handler is
    // installed by start(); strip it right after LISTEN by racing — instead,
    // point the probe at a client whose LISTEN we sabotage via a monkeypatched
    // query that skips the LISTEN statement (what PgBouncer-tx effectively does).
    const anyBus = deaf as any
    const origStart = deaf.start.bind(deaf)
    // Patch: swallow the LISTEN so notifications never register server-side.
    const { Client } = await import('pg')
    const origQuery = Client.prototype.query
    ;(Client.prototype as any).query = function (this: any, text: any, ...rest: any[]) {
      if (typeof text === 'string' && text.startsWith('LISTEN')) {
        return Promise.resolve({ rows: [] })
      }
      return origQuery.call(this, text, ...rest)
    }
    try {
      await expect(origStart()).rejects.toThrow(/TRANSACTION\s+pooling/s)
    } finally {
      ;(Client.prototype as any).query = origQuery
      await anyBus.close()
    }
  }, 20_000)

  // LAST on purpose: it kills and replaces b's dedicated session.
  it('a terminated LISTEN session RECONNECTS and delivery resumes — never a permanently deaf node', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pidB = (b as any).client.processID
      expect(typeof pidB).toBe('number')
      await (a as any).client.query('SELECT pg_terminate_backend($1)', [pidB])

      const got: BusCommitEvent[] = []
      b.subscribe('rec:/loans:99', (_ch, e) => got.push(e))
      // Publish repeatedly until the reconnected session hears (first retry
      // fires after ~1s of backoff; each probe publish is independent).
      const start = Date.now()
      while (got.length === 0 && Date.now() - start < 15_000) {
        a.publish('rec:/loans:99', ev({ pk: 99 }))
        await new Promise<void>(r => setTimeout(r, 250))
      }
      expect(got.length).toBeGreaterThan(0)
      expect((b as any).client.processID).not.toBe(pidB)      // a NEW session, re-LISTENed
    } finally {
      err.mockRestore()
    }
  }, 30_000)
})
