/**
 * Channel client — transport WS4, client half. Pure jsdom: the socket is an
 * injected fake (the ChannelTransport seam exists exactly so node-level
 * suites and the future SharedWorker port share one protocol body).
 *
 * Pins:
 *  CONNECT — dials with a minted one-time token; every reconnect mints a
 *  NEW one (tokens are single-use — landmine 6).
 *  SUB — record SUB carries cursor (projFreshAt) + projId when the
 *  projection is held/tracked, and is cursor-less otherwise; index SUB
 *  carries the last known tag.
 *  DISPATCH — CHANGE payload (columnar JSON bytes) merges through
 *  mergeEnvelope (per-field, tokened); touched-destroy CHANGE raises the
 *  floor; SIGNAL {table,pk,token} is a rumor (M3) that triggers the WS3
 *  revalidate on validator-carrying record subs; SIGNAL {tag} fires onTag
 *  only when the tag advances; gone acks dispatch store.destroy with the
 *  REAL token.
 *  O16 — a replayed CHANGE whose epoch precedes current(subId) is dropped
 *  (acceptance scenario e); RESET adopts the new epoch, force-revalidates,
 *  and re-SUBs fresh.
 *  LIFECYCLE — refused acks resolve ok:false; unsubscribe sends UNSUB and
 *  stops dispatch; reconnect backs off, re-SUBs with recomputed cursors,
 *  force-revalidates the mount registry, and fires onReconnect; 1001
 *  drains reconnect fast; heartbeat PINGs and two missed PONGs sever;
 *  close() is final.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { encodeFrame, decodeFrame, FrameType, type Frame } from '@active-drizzle/core/frames'
import { connectChannels, type ChannelSocketLike, type ConnectChannelsOptions } from '../src/channels.js'
import { EntityStore, projFreshAt, isGone } from '../src/entity-store.js'
import type { ProjectionValidator, ValidateResponse } from '../src/validation-client.js'

// ── Fake socket ─────────────────────────────────────────────────────────────

class FakeSocket implements ChannelSocketLike {
  static instances: FakeSocket[] = []
  binaryType = 'blob'
  readyState = 0
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  sent: Frame[] = []
  constructor(public url: string) { FakeSocket.instances.push(this) }

  send(data: Uint8Array): void { this.sent.push(decodeFrame(data)) }
  close(code = 1000): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
  // test-side controls
  open(): void { this.readyState = 1; this.onopen?.() }
  receive(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    this.onmessage?.({ data: buf })
  }
  serverClose(code: number): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
}

const tick = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await Promise.resolve() }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const payloadOf = (env: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(env))

function makeSpec(overrides: Partial<ProjectionValidator> = {}): ProjectionValidator {
  return {
    model: 'loans',
    fields: ['id', 'title', 'stage'],
    projId: 'proj-loans-1',
    validate: vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 99 })),
    fetch: vi.fn(async () => ({})),
    ...overrides,
  }
}

let transports: Array<{ close(): void }> = []

function boot(overrides: Partial<ConnectChannelsOptions> = {}) {
  const store = new EntityStore()
  let minted = 0
  const mintToken = vi.fn(() => `tok-${++minted}`)
  const transport = connectChannels({
    url: 'ws://app.test/cable',
    mintToken,
    store,
    socketFactory: (url) => new FakeSocket(url),
    random: () => 0,
    ...overrides,
  })
  transports.push(transport)
  return { transport, store, mintToken }
}

/** The freshly-opened socket (after awaiting the async connect). */
async function openSocket(): Promise<FakeSocket> {
  await tick()
  const sock = FakeSocket.instances[FakeSocket.instances.length - 1]!
  sock.open()
  return sock
}

function ackFrom(sock: FakeSocket, subId: number, extra: Record<string, unknown> = {}): void {
  const sub = sock.sent.find(f => f.type === FrameType.SUB)!
  const ref = (sub.body as any).ref
  sock.receive(encodeFrame({
    type: FrameType.SUB_ACK, subId, epoch: 1, body: { ref, ok: true, door: (sub.body as any).door, ...extra },
  }))
}

afterEach(() => {
  for (const t of transports) t.close()
  transports = []
  FakeSocket.instances = []
  vi.useRealTimers()
})

// ── Connect / SUB shapes ────────────────────────────────────────────────────

describe('connect + SUB', () => {
  it('dials with a minted one-time token in the query string', async () => {
    const { mintToken } = boot()
    const sock = await openSocket()
    expect(mintToken).toHaveBeenCalledTimes(1)
    expect(sock.url).toBe('ws://app.test/cable?token=tok-1')
    expect(sock.binaryType).toBe('arraybuffer')
  })

  it('record SUB carries cursor (projFreshAt) + projId when the projection is held', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec() })
    const sub = sock.sent.find(f => f.type === FrameType.SUB)!
    expect(sub.body).toMatchObject({ door: '/loans', id: 1, cursor: 5, projId: 'proj-loans-1' })
  })

  it('record SUB is cursor-less when any mask field is unheld (fetch lane, never a fabricated W)', async () => {
    const { transport } = boot()
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec() })
    const sub = sock.sent.find(f => f.type === FrameType.SUB)!
    expect((sub.body as any).cursor).toBeUndefined()
    expect((sub.body as any).projId).toBeUndefined()
  })

  it('SUB_ACK resolves ready with the assigned cursor', async () => {
    const { transport } = boot()
    const sock = await openSocket()
    const sub = transport.subscribeRecord({ door: '/loans', id: 1 })
    ackFrom(sock, 7, { id: 1, cursor: 12 })
    await expect(sub.ready).resolves.toMatchObject({ ok: true, cursor: 12 })
  })

  it('a refused ack resolves ok:false and fires onRefused', async () => {
    const { transport } = boot()
    const sock = await openSocket()
    const onRefused = vi.fn()
    const sub = transport.subscribeRecord({ door: '/nope', id: 1, onRefused })
    const ref = (sock.sent.find(f => f.type === FrameType.SUB)!.body as any).ref
    sock.receive(encodeFrame({
      type: FrameType.SUB_ACK, body: { ref, ok: false, code: 'BAD_CHANNEL', message: 'no columnar door' },
    }))
    await expect(sub.ready).resolves.toMatchObject({ ok: false, code: 'BAD_CHANNEL' })
    expect(onRefused).toHaveBeenCalledWith('BAD_CHANNEL', 'no columnar door')
  })

  it('a gone ack dispatches store.destroy with the REAL token (T4)', async () => {
    const { transport, store } = boot()
    store.merge('loans', 3, { id: 3, title: 'x' }, { version: 4 })
    const sock = await openSocket()
    const sub = transport.subscribeRecord({ door: '/loans', id: 3, validator: makeSpec() })
    ackFrom(sock, 2, { id: 3, gone: true, d: 8 })
    await expect(sub.ready).resolves.toMatchObject({ ok: true, gone: true, d: 8 })
    expect(isGone(store.get('loans', 3)!)).toBe(true)
    expect(store.exportFloors()).toContainEqual(['loans', 3, 8])
  })
})

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('frame dispatch', () => {
  it('CHANGE payload merges through mergeEnvelope — per-field, at the token', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec() })
    ackFrom(sock, 7, { id: 1, cursor: 5 })
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [6], r: [[1, 'renamed']] } } }),
    }))
    const entry = store.get('loans', 1)!
    expect(entry.fields['title']).toBe('renamed')
    expect(entry.fields['stage']).toBe(0)                     // untouched cell survives
    expect(projFreshAt(entry, ['id', 'title'])).toBe(6)
  })

  it('a stale CHANGE loses per-field to fresher truth (Rule M1, not last-write-wins)', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'fresh' }, { version: 9 })
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1 })
    ackFrom(sock, 7, { id: 1 })
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [6], r: [[1, 'old']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('fresh')
  })

  it('a touched-destroy CHANGE raises the floor (M2 — the record renders gone)', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a' }, { version: 5 })
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1 })
    ackFrom(sock, 7, { id: 1 })
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ touched: [{ resource: 'loans', id: 1, op: 'destroy', version: 6 }] }),
    }))
    expect(isGone(store.get('loans', 1)!)).toBe(true)
  })

  it('SIGNAL {table,pk,token} is a rumor (M3) and triggers the WS3 revalidate on the sub', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    const validate = vi.fn(async (input: { ifNoneMatch: number }): Promise<ValidateResponse> =>
      ({ status: 'fresh', v: 7 }))
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec({ validate: validate as any }) })
    ackFrom(sock, 7, { id: 1, cursor: 5 })
    sock.receive(encodeFrame({
      type: FrameType.SIGNAL, subId: 7, epoch: 1, body: { table: 'loans', pk: 1, token: 7, op: 'update' },
    }))
    expect(store.get('loans', 1)!.knownVersion).toBe(7)       // the rumor joined
    await tick(12)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]![0]).toMatchObject({ id: 1, ifNoneMatch: 5 })
    // fresh(7) certified at the issue-time watermark → projection current again
    expect(projFreshAt(store.get('loans', 1)!, ['id', 'title', 'stage'])).toBe(7)
  })

  it('a SIGNAL whose values already arrived by echo costs zero round trips (echo-merge skip)', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 9 })
    const validate = vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 9 }))
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec({ validate: validate as any }) })
    ackFrom(sock, 7, { id: 1, cursor: 9 })
    sock.receive(encodeFrame({
      type: FrameType.SIGNAL, subId: 7, epoch: 1, body: { table: 'loans', pk: 1, token: 9, op: 'update' },
    }))
    await tick(12)
    expect(validate).not.toHaveBeenCalled()
  })

  it('index tag SIGNAL fires onTag only when the tag advances past the known one', async () => {
    const { transport } = boot()
    const sock = await openSocket()
    const onTag = vi.fn()
    transport.subscribeIndex({ door: '/loans', onTag })
    ackFrom(sock, 4, { cursor: 10 })                          // membership tag rides the ack
    const tagFrame = (tag: number) => encodeFrame({
      type: FrameType.SIGNAL, subId: 4, epoch: 1, body: { tag },
    })
    sock.receive(tagFrame(10))                                // duplicate: silence
    sock.receive(tagFrame(9))                                 // stale: silence
    expect(onTag).not.toHaveBeenCalled()
    sock.receive(tagFrame(11))
    expect(onTag).toHaveBeenCalledExactlyOnceWith(11)
    sock.receive(tagFrame(11))                                // replay: silence
    expect(onTag).toHaveBeenCalledTimes(1)
  })
})

// ── O16 — the epoch filter + RESET ──────────────────────────────────────────

describe('epochs (O16)', () => {
  it('RESET adopts the new epoch, force-revalidates, re-SUBs fresh; a replayed old-epoch CHANGE is dropped', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    const validate = vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 6 }))
    const sock = await openSocket()
    const onReset = vi.fn()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec({ validate: validate as any }), onReset })
    ackFrom(sock, 7, { id: 1, cursor: 5 })

    // A live CHANGE at epoch 1 applies.
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [6], r: [[1, 'b']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('b')
    const subFramesBefore = sock.sent.filter(f => f.type === FrameType.SUB).length

    // RESET: the server retired the sub and bumped the epoch.
    sock.receive(encodeFrame({ type: FrameType.RESET, subId: 7, epoch: 2, body: { reason: 'revoked' } }))
    expect(onReset).toHaveBeenCalledExactlyOnceWith('revoked')
    await tick(12)
    expect(validate).toHaveBeenCalledTimes(1)                 // forced through WS3
    const resub = sock.sent.filter(f => f.type === FrameType.SUB)
    expect(resub.length).toBe(subFramesBefore + 1)            // re-SUB rides immediately

    // Acceptance (e): a replayed pre-epoch frame is DROPPED — no merge.
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [99], r: [[1, 'evil']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('b')
    expect(store.get('loans', 1)!.knownVersion).toBeLessThan(99)

    // Even a frame AT the new epoch on the retired subId stays dead (the
    // server never emits one — the sub is gone — so strictness is free).
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 2, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [100], r: [[1, 'still-evil']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('b')

    // The re-SUB gets a NEW subId at epoch 1 — its frames flow.
    const resubRef = (resub[resub.length - 1]!.body as any).ref
    sock.receive(encodeFrame({
      type: FrameType.SUB_ACK, subId: 8, epoch: 1, body: { ref: resubRef, ok: true, door: '/loans', id: 1 },
    }))
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 8, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [7], r: [[1, 'c']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('c')
  })

  it('the epoch filter never regresses: a replayed RESET with an OLD epoch cannot re-admit old frames (max-join)', async () => {
    const { transport, store } = boot()
    store.merge('loans', 1, { id: 1, title: 'a' }, { version: 5 })
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1 })
    ackFrom(sock, 7, { id: 1 })

    // Legitimate RESET to epoch 3 retires the sub; the client re-SUBs.
    sock.receive(encodeFrame({ type: FrameType.RESET, subId: 7, epoch: 3, body: { reason: 'revoked' } }))
    // A hostile/buggy server acks the re-SUB REUSING subId 7 at epoch 1 —
    // the filter entry must MAX-JOIN (stay 3), never adopt the regression
    // (O16: the epoch table, not the retired-subId map, is the boundary).
    const resub = sock.sent.filter(f => f.type === FrameType.SUB).pop()!
    sock.receive(encodeFrame({
      type: FrameType.SUB_ACK, subId: 7, epoch: 1,
      body: { ref: (resub.body as any).ref, ok: true, door: '/loans', id: 1 },
    }))

    // The sub is live again under subId 7 — an old-generation CHANGE at
    // epoch 2 (< 3) must STILL be dropped by the epoch table alone.
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 2, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [99], r: [[1, 'evil']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('a')

    // Current-generation frames (≥ 3) still flow to the re-acked sub.
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 3, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [6], r: [[1, 'b']] } } }),
    }))
    expect(store.get('loans', 1)!.fields['title']).toBe('b')
  })

  it('frames for an unknown subId are dropped (no sub was ever acked there)', async () => {
    const { transport, store } = boot()
    const sock = await openSocket()
    transport.subscribeRecord({ door: '/loans', id: 1 })
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 42, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [5], r: [[1, 'ghost']] } } }),
    }))
    expect(store.get('loans', 1)).toBeUndefined()
  })
})

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('unsubscribe sends UNSUB on the subId and stops dispatch', async () => {
    const { transport, store } = boot()
    const sock = await openSocket()
    const sub = transport.subscribeRecord({ door: '/loans', id: 1 })
    ackFrom(sock, 7, { id: 1 })
    await sub.ready
    sub.unsubscribe()
    const unsub = sock.sent.find(f => f.type === FrameType.UNSUB)
    expect(unsub?.subId).toBe(7)
    sock.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title'], v: [5], r: [[1, 'late']] } } }),
    }))
    expect(store.get('loans', 1)).toBeUndefined()
  })

  it('reauth mints a FRESH one-time token and resolves the server verdict', async () => {
    const { transport, mintToken } = boot()
    const sock = await openSocket()
    const verdict = transport.reauth()
    await tick()
    expect(mintToken).toHaveBeenCalledTimes(2)                // dial + reauth: never reused
    const frame = sock.sent.find(f => f.type === FrameType.REAUTH)!
    expect((frame.body as any).token).toBe('tok-2')
    sock.receive(encodeFrame({ type: FrameType.REAUTH, body: { ref: (frame.body as any).ref, ok: true } }))
    await expect(verdict).resolves.toBe(true)
  })

  it('close() severs and never reconnects', async () => {
    const { transport } = boot()
    await openSocket()
    transport.close()
    expect(transport.status()).toBe('closed')
    await sleep(5)
    expect(FakeSocket.instances.length).toBe(1)
  })
})

// ── Reconnect ───────────────────────────────────────────────────────────────

describe('reconnect', () => {
  it('backs off, mints a NEW token, re-SUBs with recomputed cursors, force-revalidates mounts, fires onReconnect', async () => {
    vi.useFakeTimers()
    const onReconnect = vi.fn()
    const { transport, store, mintToken } = boot({ random: () => 1, onReconnect })
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    await vi.advanceTimersByTimeAsync(0)
    const sock0 = FakeSocket.instances[0]!
    sock0.open()
    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec() })
    ackFrom(sock0, 7, { id: 1, cursor: 5 })
    const mountValidate = vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 5 }))
    transport.registerMount(makeSpec({ validate: mountValidate as any }), 1)

    // Truth advanced while connected; then the socket dies abnormally.
    sock0.receive(encodeFrame({
      type: FrameType.CHANGE, subId: 7, epoch: 1, body: {},
      payload: payloadOf({ entities: { loans: { k: ['id', 'title', 'stage'], v: [6], r: [[1, 'b', 1]] } } }),
    }))
    sock0.serverClose(1006)
    expect(transport.status()).toBe('connecting')

    // Full-jitter backoff, attempt 1: exactly minBackoffMs with random()=1.
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeSocket.instances.length).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(FakeSocket.instances.length).toBe(2)
    expect(mintToken).toHaveBeenCalledTimes(2)                // a NEW single-use token
    const sock1 = FakeSocket.instances[1]!
    expect(sock1.url).toContain('token=tok-2')
    sock1.open()

    // Re-SUB with the RECOMPUTED cursor (the CHANGE advanced it to 6).
    const resub = sock1.sent.find(f => f.type === FrameType.SUB)!
    expect(resub.body).toMatchObject({ door: '/loans', id: 1, cursor: 6, projId: 'proj-loans-1' })
    // The gap is the rumor: the mount registry revalidates FORCED.
    await vi.advanceTimersByTimeAsync(0)
    expect(mountValidate).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('reconnect fan-out covers EVERY sub and EVERY mount — 2 record subs, 1 index sub, 2 mounts', async () => {
    vi.useFakeTimers()
    const { transport, store } = boot({ random: () => 1 })
    store.merge('loans', 1, { id: 1, title: 'a', stage: 0 }, { version: 5 })
    store.merge('loans', 2, { id: 2, title: 'b', stage: 0 }, { version: 3 })
    await vi.advanceTimersByTimeAsync(0)
    const sock0 = FakeSocket.instances[0]!
    sock0.open()

    transport.subscribeRecord({ door: '/loans', id: 1, validator: makeSpec() })
    transport.subscribeRecord({ door: '/loans', id: 2, validator: makeSpec() })
    const onTag = vi.fn()
    transport.subscribeIndex({ door: '/loans', onTag })
    const acks = sock0.sent.filter(f => f.type === FrameType.SUB)
    expect(acks).toHaveLength(3)
    // Ack all three (record subs 11/12, index 13 with tag 10).
    for (const [i, sub] of acks.entries()) {
      const body = sub.body as any
      sock0.receive(encodeFrame({
        type: FrameType.SUB_ACK, subId: 11 + i, epoch: 1,
        body: body.id !== undefined
          ? { ref: body.ref, ok: true, door: body.door, id: body.id }
          : { ref: body.ref, ok: true, door: body.door, cursor: 10 },
      }))
    }
    const mv1 = vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 5 }))
    const mv2 = vi.fn(async (): Promise<ValidateResponse> => ({ status: 'fresh', v: 3 }))
    transport.registerMount(makeSpec({ validate: mv1 as any }), 1)
    transport.registerMount(makeSpec({ validate: mv2 as any }), 2)

    // Sever; reconnect.
    sock0.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1_001)
    const sock1 = FakeSocket.instances[1]!
    sock1.open()

    // EVERY sub re-SUBs (the "only the first entry" mutant dies here) with
    // its recomputed cursor.
    const resubs = sock1.sent.filter(f => f.type === FrameType.SUB).map(f => f.body as any)
    expect(resubs).toHaveLength(3)
    expect(resubs.filter(b => b.id !== undefined).map(b => [b.id, b.cursor]).sort())
      .toEqual([[1, 5], [2, 3]])
    const idxResub = resubs.find(b => b.id === undefined)!
    expect(idxResub.cursor).toBe(10)                          // the last known tag rides

    // EVERY mount force-revalidates.
    await vi.advanceTimersByTimeAsync(0)
    expect(mv1).toHaveBeenCalledTimes(1)
    expect(mv2).toHaveBeenCalledTimes(1)

    // Index re-ack at an EQUAL tag still fires onTag: across a gap,
    // tag-equality is not consumed as a skip (O5's v1 license — value
    // writes crossing arbitrary filters never bump the tag).
    sock1.receive(encodeFrame({
      type: FrameType.SUB_ACK, subId: 21, epoch: 1,
      body: { ref: idxResub.ref, ok: true, door: '/loans', cursor: 10 },
    }))
    expect(onTag).toHaveBeenCalledExactlyOnceWith(10)
  })

  it('backpressure sever (1013) reconnects on the short jittered delay', async () => {
    vi.useFakeTimers()
    boot({ random: () => 1 })
    await vi.advanceTimersByTimeAsync(0)
    const sock0 = FakeSocket.instances[0]!
    sock0.open()
    sock0.serverClose(1013)
    // 1000 + random()*2000 = 3000ms with random()=1 — no reconnect before it.
    await vi.advanceTimersByTimeAsync(2_999)
    expect(FakeSocket.instances.length).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(FakeSocket.instances.length).toBe(2)
  })

  it('reauth resolves false when the mint fails and when the server refuses (old ctx kept server-side)', async () => {
    let failMint = false
    let minted = 0
    const { transport } = boot({
      mintToken: () => {
        if (failMint) throw new Error('mint down')
        return `tok-${++minted}`
      },
    })
    const sock = await openSocket()

    failMint = true
    await expect(transport.reauth()).resolves.toBe(false)     // mint failure: no frame sent
    expect(sock.sent.filter(f => f.type === FrameType.REAUTH)).toHaveLength(0)

    failMint = false
    const verdict = transport.reauth()
    await tick()
    const frame = sock.sent.find(f => f.type === FrameType.REAUTH)!
    sock.receive(encodeFrame({ type: FrameType.REAUTH, body: { ref: (frame.body as any).ref, ok: false } }))
    await expect(verdict).resolves.toBe(false)                // the server's refusal verdict
  })

  it('drain (1001) reconnects fast — jitter only, no backoff ladder', async () => {
    vi.useFakeTimers()
    boot({ random: () => 1 })
    await vi.advanceTimersByTimeAsync(0)
    const sock0 = FakeSocket.instances[0]!
    sock0.open()
    sock0.serverClose(1001)
    await vi.advanceTimersByTimeAsync(501)                    // random()*500, never the 1s ladder
    expect(FakeSocket.instances.length).toBe(2)
  })

  it('heartbeat PINGs each interval; two missed PONGs sever; a PONG resets the count', async () => {
    vi.useFakeTimers()
    boot({ random: () => 1, heartbeatMs: 25_000 })
    await vi.advanceTimersByTimeAsync(0)
    const sock = FakeSocket.instances[0]!
    sock.open()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(sock.sent.filter(f => f.type === FrameType.PING).length).toBe(1)
    sock.receive(encodeFrame({ type: FrameType.PONG, body: {} }))  // answered: counter resets
    await vi.advanceTimersByTimeAsync(50_000)                 // two more unanswered PINGs
    expect(sock.sent.filter(f => f.type === FrameType.PING).length).toBe(3)
    expect(sock.readyState).not.toBe(3)                       // still presumed alive
    await vi.advanceTimersByTimeAsync(25_000)                 // third tick: 2 missed ⇒ sever
    expect(sock.readyState).toBe(3)
    await vi.advanceTimersByTimeAsync(1_001)                  // …and the reconnect path takes over
    expect(FakeSocket.instances.length).toBe(2)
  })
})
