/**
 * The frame codec — transport WS4, Appendix A (as refined 2026-08-27).
 *
 * ISOMORPHIC and zero-drizzle: this module is the `@active-drizzle/core/frames`
 * subpath export, the ONE codec both the server gateway and the browser client
 * import (duplicating it into react is a review blocker — one wire, one codec).
 * Only dependency: @msgpack/msgpack (~30KB, control bodies only).
 *
 * Every frame:
 *
 *   byte  0        type      (FrameType below)
 *   bytes 1–4      subId     uint32BE — server-interned per-connection
 *                            subscription integer, assigned at SUB_ACK
 *                            (0 = connection-level: SUB/PING/PONG/REAUTH)
 *   bytes 5–8      epoch     uint32BE — per-(connection, subscription)
 *                            generation (O16); 0 where not applicable
 *   bytes 9–12     bodyLen   uint32BE
 *   bytes 13…      body      msgpack control body (bodyLen bytes)
 *   bytes 13+bodyLen…        raw payload to EOF (CHANGE — and later DOC — only)
 *
 * WHY a FIXED 9-byte header instead of Appendix A's original varint channelId:
 * the epoch filter (landmine 11) must drop pre-epoch frames BEFORE parsing any
 * body — `peekHeader` is a fixed-offset 9-byte read, no allocation, no msgpack.
 * Channel STRINGS travel only inside SUB/SUB_ACK bodies; data frames carry the
 * interned integer.
 *
 * CHANGE payload (the A0 decision): the raw UTF-8 JSON BYTES of a partial
 * ColumnarEnvelope — `{ entities: { <table>: { k, v, r } }, touched? }` —
 * exactly as buildColumnarEnvelope emits it. The serializer is TEXT JSON, so
 * "byte-compatible with GET/validation slices" means those JSON bytes framed
 * inside this binary envelope; the client decodes with JSON.parse → the same
 * mergeEnvelope that decodes every GET/validate response. Destroys are CHANGE
 * frames whose payload is `{ touched: [{resource, id, op:'destroy', version}] }`.
 *
 * EPOCH DOCTRINE (O16): epoch is per-connection subscription state stamped at
 * socket-write time by the serving node. It NEVER rides the bus — a bus
 * payload carrying an epoch is a design bug, not an optimization.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'

// ── Frame types ─────────────────────────────────────────────────────────────

export const FrameType = {
  SUB: 1,
  UNSUB: 2,
  SUB_ACK: 3,
  CHANGE: 4,
  /** Reserved for WS5 (doc lane). Encoding/decoding one today throws. */
  DOC: 5,
  /** Reserved (not v1). Encoding/decoding one today throws. */
  PRESENCE: 6,
  PING: 7,
  PONG: 8,
  RESET: 9,
  REAUTH: 10,
  SIGNAL: 11,
} as const

export type FrameTypeName = keyof typeof FrameType
export type FrameTypeValue = (typeof FrameType)[FrameTypeName]

const TYPE_NAMES: Record<number, FrameTypeName> = Object.fromEntries(
  Object.entries(FrameType).map(([k, v]) => [v, k as FrameTypeName]),
)

/** Frame types whose raw tail payload is legal (v1: CHANGE; DOC reserved). */
const PAYLOAD_TYPES = new Set<number>([FrameType.CHANGE])
const RESERVED_TYPES = new Set<number>([FrameType.DOC, FrameType.PRESENCE])

export const FRAME_HEADER_BYTES = 9
const LEN_PREFIX_BYTES = 4

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface FrameHeader {
  type: FrameTypeValue
  subId: number
  epoch: number
}

export interface Frame extends FrameHeader {
  /** msgpack-decoded control body ({} when the frame carried none). */
  body: Record<string, unknown>
  /** Raw tail bytes (CHANGE: the columnar-slice JSON bytes). Empty otherwise. */
  payload: Uint8Array
}

export interface EncodeFrameInput {
  type: FrameTypeValue
  subId?: number
  epoch?: number
  body?: Record<string, unknown>
  /** Raw tail — only legal on CHANGE (DOC when WS5 lands). */
  payload?: Uint8Array
}

// ── Teaching refusals ───────────────────────────────────────────────────────

function reservedTypeError(type: number): Error {
  return new Error(
    `[active-drizzle] frame codec: frame type ${TYPE_NAMES[type]} (${type}) is RESERVED — ` +
    `${type === FrameType.DOC ? 'the doc lane ships in transport WS5' : 'presence is not part of v1'}. ` +
    `The type id is allocated so the wire never renumbers; encoding it today is a version skew ` +
    `bug, not a feature.`,
  )
}

// ── Encode ──────────────────────────────────────────────────────────────────

const EMPTY = new Uint8Array(0)

export function encodeFrame(input: EncodeFrameInput): Uint8Array {
  const { type } = input
  if (!TYPE_NAMES[type]) throw new Error(`[active-drizzle] frame codec: unknown frame type ${type}`)
  if (RESERVED_TYPES.has(type)) throw reservedTypeError(type)
  const subId = input.subId ?? 0
  const epoch = input.epoch ?? 0
  if (!Number.isInteger(subId) || subId < 0 || subId > 0xffffffff) {
    throw new Error(`[active-drizzle] frame codec: subId ${subId} does not fit uint32`)
  }
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) {
    throw new Error(`[active-drizzle] frame codec: epoch ${epoch} does not fit uint32`)
  }
  const payload = input.payload ?? EMPTY
  if (payload.length > 0 && !PAYLOAD_TYPES.has(type)) {
    throw new Error(
      `[active-drizzle] frame codec: a raw payload tail is only legal on CHANGE frames ` +
      `(got ${TYPE_NAMES[type]}). Control data belongs in the msgpack body.`,
    )
  }
  const body = msgpackEncode(input.body ?? {})
  const out = new Uint8Array(FRAME_HEADER_BYTES + LEN_PREFIX_BYTES + body.length + payload.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  out[0] = type
  view.setUint32(1, subId, false)
  view.setUint32(5, epoch, false)
  view.setUint32(FRAME_HEADER_BYTES, body.length, false)
  out.set(body, FRAME_HEADER_BYTES + LEN_PREFIX_BYTES)
  out.set(payload, FRAME_HEADER_BYTES + LEN_PREFIX_BYTES + body.length)
  return out
}

// ── Peek (the 9-byte epoch filter — NO body parse, NO allocation) ───────────

/**
 * Read only the fixed header. This is the pre-parse epoch gate (landmine 11):
 * a data frame whose epoch < current(subId) must be dropped from THIS read
 * alone, before any msgpack/JSON touches the bytes.
 */
export function peekHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < FRAME_HEADER_BYTES) {
    throw new Error(`[active-drizzle] frame codec: ${bytes.length} bytes is shorter than the 9-byte header`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = bytes[0]! as FrameTypeValue
  if (!TYPE_NAMES[type]) throw new Error(`[active-drizzle] frame codec: unknown frame type ${bytes[0]}`)
  return { type, subId: view.getUint32(1, false), epoch: view.getUint32(5, false) }
}

// ── Decode ──────────────────────────────────────────────────────────────────

export function decodeFrame(bytes: Uint8Array): Frame {
  const header = peekHeader(bytes)
  if (RESERVED_TYPES.has(header.type)) throw reservedTypeError(header.type)
  if (bytes.length < FRAME_HEADER_BYTES + LEN_PREFIX_BYTES) {
    throw new Error(`[active-drizzle] frame codec: frame truncated before the body length prefix`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bodyLen = view.getUint32(FRAME_HEADER_BYTES, false)
  const bodyStart = FRAME_HEADER_BYTES + LEN_PREFIX_BYTES
  if (bytes.length < bodyStart + bodyLen) {
    throw new Error(
      `[active-drizzle] frame codec: body length prefix says ${bodyLen} bytes but only ` +
      `${bytes.length - bodyStart} remain — truncated or corrupt frame`,
    )
  }
  const body = bodyLen === 0
    ? {}
    : msgpackDecode(bytes.subarray(bodyStart, bodyStart + bodyLen)) as Record<string, unknown>
  const payload = bytes.subarray(bodyStart + bodyLen)
  if (payload.length > 0 && !PAYLOAD_TYPES.has(header.type)) {
    throw new Error(
      `[active-drizzle] frame codec: trailing bytes after the body on a ${TYPE_NAMES[header.type]} ` +
      `frame — only CHANGE frames carry a raw payload tail`,
    )
  }
  return { ...header, body: body ?? {}, payload }
}

/** Human name of a frame type (logs, teaching errors). */
export function frameTypeName(type: number): string {
  return TYPE_NAMES[type] ?? `unknown(${type})`
}
