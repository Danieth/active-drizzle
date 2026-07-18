import { describe, it, expect } from 'vitest'
import {
  int, toInt, isInt, cents, dollarsToCents, centsToDollars,
  formatMoney, addInt, mulInt, mulCents,
  type Int, type Cents,
} from '../src/types.js'

describe('int()', () => {
  it('brands valid safe integers', () => {
    const n: Int = int(42)
    expect(n).toBe(42)
    expect(int(0)).toBe(0)
    expect(int(-7)).toBe(-7)
    expect(int(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('throws on floats, NaN, Infinity, unsafe integers', () => {
    expect(() => int(3.5)).toThrow(TypeError)
    expect(() => int(NaN)).toThrow(TypeError)
    expect(() => int(Infinity)).toThrow(TypeError)
    expect(() => int(Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
  })

  it('compile-time: plain number is not assignable to Int', () => {
    // @ts-expect-error — number is not Int without the smart constructor
    const bad: Int = 42
    void bad
  })
})

describe('toInt / isInt', () => {
  it('toInt parses strings and rejects garbage as null', () => {
    expect(toInt('42')).toBe(42)
    expect(toInt(7)).toBe(7)
    expect(toInt('3.5')).toBeNull()
    expect(toInt('abc')).toBeNull()
    expect(toInt(null)).toBeNull()
    expect(toInt(1.5)).toBeNull()
  })

  it('isInt narrows', () => {
    const v: unknown = 5
    if (isInt(v)) {
      const n: Int = v // compiles because of the type guard
      expect(n).toBe(5)
    } else {
      throw new Error('should have narrowed')
    }
    expect(isInt(5.5)).toBe(false)
    expect(isInt('5')).toBe(false)
  })
})

describe('cents / dollars conversion', () => {
  it('cents brands integers, rejects floats', () => {
    const c: Cents = cents(1999)
    expect(c).toBe(1999)
    expect(() => cents(19.99)).toThrow(/integer minor units/)
  })

  it('dollarsToCents rounds correctly (the 19.99 float trap)', () => {
    expect(dollarsToCents(19.99)).toBe(1999)
    expect(dollarsToCents(0.1)).toBe(10)
    expect(dollarsToCents(1.005)).toBe(101) // rounds up despite float representation
    expect(() => dollarsToCents(NaN)).toThrow(TypeError)
    expect(() => dollarsToCents(Infinity)).toThrow(TypeError)
  })

  it('centsToDollars', () => {
    expect(centsToDollars(cents(1999))).toBe(19.99)
    expect(centsToDollars(cents(0))).toBe(0)
  })

  it('a Cents value is also an Int', () => {
    const c: Cents = cents(100)
    const asInt: Int = c // Cents extends Int structurally
    expect(asInt).toBe(100)
  })
})

describe('money formatting', () => {
  it('formats USD by default', () => {
    expect(formatMoney(cents(1999))).toBe('$19.99')
    expect(formatMoney(cents(0))).toBe('$0.00')
    expect(formatMoney(cents(-500))).toBe('-$5.00')
    expect(formatMoney(cents(123456789))).toBe('$1,234,567.89')
  })

  it('supports other currencies and locales', () => {
    expect(formatMoney(cents(1999), { currency: 'EUR', locale: 'de-DE' })).toBe('19,99\u00A0€') // Intl uses NBSP
    expect(formatMoney(cents(1999), { currency: 'JPY' })).toBe('¥1,999') // JPY has no minor units
    expect(formatMoney(cents(1999), { currency: 'GBP', locale: 'en-GB' })).toBe('£19.99')
  })
})

describe('safe arithmetic', () => {
  it('addInt / mulInt preserve the brand and validate', () => {
    expect(addInt(int(2), int(3))).toBe(5)
    expect(mulInt(int(4), int(5))).toBe(20)
    expect(() => mulInt(int(Number.MAX_SAFE_INTEGER), int(2))).toThrow(TypeError)
  })

  it('mulCents contains float math and rounds back to integer cents', () => {
    expect(mulCents(cents(1000), 1.08875)).toBe(1089) // NYC tax on $10
    expect(mulCents(cents(1999), 0.5)).toBe(1000) // half-off rounds up from 999.5
  })
})
