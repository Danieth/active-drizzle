/**
 * Rails ActiveSupport-style number helpers.
 */

// ── Ordinals ─────────────────────────────────────────────────────────────────

/** 1 → 'st', 2 → 'nd', 11 → 'th'. Rails' `ordinal`. */
export function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n))
  if (abs % 100 >= 11 && abs % 100 <= 13) return 'th'
  switch (abs % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

/** 1 → '1st', 22 → '22nd'. Rails' `ordinalize`. */
export function ordinalize(n: number): string {
  return `${n}${ordinal(n)}`
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** 1234567.89 → '1,234,567.89'. Rails' `number_with_delimiter`. */
export function numberWithDelimiter(n: number, delimiter = ',', separator = '.'): string {
  const [int, frac] = String(n).split('.')
  const withDelim = int!.replace(/\B(?=(\d{3})+(?!\d))/g, delimiter)
  return frac !== undefined ? withDelim + separator + frac : withDelim
}

/** 1234.5 → '$1,234.50'. Rails' `number_to_currency` (simplified). */
export function numberToCurrency(
  n: number,
  opts: { unit?: string; precision?: number; delimiter?: string; separator?: string } = {}
): string {
  const { unit = '$', precision = 2, delimiter = ',', separator = '.' } = opts
  const sign = n < 0 ? '-' : ''
  const fixed = Math.abs(n).toFixed(precision)
  const [int, frac] = fixed.split('.')
  const withDelim = int!.replace(/\B(?=(\d{3})+(?!\d))/g, delimiter)
  return sign + unit + (frac !== undefined ? withDelim + separator + frac : withDelim)
}

/** 0.153 (with precision 1) → '15.3%'. Rails' `number_to_percentage` (takes 0-100 value). */
export function numberToPercentage(n: number, precision = 3): string {
  const fixed = n.toFixed(precision)
  // Strip trailing zeros only in the fractional part
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
  return `${trimmed || '0'}%`
}

/** 1234567 → '1.2 MB'. Rails' `number_to_human_size`. */
export function numberToHumanSize(bytes: number, precision = 1): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  if (bytes === 0) return '0 bytes'
  if (Math.abs(bytes) < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  let value = Math.abs(bytes)
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const sign = bytes < 0 ? '-' : ''
  return `${sign}${value.toFixed(precision).replace(/\.0+$/, '')} ${units[i]}`
}

/** 1234567 → '1.2 Million'. Rails' `number_to_human` (simplified). */
export function numberToHuman(n: number, precision = 1): string {
  const units: Array<[number, string]> = [
    [1e15, 'Quadrillion'],
    [1e12, 'Trillion'],
    [1e9, 'Billion'],
    [1e6, 'Million'],
    [1e3, 'Thousand'],
  ]
  const abs = Math.abs(n)
  for (const [threshold, label] of units) {
    if (abs >= threshold) {
      const value = (n / threshold).toFixed(precision).replace(/\.0+$/, '')
      return `${value} ${label}`
    }
  }
  return String(n)
}

// ── Clamping / predicates ────────────────────────────────────────────────────

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

/** Rails' `Integer#multiple_of?`. */
export function isMultipleOf(n: number, divisor: number): boolean {
  if (divisor === 0) return n === 0
  return n % divisor === 0
}

export function isEven(n: number): boolean { return n % 2 === 0 }
export function isOdd(n: number): boolean { return Math.abs(n % 2) === 1 }

/** Rails' `Float#round(n)` with digits — banker's-free simple rounding. */
export function roundTo(n: number, digits = 0): number {
  const factor = 10 ** digits
  return Math.round((n + Number.EPSILON) * factor) / factor
}

/** `percentOf(25, 200)` → 12.5. ActiveSupport-inspired convenience. */
export function percentOf(part: number, whole: number): number {
  if (whole === 0) return 0
  return (part / whole) * 100
}

// ── Byte sizes (Rails' 2.megabytes etc.) ─────────────────────────────────────

export const kilobytes = (n: number): number => n * 1024
export const megabytes = (n: number): number => n * 1024 ** 2
export const gigabytes = (n: number): number => n * 1024 ** 3
export const terabytes = (n: number): number => n * 1024 ** 4

// ── Durations (milliseconds, for setTimeout etc.) ────────────────────────────

export const seconds = (n: number): number => n * 1000
export const minutes = (n: number): number => n * 60_000
export const hours   = (n: number): number => n * 3_600_000
export const days    = (n: number): number => n * 86_400_000
export const weeks   = (n: number): number => n * 604_800_000

/** `fromNow(minutes(5))` → Date 5 minutes in the future. */
export function fromNow(ms: number): Date {
  return new Date(Date.now() + ms)
}

/** `ago(hours(2))` → Date 2 hours in the past. */
export function ago(ms: number): Date {
  return new Date(Date.now() - ms)
}
