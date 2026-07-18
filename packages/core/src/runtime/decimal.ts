/**
 * Exact decimal-string arithmetic for the Attr cast layer.
 *
 * Binary floats cannot represent most decimal fractions, so every cast that
 * multiplies or divides by a power of ten (money ×100, percent ÷100) drifts:
 * `8.165 * 100` is `816.4999…`, `0.153 * 100` is `15.2999…`. These helpers
 * do the scaling on DECIMAL STRINGS instead — moving a decimal point in a
 * string is exact at any magnitude — with BigInt for the integer rounding
 * step. `String(n)` is the shortest representation that round-trips to the
 * same double, so number → string → shift → number recovers the decimal the
 * user actually typed.
 */

const PLAIN_DECIMAL_RE = /^([+-]?)(\d+)?(?:\.(\d*))?$/
const EXPONENT_RE = /^([+-]?)(\d+)?(?:\.(\d*))?[eE]([+-]?\d+)$/

interface DecimalParts {
  negative: boolean
  /** Integer digits, no sign, may be '' */
  int: string
  /** Fraction digits, no point, may be '' */
  frac: string
}

/** Parses a decimal literal (plain or exponent form) into exact parts. */
/**
 * Exponent expansion pads with `'0'.repeat(|exp|)` — an attacker-supplied
 * '1e999999999' would allocate a gigabyte of zeros. PG numeric itself tops
 * out at 131072 integer digits, so anything past this cap can't be stored
 * anyway; treat it as not-a-decimal.
 */
const MAX_EXPONENT = 131_072

function parseDecimal(s: string): DecimalParts | null {
  let m = PLAIN_DECIMAL_RE.exec(s)
  let exp = 0
  if (!m) {
    m = EXPONENT_RE.exec(s)
    if (!m) return null
    exp = parseInt(m[4]!, 10)
    if (!Number.isFinite(exp) || Math.abs(exp) > MAX_EXPONENT) return null
  }
  const [, sign, int = '', frac = ''] = m
  if (int === '' && frac === '') return null // '.', '+', '-', 'e5'
  const parts: DecimalParts = { negative: sign === '-', int, frac }
  return exp === 0 ? parts : shiftParts(parts, exp)
}

/** Moves the decimal point of parsed parts by `shift` places (×10^shift). */
function shiftParts(parts: DecimalParts, shift: number): DecimalParts {
  const digits = parts.int + parts.frac
  let point = parts.int.length + shift
  let padded = digits
  if (point < 0) {
    padded = '0'.repeat(-point) + padded
    point = 0
  } else if (point > padded.length) {
    padded = padded + '0'.repeat(point - padded.length)
  }
  return { negative: parts.negative, int: padded.slice(0, point), frac: padded.slice(point) }
}

/** Canonical string from parts: no leading/trailing zero noise, '-0' → '0'. */
function formatParts(parts: DecimalParts): string {
  const int = parts.int.replace(/^0+(?=\d)/, '') || '0'
  const frac = parts.frac.replace(/0+$/, '')
  const body = frac === '' ? int : `${int}.${frac}`
  return parts.negative && body !== '0' ? `-${body}` : body
}

/** Is `s` a decimal literal we can handle exactly (plain or exponent form)? */
export function isDecimalString(s: string): boolean {
  return parseDecimal(s) !== null
}

/**
 * The shortest exact decimal string for a finite number; null for NaN/±∞.
 * Exponent forms (`1e21`, `1e-7`) are expanded to plain notation.
 */
export function numberToDecimalString(n: number): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const parts = parseDecimal(String(n))
  return parts === null ? null : formatParts(parts)
}

/**
 * Multiplies a decimal string by 10^shift, exactly.
 * `shiftDecimalString('0.153', 2)` → `'15.3'`. Null for non-decimal input.
 */
export function shiftDecimalString(s: string, shift: number): string | null {
  const parts = parseDecimal(s.trim())
  return parts === null ? null : formatParts(shiftParts(parts, shift))
}

/**
 * Rounds a decimal string to an integer BigInt, half away from zero
 * (the money convention: 0.5 cents rounds up, -0.5 rounds to -1).
 */
export function decimalStringToBigInt(s: string): bigint | null {
  const parts = parseDecimal(s.trim())
  if (parts === null) return null
  let n = BigInt(parts.int || '0')
  if (parts.frac !== '' && parts.frac[0]! >= '5') n += 1n
  return parts.negative ? -n : n
}

/**
 * One-shot exact scaled-integer conversion:
 * `decimalToScaledBigInt('8.165', 2)` → `817n` (dollars → cents, correctly).
 */
export function decimalToScaledBigInt(s: string, scale: number): bigint | null {
  const shifted = shiftDecimalString(s, scale)
  return shifted === null ? null : decimalStringToBigInt(shifted)
}

/**
 * Exact power-of-ten scaling returning a JS number.
 * Accepts a number or decimal string; anything non-numeric → null (never NaN).
 * `scaleExact(0.153, 2)` → `15.3` — not `15.299999999999999`.
 */
export function scaleExact(val: number | string, shift: number): number | null {
  const s = typeof val === 'number'
    ? numberToDecimalString(val)
    : typeof val === 'string' ? val : null
  if (s === null) return null
  const shifted = shiftDecimalString(s, shift)
  if (shifted === null) return null
  const n = Number(shifted)
  return Number.isFinite(n) ? n : null
}

/**
 * The NaN→null coercion policy shared by the lenient numeric attrs:
 * null/undefined, '', whitespace, unparseable strings, NaN and ±∞ all → null.
 * Booleans and objects are not numbers → null. A number comes out finite or
 * not at all — NaN can never enter the record.
 */
export function toFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null
  if (typeof val === 'bigint') {
    const n = Number(val)
    return Number.isFinite(n) ? n : null
  }
  if (typeof val === 'string') {
    const t = val.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Canonical integer string: optional sign + digits only ('12', '-3'). */
const CANONICAL_INT_RE = /^[+-]?\d+$/

/**
 * Strict integer coercion for Attr.int / Attr.bps / Attr.days:
 * - null/undefined/''/whitespace → null (Ruby-style blank → nil)
 * - NaN / ±∞ → null (NaN is never a value)
 * - canonical integer strings ('12', '-3') → number; '0x1F', '1e3', '3.5' throw
 * - finite non-integer or unsafe-range numbers throw
 */
export function toStrictInt(val: unknown, label: string): number | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'number') {
    if (Number.isNaN(val)) return null
    if (!Number.isSafeInteger(val)) {
      throw new TypeError(`${label}: ${JSON.stringify(val)} is not a safe integer`)
    }
    return val === 0 ? 0 : val // normalize -0 → 0
  }
  if (typeof val === 'string') {
    const t = val.trim()
    if (t === '') return null
    if (!CANONICAL_INT_RE.test(t)) {
      throw new TypeError(`${label}: ${JSON.stringify(val)} is not a safe integer`)
    }
    const n = Number(t)
    if (!Number.isSafeInteger(n)) {
      throw new TypeError(`${label}: ${JSON.stringify(val)} is not a safe integer`)
    }
    return n === 0 ? 0 : n
  }
  throw new TypeError(`${label}: ${JSON.stringify(val)} is not a safe integer`)
}

// ── Postgres integer column bounds ─────────────────────────────────────────
// For explicit `min`/`max` bounds on numeric attrs backed by PG int columns.

export const PG_INT2_MIN = -32_768
export const PG_INT2_MAX = 32_767
export const PG_INT4_MIN = -2_147_483_648
export const PG_INT4_MAX = 2_147_483_647
/** int8 exceeds Number.MAX_SAFE_INTEGER — exposed as BigInt. */
export const PG_INT8_MIN = -9_223_372_036_854_775_808n
export const PG_INT8_MAX = 9_223_372_036_854_775_807n
