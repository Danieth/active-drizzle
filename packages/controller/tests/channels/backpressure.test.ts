/**
 * Backpressure seam — transport WS4. The thresholds and the degrade ladder
 * (ok → soft CHANGE→SIGNAL → hard 1013 sever) are exported pure-ish
 * functions over a minimal socket surface, so the mutants the socket-level
 * suites cannot reach (flipped comparisons, swapped constants, a deleted
 * soft block, a dishonest degraded op) die here — no stalled TCP peer
 * required. bufferedAmount never rises on loopback, which is why the
 * acceptance suite alone could not execute any of this.
 */
import { describe, it, expect } from 'vitest'
import { decodeFrame, FrameType, encodeFrame } from '@active-drizzle/core/frames'
import {
  sendFrameWithBackpressure, sendChangeWithBackpressure,
  SOFT_BUFFERED_BYTES, HARD_BUFFERED_BYTES,
  type BackpressureSocket,
} from '../../src/channels/gateway.js'

class FakeSock implements BackpressureSocket {
  readyState = 1
  bufferedAmount = 0
  sent: Uint8Array[] = []
  closed: { code?: number; reason?: string } | null = null
  send(bytes: Uint8Array): void { this.sent.push(bytes) }
  close(code?: number, reason?: string): void { this.closed = { code, reason } }
  frames() { return this.sent.map(b => decodeFrame(b)) }
}

const META = { subId: 3, epoch: 2, table: 'loans' }
const PAYLOAD = new TextEncoder().encode(JSON.stringify({ entities: {} }))
const TOKENS = [
  { pk: 1, token: 7, op: 'update' },
  { pk: 2, token: 9, op: 'destroy' },
]

describe('sendFrameWithBackpressure (the hard limit)', () => {
  it('sends through an open, drained socket', () => {
    const ws = new FakeSock()
    sendFrameWithBackpressure(ws, encodeFrame({ type: FrameType.PONG, body: {} }))
    expect(ws.sent).toHaveLength(1)
    expect(ws.closed).toBeNull()
  })

  it('drops silently on a non-open socket', () => {
    const ws = new FakeSock()
    ws.readyState = 3
    sendFrameWithBackpressure(ws, encodeFrame({ type: FrameType.PONG, body: {} }))
    expect(ws.sent).toHaveLength(0)
    expect(ws.closed).toBeNull()
  })

  it('severs with 1013 above the HARD limit — and only above it', () => {
    const at = new FakeSock()
    at.bufferedAmount = HARD_BUFFERED_BYTES          // AT the limit: still sends
    sendFrameWithBackpressure(at, encodeFrame({ type: FrameType.PONG, body: {} }))
    expect(at.sent).toHaveLength(1)

    const over = new FakeSock()
    over.bufferedAmount = HARD_BUFFERED_BYTES + 1
    sendFrameWithBackpressure(over, encodeFrame({ type: FrameType.PONG, body: {} }))
    expect(over.sent).toHaveLength(0)
    expect(over.closed).toEqual({ code: 1013, reason: 'backpressure' })
  })
})

describe('sendChangeWithBackpressure (the soft degrade)', () => {
  it('below SOFT: one CHANGE frame carrying the payload at the sub epoch', () => {
    const ws = new FakeSock()
    ws.bufferedAmount = SOFT_BUFFERED_BYTES          // AT the limit: still a CHANGE
    sendChangeWithBackpressure(ws, META, PAYLOAD, TOKENS)
    const frames = ws.frames()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(FrameType.CHANGE)
    expect(frames[0]!.subId).toBe(3)
    expect(frames[0]!.epoch).toBe(2)
    expect(frames[0]!.payload).toEqual(PAYLOAD)
  })

  it('above SOFT: the payload is dropped and each token rides as a SIGNAL with its HONEST op', () => {
    const ws = new FakeSock()
    ws.bufferedAmount = SOFT_BUFFERED_BYTES + 1
    sendChangeWithBackpressure(ws, META, PAYLOAD, TOKENS)
    const frames = ws.frames()
    expect(frames).toHaveLength(2)
    expect(frames.every(f => f.type === FrameType.SIGNAL && f.subId === 3 && f.epoch === 2)).toBe(true)
    expect(frames.map(f => f.body)).toEqual([
      { table: 'loans', pk: 1, token: 7, op: 'update' },
      { table: 'loans', pk: 2, token: 9, op: 'destroy' },   // a degraded destroy stays a destroy
    ])
  })

  it('above HARD: no SIGNALs either — the sever wins', () => {
    const ws = new FakeSock()
    ws.bufferedAmount = HARD_BUFFERED_BYTES + 1
    sendChangeWithBackpressure(ws, META, PAYLOAD, TOKENS)
    expect(ws.sent).toHaveLength(0)
    expect(ws.closed).toEqual({ code: 1013, reason: 'backpressure' })
  })

  it('the ladder is ordered: SOFT < HARD', () => {
    expect(SOFT_BUFFERED_BYTES).toBeLessThan(HARD_BUFFERED_BYTES)
    expect(SOFT_BUFFERED_BYTES).toBe(1024 * 1024)
    expect(HARD_BUFFERED_BYTES).toBe(4 * 1024 * 1024)
  })
})
