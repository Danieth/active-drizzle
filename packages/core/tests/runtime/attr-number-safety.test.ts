/**
 * Number-safety tests — the JS-numerics audit suite.
 *
 * Every case here is a real JavaScript coercion quirk that used to (or could)
 * corrupt data through the Attr cast layer:
 *   - float drift in money/percent scaling (8.165 * 100 === 816.4999…)
 *   - Number('') === 0, Boolean('false') === true
 *   - NaN leaking into columns and poisoning dirty-tracking (NaN !== NaN)
 *   - Object.prototype lookups on enum/state maps ('toString' in {})
 *   - Array.prototype.map forwarding the index (parseInt radix trap)
 *   - reserved dirty-tracking suffixes shadowing real columns
 */

import { describe, it, expect } from 'vitest'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { Attr, rangeIncludes, stateCanFire } from '../../src/runtime/attr.js'
import {
  decimalStringToBigInt,
  decimalToScaledBigInt,
  isDecimalString,
  numberToDecimalString,
  scaleExact,
  shiftDecimalString,
  toFiniteNumber,
  toStrictInt,
  PG_INT4_MAX,
  PG_INT4_MIN,
} from '../../src/runtime/decimal.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'

// ---------------------------------------------------------------------------
// decimal.ts — the exact-arithmetic foundation
// ---------------------------------------------------------------------------

describe('decimal string utilities', () => {
  it('shiftDecimalString moves the point exactly at any magnitude', () => {
    expect(shiftDecimalString('0.153', 2)).toBe('15.3')
    expect(shiftDecimalString('8.165', 2)).toBe('816.5')
    expect(shiftDecimalString('1234567.005', 2)).toBe('123456700.5')
    expect(shiftDecimalString('15.3', -2)).toBe('0.153')
    expect(shiftDecimalString('817', -2)).toBe('8.17')
    expect(shiftDecimalString('5', 0)).toBe('5')
    expect(shiftDecimalString('-8.165', 2)).toBe('-816.5')
  })

  it('canonicalizes without losing digits', () => {
    expect(shiftDecimalString('007.50', 0)).toBe('7.5')
    expect(shiftDecimalString('0.10000000000000000001', 0)).toBe('0.10000000000000000001')
    expect(shiftDecimalString('-0', 0)).toBe('0')
  })

  it('expands exponent notation instead of leaking it', () => {
    expect(numberToDecimalString(1e21)).toBe('1000000000000000000000')
    expect(numberToDecimalString(1e-7)).toBe('0.0000001')
    expect(numberToDecimalString(-2.5e-3)).toBe('-0.0025')
  })

  it('numberToDecimalString is null for NaN and infinities', () => {
    expect(numberToDecimalString(NaN)).toBeNull()
    expect(numberToDecimalString(Infinity)).toBeNull()
    expect(numberToDecimalString(-Infinity)).toBeNull()
  })

  it('rounds half away from zero', () => {
    expect(decimalStringToBigInt('816.5')).toBe(817n)
    expect(decimalStringToBigInt('816.4999')).toBe(816n)
    expect(decimalStringToBigInt('-816.5')).toBe(-817n)
    expect(decimalToScaledBigInt('8.165', 2)).toBe(817n)
    expect(decimalToScaledBigInt('19.994999', 2)).toBe(1999n)
  })

  it('scaleExact never returns NaN', () => {
    expect(scaleExact(0.153, 2)).toBe(15.3)
    expect(scaleExact('abc', 2)).toBeNull()
    expect(scaleExact(NaN, 2)).toBeNull()
    expect(scaleExact('', 2)).toBeNull()
  })

  it('isDecimalString accepts decimals, rejects hex/garbage', () => {
    expect(isDecimalString('12.5')).toBe(true)
    expect(isDecimalString('-0.5')).toBe(true)
    expect(isDecimalString('1e3')).toBe(true)
    expect(isDecimalString('0x1F')).toBe(false)
    expect(isDecimalString('abc')).toBe(false)
    expect(isDecimalString('')).toBe(false)
  })

  it('toFiniteNumber implements the NaN→null policy', () => {
    expect(toFiniteNumber(5)).toBe(5)
    expect(toFiniteNumber('5.5')).toBe(5.5)
    expect(toFiniteNumber(NaN)).toBeNull()
    expect(toFiniteNumber(Infinity)).toBeNull()
    expect(toFiniteNumber('')).toBeNull()
    expect(toFiniteNumber('   ')).toBeNull()
    expect(toFiniteNumber('abc')).toBeNull()
    expect(toFiniteNumber(true)).toBeNull()
    expect(toFiniteNumber([5])).toBeNull()
    expect(toFiniteNumber({})).toBeNull()
    expect(toFiniteNumber(9007199254740992n)).toBe(9007199254740992)
  })

  it('toStrictInt: canonical integers only, blank → null, NaN → null', () => {
    expect(toStrictInt('12', 'x')).toBe(12)
    expect(toStrictInt(' -3 ', 'x')).toBe(-3)
    expect(toStrictInt('', 'x')).toBeNull()
    expect(toStrictInt(NaN, 'x')).toBeNull()
    expect(Object.is(toStrictInt(-0, 'x'), 0)).toBe(true)
    expect(() => toStrictInt('0x1F', 'x')).toThrow(TypeError)
    expect(() => toStrictInt('1e3', 'x')).toThrow(TypeError)
    expect(() => toStrictInt(3.5, 'x')).toThrow(TypeError)
    expect(() => toStrictInt(true, 'x')).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// Attr.money — exact cents at every magnitude (the epsilon-nudge bug)
// ---------------------------------------------------------------------------

describe('Attr.money — exact rounding at every magnitude', () => {
  const price = Attr.money()

  it('rounds x.xx5 up regardless of magnitude', () => {
    // Number.EPSILON nudging only worked below ~2; each of these used to
    // lose a cent because the float sits just under the true decimal.
    expect(price.set!(1.005)).toBe(101)
    expect(price.set!(4.015)).toBe(402)
    expect(price.set!(8.165)).toBe(817)
    expect(price.set!(19.995)).toBe(2000)
    expect(price.set!(1234567.005)).toBe(123456701)
    expect(price.set!(-8.165)).toBe(-817)
  })

  it('accepts decimal strings with full precision', () => {
    expect(price.set!('8.165')).toBe(817)
    expect(price.set!('0.005')).toBe(1)
    expect(price.set!('-0.005')).toBe(-1)
  })

  it('reads cents as exact dollars (no float division)', () => {
    expect(price.get!(1999)).toBe(19.99)
    expect(price.get!('817')).toBe(8.17)
    expect(price.get!(1)).toBe(0.01)
  })

  it('round-trips dollars → cents → dollars losslessly', () => {
    for (const dollars of [0.01, 0.07, 0.1, 8.17, 19.99, 123.45, 999999.99]) {
      expect(price.get!(price.set!(dollars) as number)).toBe(dollars)
    }
  })

  it('NaN in the column reads as null, never NaN', () => {
    expect(price.get!(NaN)).toBeNull()
    expect(price.get!('garbage')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attr.percent — exact fraction ↔ percent scaling, basis-point precision
// ---------------------------------------------------------------------------

describe('Attr.percent — exact scaling', () => {
  const rate = Attr.percent()

  it('reads fractions as EXACT percents (docs say 15.3, we return 15.3)', () => {
    expect(rate.get!(0.153)).toBe(15.3) // used to be 15.299999999999999
    expect(rate.get!(0.0057)).toBe(0.57)
    expect(rate.get!(0.293)).toBe(29.3)
  })

  it('holds basis-point precision through the round trip', () => {
    expect(rate.set!(15.37)).toBe(0.1537)
    expect(rate.get!(0.1537)).toBe(15.37)
    expect(rate.set!(0.01)).toBe(0.0001) // 1 bp
    expect(rate.get!(0.0001)).toBe(0.01)
  })

  it('round-trips identically for arbitrary percents', () => {
    for (const pct of [0.01, 0.57, 2.5, 15.3, 15.37, 29.3, 42.5, 99.99, 100]) {
      expect(rate.get!(rate.set!(pct))).toBe(pct)
    }
  })
})

// ---------------------------------------------------------------------------
// Attr.boolean — string forms of false
// ---------------------------------------------------------------------------

describe('Attr.boolean — string coercion', () => {
  const active = Attr.boolean()

  it("'false', '0', 'f', 'off' (any case) cast to false", () => {
    expect(active.set!('false')).toBe(false)
    expect(active.set!('FALSE')).toBe(false)
    expect(active.set!('0')).toBe(false)
    expect(active.set!('f')).toBe(false)
    expect(active.set!('off')).toBe(false)
    expect(active.set!(' F ')).toBe(false)
  })

  it("reads Postgres text 'f' as false", () => {
    expect(active.get!('f')).toBe(false)
    expect(active.get!('t')).toBe(true)
  })

  it('truthy strings and numbers behave as before', () => {
    expect(active.set!('true')).toBe(true)
    expect(active.set!('1')).toBe(true)
    expect(active.set!(1)).toBe(true)
    expect(active.get!(0)).toBe(false)
  })

  it('blank casts to null', () => {
    expect(active.set!('')).toBeNull()
    expect(active.set!('   ')).toBeNull()
    expect(active.set!(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attr.integer / Attr.decimal / Attr.multiple — NaN→null everywhere
// ---------------------------------------------------------------------------

describe('lenient numeric attrs — NaN is impossible', () => {
  it('Attr.integer: blanks, garbage, NaN, wrong types all → null', () => {
    const n = Attr.integer()
    expect(n.set!('')).toBeNull()
    expect(n.set!('  ')).toBeNull()
    expect(n.set!('abc')).toBeNull()
    expect(n.set!(NaN)).toBeNull()
    expect(n.set!(Infinity)).toBeNull()
    expect(n.set!([5])).toBeNull()   // Number([5]) === 5 was nonsense
    expect(n.set!(true)).toBeNull()  // booleans are not integers
    expect(n.set!('42')).toBe(42)
    expect(n.get!('')).toBeNull()
    expect(n.get!('abc')).toBeNull()
  })

  it("Attr.decimal: the string 'NaN' can never reach a numeric column", () => {
    const d = Attr.decimal()
    expect(d.set!(NaN)).toBeNull()       // used to store the string 'NaN' (PG accepts it!)
    expect(d.set!('')).toBeNull()
    expect(d.set!('abc')).toBeNull()
    expect(d.set!(0.2)).toBe('0.2')
    expect(d.set!(1e21)).toBe('1000000000000000000000') // no '1e+21' literals
    expect(d.set!('0.10000000000000000001')).toBe('0.10000000000000000001')
    expect(d.get!('')).toBeNull()
  })

  it('Attr.decimal({ exact: true }) reads the full-precision string', () => {
    const d = Attr.decimal({ exact: true })
    expect(d.get!('0.10000000000000000001')).toBe('0.10000000000000000001')
    expect(d.get!(null)).toBeNull()
  })

  it('Attr.multiple: same policy, decimal-string storage', () => {
    const m = Attr.multiple()
    expect(m.set!(2.5)).toBe('2.5')
    expect(m.set!('abc')).toBeNull()
    expect(m.set!(NaN)).toBeNull()
    expect(m.get!('2.5')).toBe(2.5)
    expect(m.get!('')).toBeNull()
  })

  it('Attr.bps / Attr.days: strict ints, blank → null, NaN → null', () => {
    for (const attr of [Attr.bps(), Attr.days()]) {
      expect(attr.set!(250)).toBe(250)
      expect(attr.set!('')).toBeNull()
      expect(attr.set!(NaN)).toBeNull()
      expect(() => attr.set!(2.5)).toThrow(TypeError)
    }
  })
})

// ---------------------------------------------------------------------------
// min/max bounds
// ---------------------------------------------------------------------------

describe('numeric bounds (min/max) become validators', () => {
  function messages(attr: any, value: any): string[] {
    const fns = attr.validates ?? attr.validate
    const arr = Array.isArray(fns) ? fns : [fns]
    return arr.map((fn: any) => fn(value)).filter((m: any) => m !== null)
  }

  it('flags out-of-range values, passes in-range and null', () => {
    const qty = Attr.int({ min: 0, max: 100 })
    expect(messages(qty, -1)).toEqual(['must be greater than or equal to 0'])
    expect(messages(qty, 101)).toEqual(['must be less than or equal to 100'])
    expect(messages(qty, 50)).toEqual([])
    expect(messages(qty, null)).toEqual([])
  })

  it('works with PG int4 bounds for identifying column overflow', () => {
    const id = Attr.integer({ min: PG_INT4_MIN, max: PG_INT4_MAX })
    expect(messages(id, 2_147_483_648)).toHaveLength(1)
    expect(messages(id, 2_147_483_647)).toEqual([])
  })

  it('chains with a user validator instead of replacing it', () => {
    const qty = Attr.int({ min: 0, validate: (v: any) => (v === 13 ? 'unlucky' : null) })
    expect(messages(qty, 13)).toEqual(['unlucky'])
    expect(messages(qty, -1)).toEqual(['must be greater than or equal to 0'])
  })

  it('merges into the validates alias when that key is used', () => {
    const qty = Attr.int({ min: 0, validates: (v: any) => (v === 13 ? 'unlucky' : null) })
    expect(Array.isArray(qty.validates)).toBe(true)
    expect(messages(qty, -1)).toEqual(['must be greater than or equal to 0'])
  })
})

// ---------------------------------------------------------------------------
// Enum / state — prototype-chain hardening
// ---------------------------------------------------------------------------

describe('enum/state maps never resolve Object.prototype', () => {
  const status = Attr.enum({ draft: 0, sent: 1 } as const)

  it("enum.set('toString') passes the string through — not the native function", () => {
    expect(status.set!('toString')).toBe('toString')
    expect(status.set!('constructor')).toBe('constructor')
    expect(status.set!('valueOf')).toBe('valueOf')
    expect(status.set!('__proto__')).toBe('__proto__')
    expect(status.set!('hasOwnProperty')).toBe('hasOwnProperty')
  })

  it('enum.get with prototype keys returns the raw value', () => {
    expect(status.get!('constructor' as any)).toBe('constructor')
    expect(status.get!('__proto__' as any)).toBe('__proto__')
  })

  it('enum NaN casts to null on both sides', () => {
    expect(status.set!(NaN)).toBeNull()
    expect(status.get!(NaN)).toBeNull()
  })

  const machine = Attr.state({
    states: { draft: 0, submitted: 1 } as const,
    initial: 'draft',
    transitions: { submit: { from: ['draft'], to: 'submitted' } },
  })

  it('state.set with prototype keys passes strings through', () => {
    expect(machine.set!('toString')).toBe('toString')
    expect(machine.set!('valueOf')).toBe('valueOf')
  })

  it('stateCanFire reports unknown for prototype-key events instead of crashing', () => {
    expect(stateCanFire(machine, 'draft', 'toString', {})).toEqual({
      ok: false,
      reason: "unknown event 'toString'",
    })
    expect(stateCanFire(machine, 'draft', 'constructor', {})).toEqual({
      ok: false,
      reason: "unknown event 'constructor'",
    })
  })

  it('record.can()/advance() with prototype-key events return false, not TypeError', async () => {
    class Loan extends ApplicationRecord {
      static status = Attr.state({
        states: { draft: 0, submitted: 1 } as const,
        initial: 'draft',
        transitions: { submit: { from: ['draft'], to: 'submitted' } },
      })
    }
    const loan = new Loan({ id: 1, status: 0 }, false)
    expect(loan.can('toString')).toBe(false)
    expect(loan.can('hasOwnProperty')).toBe(false)
    expect(loan.can('submit')).toBe(true)
    expect(await loan.advance('constructor')).toBe(false)
    expect(loan.errors.isEmpty()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dirty tracking — NaN can no longer poison it
// ---------------------------------------------------------------------------

describe('dirty tracking uses Object.is', () => {
  class Metric extends ApplicationRecord {
    static declare score: any
  }

  it('re-assigning an existing NaN is not a change', () => {
    const m = new Metric({ id: 1, score: NaN }, false)
    ;(m as any).score = NaN
    expect(m._changes.has('score')).toBe(false)
    expect(m.isChanged()).toBe(false)
  })

  it('restoring a NaN-valued original clears the pending change', () => {
    const m = new Metric({ id: 1, score: NaN }, false)
    ;(m as any).score = 5
    expect(m._changes.has('score')).toBe(true)
    ;(m as any).score = NaN
    expect(m._changes.has('score')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rangeIncludes — NaN is in no range
// ---------------------------------------------------------------------------

describe('rangeIncludes rejects NaN', () => {
  const r = { lower: 1, upper: 10, lowerInclusive: true, upperInclusive: false }

  it('NaN is never included (used to be included in EVERY range)', () => {
    expect(rangeIncludes(r, NaN)).toBe(false)
    expect(rangeIncludes(r, new Date(NaN) as any)).toBe(false)
  })

  it('normal values still work', () => {
    expect(rangeIncludes(r, 1)).toBe(true)
    expect(rangeIncludes(r, 9.99)).toBe(true)
    expect(rangeIncludes(r, 10)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Attr.date — no boolean epochs, blanks → null
// ---------------------------------------------------------------------------

describe('Attr.date — type discipline', () => {
  const at = Attr.date()

  it('booleans never become 1970 dates', () => {
    expect(at.set!(true)).toBeNull()  // used to be 1970-01-01T00:00:00.001Z
    expect(at.get!(true)).toBeNull()
    expect(at.set!(false)).toBeNull()
  })

  it('blank and garbage strings cast to null', () => {
    expect(at.set!('')).toBeNull()
    expect(at.set!('   ')).toBeNull()
    expect(at.set!('garbage')).toBeNull()
  })

  it('valid inputs still coerce', () => {
    expect((at.set!(0) as Date).toISOString()).toBe('1970-01-01T00:00:00.000Z')
    expect((at.set!('2024-01-15') as Date).getUTCFullYear()).toBe(2024)
    const d = new Date('2024-06-01')
    expect(at.set!(d)).toBe(d)
  })

  it('invalid Date instances cast to null', () => {
    expect(at.set!(new Date('garbage'))).toBeNull()
    expect(at.get!(new Date(NaN))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attr.array.<type> — typed elements both directions
// ---------------------------------------------------------------------------

describe('Attr.array.<type>', () => {
  it('array({ element: parseInt }) no longer hits the radix trap', () => {
    const scores = Attr.array({ element: parseInt as any })
    expect(scores.get!(['10', '10', '10'])).toEqual([10, 10, 10]) // was [10, null, 2]
  })

  it('array.integer parses literals and casts elements', () => {
    const scores = Attr.array.integer()
    expect(scores.get!('{"1","2"}')).toEqual([1, 2])
    expect(scores.get!(['3', '4'])).toEqual([3, 4])
    expect(scores.set!(['5', 'garbage'])).toEqual([5, null]) // NaN policy per element
  })

  it('array.boolean casts string falses', () => {
    const flags = Attr.array.boolean()
    expect(flags.get!(['t', 'f', 'false'])).toEqual([true, false, false])
    expect(flags.set!(['0', true])).toEqual([false, true])
  })

  it('array.money stores dollars as exact cents per element', () => {
    const tiers = Attr.array.money()
    expect(tiers.set!([19.99, 8.165])).toEqual([1999, 817])
    expect(tiers.get!([1999, 817])).toEqual([19.99, 8.17])
  })

  it('array.date coerces elements to Dates', () => {
    const touched = Attr.array.date()
    const out = touched.get!(['2024-01-15', 'garbage']) as (Date | null)[]
    expect(out[0]).toBeInstanceOf(Date)
    expect(out[1]).toBeNull()
  })

  it('array.string and array.decimal round elements through scalar casts', () => {
    expect(Attr.array.string().set!([1, ' padded '])).toEqual(['1', 'padded'])
    expect(Attr.array.decimal().set!([0.2, 'abc'])).toEqual(['0.2', null])
  })

  it('typed arrays still reject non-arrays and pass nulls', () => {
    const scores = Attr.array.integer()
    expect(scores.set!(null)).toBeNull()
    expect(() => scores.set!('nope' as any)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// Attr.range.<type> — typed bounds with exact scaling
// ---------------------------------------------------------------------------

describe('Attr.range.<type>', () => {
  it('range() and range.integer parse and serialize literals', () => {
    const seats = Attr.range.integer()
    expect(seats.get!('[1,10)')).toEqual({
      lower: 1, upper: 10, lowerInclusive: true, upperInclusive: false,
    })
    expect(seats.set!({ lower: 5, upper: 20, lowerInclusive: true, upperInclusive: false })).toBe('[5,20)')
  })

  it('range.percent scales bounds exactly (no 0.005699999999999999 literals)', () => {
    const target = Attr.range.percent()
    expect(target.set!({ lower: 0.57, upper: 29.3, lowerInclusive: true, upperInclusive: false }))
      .toBe('[0.0057,0.293)')
    const back = target.get!('[0.0057,0.293)') as any
    expect(back.lower).toBe(0.57)
    expect(back.upper).toBe(29.3)
  })

  it('range.money exposes dollars over a cents numrange', () => {
    const band = Attr.range.money()
    expect(band.set!({ lower: 8.165, upper: 19.99, lowerInclusive: true, upperInclusive: false }))
      .toBe('[817,1999)')
    const back = band.get!('[817,1999)') as any
    expect(back.lower).toBe(8.17)
    expect(back.upper).toBe(19.99)
  })

  it('range.date keeps Date bounds and ISO literals', () => {
    const booked = Attr.range.date()
    const lit = booked.set!({
      lower: new Date('2024-01-01T00:00:00.000Z'),
      upper: new Date('2024-02-01T00:00:00.000Z'),
      lowerInclusive: true,
      upperInclusive: false,
    })
    expect(lit).toBe('["2024-01-01T00:00:00.000Z","2024-02-01T00:00:00.000Z")')
    const back = booked.get!(lit!) as any
    expect(back.lower).toBeInstanceOf(Date)
    expect(back.lower.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('dateRange/percentRange aliases stay wired to the same engines', () => {
    expect(Attr.dateRange()._type).toBe('range')
    expect(Attr.percentRange().set!({ lower: 2.5, upper: 10, lowerInclusive: true, upperInclusive: false }))
      .toBe('[0.025,0.1)')
  })

  it('unbounded sides and empty ranges survive', () => {
    const target = Attr.range.percent()
    expect(target.get!('[0.5,)')).toMatchObject({ lower: 50, upper: null })
    expect(target.get!('empty')).toMatchObject({ isEmpty: true })
  })
})

// ---------------------------------------------------------------------------
// boot() — reserved column-name suffixes blow up loudly
// ---------------------------------------------------------------------------

describe('boot() rejects reserved dirty-tracking column names', () => {
  const fakeDb = {} as any

  it('throws when a column ends in Changed/Was/Change', () => {
    const schema = {
      audits: pgTable('audits', {
        id: integer('id').primaryKey(),
        lastChanged: text('last_changed'),
      }),
    }
    expect(() => boot(fakeDb, schema)).toThrow(/lastChanged.*reserved suffix 'Changed'/)
  })

  it('names every offender across tables', () => {
    const schema = {
      a: pgTable('a', { id: integer('id'), priceWas: integer('price_was') }),
      b: pgTable('b', { id: integer('id'), statusChange: text('status_change') }),
    }
    expect(() => boot(fakeDb, schema)).toThrow(/priceWas[\s\S]*statusChange/)
  })

  it('does not false-positive on lowercase or unrelated names', () => {
    const schema = {
      trades: pgTable('trades', {
        id: integer('id').primaryKey(),
        exchange: text('exchange'),       // lowercase 'change' — fine
        wasabi: text('wasabi'),
        changedAt: text('changed_at'),    // suffix is 'At'
      }),
    }
    expect(() => boot(fakeDb, schema)).not.toThrow()
  })
})
