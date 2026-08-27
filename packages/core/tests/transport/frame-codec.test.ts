/**
 * Frame codec — transport WS4, Appendix A (fixed 9-byte header refinement).
 *
 * Pins: round-trip of every v1 type; the header peek at FIXED offsets with
 * no body parse; reserved-type teaching refusals (DOC/PRESENCE); the CHANGE
 * slice tail passing through BYTE-IDENTICAL (A0 — the columnar JSON bytes
 * framed raw); payload-on-control-frame refusal; uint32 bounds.
 */
import { describe, it, expect } from 'vitest'
import {
  FrameType, encodeFrame, decodeFrame, peekHeader, frameTypeName,
  FRAME_HEADER_BYTES,
} from '../../src/transport/frame-codec.js'

const V1_TYPES = [
  FrameType.SUB, FrameType.UNSUB, FrameType.SUB_ACK, FrameType.CHANGE,
  FrameType.PING, FrameType.PONG, FrameType.RESET, FrameType.REAUTH,
  FrameType.SIGNAL,
] as const

describe('round-trips', () => {
  it('every v1 frame type survives encode → decode', () => {
    for (const type of V1_TYPES) {
      const body = { ref: 7, door: '/loans', nested: { a: [1, 2, 3] } }
      const payload = type === FrameType.CHANGE ? new TextEncoder().encode('{"entities":{}}') : undefined
      const input: any = { type, subId: 42, epoch: 3, body }
      if (payload) input.payload = payload
      const frame = decodeFrame(encodeFrame(input))
      expect(frame.type).toBe(type)
      expect(frame.subId).toBe(42)
      expect(frame.epoch).toBe(3)
      expect(frame.body).toEqual(body)
      expect(new TextDecoder().decode(frame.payload)).toBe(payload ? '{"entities":{}}' : '')
    }
  })

  it('an empty body decodes to {} and defaults subId/epoch to 0', () => {
    const frame = decodeFrame(encodeFrame({ type: FrameType.PING }))
    expect(frame).toMatchObject({ type: FrameType.PING, subId: 0, epoch: 0, body: {} })
  })
})

describe('the 9-byte peek (the pre-parse epoch gate)', () => {
  it('reads type/subId/epoch at fixed offsets', () => {
    const bytes = encodeFrame({ type: FrameType.CHANGE, subId: 0xdeadbeef, epoch: 0x01020304, payload: new Uint8Array([1]) })
    expect(peekHeader(bytes)).toEqual({ type: FrameType.CHANGE, subId: 0xdeadbeef, epoch: 0x01020304 })
    // The offsets are LAW: byte 0 type, 1–4 subId BE, 5–8 epoch BE.
    expect(bytes[0]).toBe(FrameType.CHANGE)
    expect([...bytes.slice(1, 5)]).toEqual([0xde, 0xad, 0xbe, 0xef])
    expect([...bytes.slice(5, 9)]).toEqual([0x01, 0x02, 0x03, 0x04])
    expect(FRAME_HEADER_BYTES).toBe(9)
  })

  it('peek works on JUST the 9 header bytes — no body needed', () => {
    const bytes = encodeFrame({ type: FrameType.SIGNAL, subId: 5, epoch: 9, body: { tag: 3 } })
    expect(peekHeader(bytes.slice(0, 9))).toEqual({ type: FrameType.SIGNAL, subId: 5, epoch: 9 })
    expect(() => peekHeader(bytes.slice(0, 8))).toThrow(/9-byte header/)
  })

  it('peek survives a CORRUPT body (the epoch drop must precede any parse)', () => {
    const bytes = encodeFrame({ type: FrameType.CHANGE, subId: 1, epoch: 2, body: { x: 1 } })
    bytes[13] = 0xc1        // never-used msgpack byte — body is now garbage
    expect(peekHeader(bytes)).toEqual({ type: FrameType.CHANGE, subId: 1, epoch: 2 })
    expect(() => decodeFrame(bytes)).toThrow()
  })
})

describe('reserved types teach', () => {
  it.each([[FrameType.DOC, 'WS5'], [FrameType.PRESENCE, 'v1']])('type %s refuses with the reason', (type, hint) => {
    expect(() => encodeFrame({ type: type as any })).toThrow(new RegExp(`RESERVED[\\s\\S]*${hint}`))
    const forged = encodeFrame({ type: FrameType.PING })
    forged[0] = type as number
    expect(() => decodeFrame(forged)).toThrow(/RESERVED/)
    expect(peekHeader(forged).type).toBe(type)   // the peek still identifies it
  })
})

describe('the CHANGE slice tail (A0)', () => {
  it('passes through byte-identical — the serializer bytes ARE the payload', () => {
    const slice = new TextEncoder().encode(JSON.stringify({
      entities: { loans: { k: ['id', 'title'], v: [3], r: [[1, 'hello']] } },
      touched: [{ resource: 'loans', id: 9, op: 'destroy', version: 4 }],
    }))
    const frame = decodeFrame(encodeFrame({ type: FrameType.CHANGE, subId: 1, epoch: 1, payload: slice }))
    expect([...frame.payload]).toEqual([...slice])
    expect(JSON.parse(new TextDecoder().decode(frame.payload)).entities.loans.k).toEqual(['id', 'title'])
  })

  it('refuses a payload tail on control frames — both directions', () => {
    expect(() => encodeFrame({ type: FrameType.SIGNAL, payload: new Uint8Array([1]) }))
      .toThrow(/only legal on CHANGE/)
    const change = encodeFrame({ type: FrameType.CHANGE, payload: new Uint8Array([1, 2]) })
    change[0] = FrameType.SIGNAL
    expect(() => decodeFrame(change)).toThrow(/trailing bytes/)
  })
})

describe('bounds', () => {
  it('subId/epoch must fit uint32', () => {
    expect(() => encodeFrame({ type: FrameType.PING, subId: 2 ** 32 })).toThrow(/uint32/)
    expect(() => encodeFrame({ type: FrameType.PING, epoch: -1 })).toThrow(/uint32/)
    const max = decodeFrame(encodeFrame({ type: FrameType.PING, subId: 0xffffffff, epoch: 0xffffffff }))
    expect(max.subId).toBe(0xffffffff)
    expect(max.epoch).toBe(0xffffffff)
  })

  it('a truncated frame teaches instead of misreading', () => {
    const bytes = encodeFrame({ type: FrameType.SUB, body: { door: '/loans' } })
    expect(() => decodeFrame(bytes.slice(0, 15))).toThrow(/truncated|remain/)
    expect(frameTypeName(FrameType.SUB)).toBe('SUB')
  })
})
