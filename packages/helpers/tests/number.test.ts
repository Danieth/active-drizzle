import { describe, it, expect } from 'vitest'
import {
  ordinal, ordinalize, numberWithDelimiter, numberToCurrency,
  numberToPercentage, numberToHumanSize, numberToHuman,
  clamp, isMultipleOf, isEven, isOdd,
  seconds, minutes, hours, days, weeks, fromNow, ago,
} from '../src/number.js'

describe('ordinals', () => {
  it('ordinal handles teens and regular cases', () => {
    expect(ordinal(1)).toBe('st')
    expect(ordinal(2)).toBe('nd')
    expect(ordinal(3)).toBe('rd')
    expect(ordinal(4)).toBe('th')
    expect(ordinal(11)).toBe('th')
    expect(ordinal(12)).toBe('th')
    expect(ordinal(13)).toBe('th')
    expect(ordinal(21)).toBe('st')
    expect(ordinal(111)).toBe('th')
    expect(ordinal(-1)).toBe('st')
  })

  it('ordinalize', () => {
    expect(ordinalize(1)).toBe('1st')
    expect(ordinalize(22)).toBe('22nd')
    expect(ordinalize(103)).toBe('103rd')
  })
})

describe('formatting', () => {
  it('numberWithDelimiter', () => {
    expect(numberWithDelimiter(1234567)).toBe('1,234,567')
    expect(numberWithDelimiter(1234567.891)).toBe('1,234,567.891')
    expect(numberWithDelimiter(123)).toBe('123')
    expect(numberWithDelimiter(1234, '.', ',')).toBe('1.234')
  })

  it('numberToCurrency', () => {
    expect(numberToCurrency(1234.5)).toBe('$1,234.50')
    expect(numberToCurrency(-99)).toBe('-$99.00')
    expect(numberToCurrency(1000, { unit: '€', precision: 0 })).toBe('€1,000')
  })

  it('numberToPercentage', () => {
    expect(numberToPercentage(65.3)).toBe('65.3%')
    expect(numberToPercentage(100, 0)).toBe('100%')
    expect(numberToPercentage(0)).toBe('0%')
  })

  it('numberToHumanSize', () => {
    expect(numberToHumanSize(0)).toBe('0 bytes')
    expect(numberToHumanSize(1)).toBe('1 byte')
    expect(numberToHumanSize(500)).toBe('500 bytes')
    expect(numberToHumanSize(1024)).toBe('1 KB')
    expect(numberToHumanSize(1234567)).toBe('1.2 MB')
    expect(numberToHumanSize(1073741824)).toBe('1 GB')
  })

  it('numberToHuman', () => {
    expect(numberToHuman(1234567)).toBe('1.2 Million')
    expect(numberToHuman(1000)).toBe('1 Thousand')
    expect(numberToHuman(999)).toBe('999')
    expect(numberToHuman(2_500_000_000)).toBe('2.5 Billion')
  })
})

describe('predicates / clamp', () => {
  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('isMultipleOf / isEven / isOdd', () => {
    expect(isMultipleOf(9, 3)).toBe(true)
    expect(isMultipleOf(10, 3)).toBe(false)
    expect(isMultipleOf(0, 0)).toBe(true)
    expect(isMultipleOf(5, 0)).toBe(false)
    expect(isEven(4)).toBe(true)
    expect(isOdd(3)).toBe(true)
    expect(isOdd(-3)).toBe(true)
  })
})

describe('durations', () => {
  it('converts to milliseconds', () => {
    expect(seconds(2)).toBe(2000)
    expect(minutes(2)).toBe(120_000)
    expect(hours(1)).toBe(3_600_000)
    expect(days(1)).toBe(86_400_000)
    expect(weeks(1)).toBe(604_800_000)
  })

  it('fromNow / ago produce dates in the right direction', () => {
    const now = Date.now()
    expect(fromNow(minutes(5)).getTime()).toBeGreaterThan(now)
    expect(ago(minutes(5)).getTime()).toBeLessThan(now)
  })
})
