/**
 * Branded numeric types — compile-time guarantees stronger than `number`.
 *
 * TypeScript has no built-in integer type; we get one with "branding": `Int`
 * is a `number` carrying a phantom marker that only the `int()` smart
 * constructor (which runtime-validates) can produce. You cannot pass a plain
 * `number` where an `Int` is required — the compiler rejects it — so every
 * `Int` in the program provably went through `Number.isInteger`.
 *
 *   function take(n: Int) {}
 *   take(3)          // ✗ compile error — number is not Int
 *   take(int(3))     // ✓
 *   take(int(3.5))   // ✓ compiles, but int() THROWS at runtime
 *
 * `Cents` is the same idea for money: an integer amount in minor units.
 * Storing money as integer cents (never floats) is the classic correctness
 * rule — 0.1 + 0.2 !== 0.3, but 10 + 20 === 30.
 */

declare const IntBrand: unique symbol
declare const CentsBrand: unique symbol

/** A number statically guaranteed to have passed Number.isInteger. */
export type Int = number & { readonly [IntBrand]: true }

/** An integer amount of money in minor units (cents). Also an Int. */
export type Cents = number & { readonly [IntBrand]: true; readonly [CentsBrand]: true }

// ── Smart constructors ───────────────────────────────────────────────────────

/** Validates and brands. Throws unless the value is a safe integer. */
export function int(value: number): Int {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`int(): ${value} is not a safe integer`)
  }
  return value as Int
}

/** Non-throwing variant: null when not a safe integer. */
export function toInt(value: unknown): Int | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) ? (n as Int) : null
}

/** Type guard — narrows `number` to `Int` in a conditional. */
export function isInt(value: unknown): value is Int {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** Brands an integer as cents. `cents(1999)` → $19.99 worth. */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`cents(): ${value} is not a safe integer — money must be integer minor units`)
  }
  return value as Cents
}

/**
 * Converts a decimal major-unit amount to Cents, rounding half away from
 * zero at the second decimal: `dollarsToCents(19.99)` → 1999. Throws on
 * NaN/Infinity.
 *
 * The conversion is exact decimal-string math, not `amount * 100`:
 * `8.165 * 100` is `816.4999…` in binary floats, and an epsilon nudge only
 * papers over magnitudes below ~2 (Number.EPSILON is the float gap AT 1).
 * `String(8.165)` is exactly `'8.165'` — the shortest round-trip
 * representation — so shifting THAT string's decimal point never drifts.
 */
export function dollarsToCents(amount: number): Cents {
  if (!Number.isFinite(amount)) throw new TypeError(`dollarsToCents(): ${amount} is not finite`)
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(Math.abs(amount)))
  if (!m) throw new TypeError(`dollarsToCents(): ${amount} is not finite`)
  let digits = m[1]! + (m[2] ?? '')
  let point = m[1]!.length + (m[3] ? parseInt(m[3], 10) : 0) + 2 // ×100
  if (point < 0) {
    digits = '0'.repeat(-point) + digits
    point = 0
  } else if (point > digits.length) {
    digits += '0'.repeat(point - digits.length)
  }
  let c = Number(digits.slice(0, point) || '0')
  if (digits[point] !== undefined && digits[point]! >= '5') c += 1
  return cents(amount < 0 ? -c : c)
}

/** Cents → decimal major units: `centsToDollars(cents(1999))` → 19.99. */
export function centsToDollars(amount: Cents): number {
  return amount / 100
}

// ── Money formatting ─────────────────────────────────────────────────────────

/**
 * Formats integer cents as currency via Intl:
 *   formatMoney(cents(1999))                       // '$19.99'
 *   formatMoney(cents(1999), { currency: 'EUR', locale: 'de-DE' })  // '19,99 €'
 */
export function formatMoney(
  amount: Cents,
  opts: { currency?: string; locale?: string } = {}
): string {
  const { currency = 'USD', locale = 'en-US' } = opts
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency })
  // Scale by the currency's actual minor-unit digits: USD 2 (÷100),
  // JPY 0 (÷1), BHD 3 (÷1000) — Intl knows, so we never hardcode 100.
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
  return fmt.format(amount / 10 ** digits)
}

// ── Safe integer arithmetic ──────────────────────────────────────────────────
// Sums of Ints are Ints (validated — overflow past MAX_SAFE_INTEGER throws).

export function addInt(a: Int, b: Int): Int {
  return int(a + b)
}

export function mulInt(a: Int, b: Int): Int {
  return int(a * b)
}

/**
 * Multiplies cents by a float factor (tax rate, discount) and rounds back
 * to integer cents — the one place float math touches money, contained.
 */
export function mulCents(amount: Cents, factor: number): Cents {
  return cents(Math.round(amount * factor))
}
