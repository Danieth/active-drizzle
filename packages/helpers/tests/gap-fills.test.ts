import { describe, it, expect } from 'vitest'
import {
  zip, rotate, eachWithObject, takeWhile, dropWhile,
  chunkWhile, sliceWhen, from, to, inGroups, sole, deepDup,
} from '../src/array.js'
import { remove, firstChars, lastChars, fromIndex, toIndex, swapcase, center } from '../src/string.js'
import { roundTo, percentOf, kilobytes, megabytes, gigabytes, terabytes } from '../src/number.js'

describe('Ruby Enumerable gap-fills', () => {
  it('zip', () => {
    expect(zip([1, 2, 3], ['a', 'b', 'c'])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']])
    expect(zip([1, 2], ['a'])).toEqual([[1, 'a'], [2, undefined]])
    expect(zip([1], [2], [3])).toEqual([[1, 2, 3]])
  })

  it('rotate', () => {
    expect(rotate([1, 2, 3, 4])).toEqual([2, 3, 4, 1])
    expect(rotate([1, 2, 3, 4], 2)).toEqual([3, 4, 1, 2])
    expect(rotate([1, 2, 3, 4], -1)).toEqual([4, 1, 2, 3])
    expect(rotate([1, 2], 5)).toEqual([2, 1])
    expect(rotate([])).toEqual([])
  })

  it('eachWithObject', () => {
    const result = eachWithObject([1, 2, 3], {} as Record<string, number>, (n, obj) => { obj[`k${n}`] = n * 2 })
    expect(result).toEqual({ k1: 2, k2: 4, k3: 6 })
  })

  it('takeWhile / dropWhile', () => {
    expect(takeWhile([1, 2, 5, 1], n => n < 3)).toEqual([1, 2])
    expect(dropWhile([1, 2, 5, 1], n => n < 3)).toEqual([5, 1])
    expect(takeWhile([], () => true)).toEqual([])
    expect(dropWhile([1], () => true)).toEqual([])
  })

  it('chunkWhile groups consecutive runs', () => {
    expect(chunkWhile([1, 2, 4, 9, 10, 11, 12, 15], (a, b) => b - a === 1))
      .toEqual([[1, 2], [4], [9, 10, 11, 12], [15]])
    expect(chunkWhile([], () => true)).toEqual([])
  })

  it('sliceWhen splits at boundaries', () => {
    expect(sliceWhen([1, 2, 4, 5, 7], (a, b) => b - a > 1))
      .toEqual([[1, 2], [4, 5], [7]])
  })
})

describe('Rails Array extensions', () => {
  it('from / to', () => {
    const a = ['a', 'b', 'c', 'd']
    expect(from(a, 2)).toEqual(['c', 'd'])
    expect(from(a, 10)).toEqual([])
    expect(to(a, 2)).toEqual(['a', 'b', 'c'])
    expect(to(a, -1)).toEqual([])
  })

  it('inGroups near-equal split with padding', () => {
    expect(inGroups([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, null], [6, 7, null]])
    expect(inGroups([1, 2, 3, 4, 5, 6, 7], 3, 0)).toEqual([[1, 2, 3], [4, 5, 0], [6, 7, 0]])
    expect(inGroups([1, 2, 3, 4, 5, 6, 7], 3, null, false)).toEqual([[1, 2, 3], [4, 5], [6, 7]])
    expect(inGroups([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    expect(() => inGroups([1], 0)).toThrow()
  })

  it('sole', () => {
    expect(sole([42])).toBe(42)
    expect(() => sole([])).toThrow('empty')
    expect(() => sole([1, 2])).toThrow('2 elements')
  })

  it('deepDup produces an independent clone', () => {
    const orig = { a: [1, { b: 2 }], d: new Date(2026, 0, 1), m: new Map([['k', [1]]]), s: new Set([1]) }
    const dup = deepDup(orig)
    expect(dup).toEqual(orig)
    ;(dup.a[1] as any).b = 99
    dup.m.get('k')!.push(2)
    expect((orig.a[1] as any).b).toBe(2)
    expect(orig.m.get('k')).toEqual([1])
    expect(dup.d).not.toBe(orig.d)
    expect(dup.d.getTime()).toBe(orig.d.getTime())
  })
})

describe('Rails String extensions', () => {
  it('remove with strings and regexps', () => {
    expect(remove('Hello World', 'l')).toBe('Heo Word')
    expect(remove('foo bar foo', 'foo ')).toBe('bar foo')
    expect(remove('a1b2c3', /\d/)).toBe('abc')
    expect(remove('x-y_z', '-', '_')).toBe('xyz')
  })

  it('firstChars / lastChars', () => {
    expect(firstChars('hello')).toBe('h')
    expect(firstChars('hello', 3)).toBe('hel')
    expect(firstChars('hi', 10)).toBe('hi')
    expect(firstChars('hi', 0)).toBe('')
    expect(lastChars('hello')).toBe('o')
    expect(lastChars('hello', 3)).toBe('llo')
  })

  it('fromIndex / toIndex', () => {
    expect(fromIndex('hello', 2)).toBe('llo')
    expect(toIndex('hello', 2)).toBe('hel')
    expect(toIndex('hello', -2)).toBe('hell')
  })

  it('swapcase / center', () => {
    expect(swapcase('Hello World')).toBe('hELLO wORLD')
    expect(center('hi', 6)).toBe('  hi  ')
    expect(center('hi', 7)).toBe('  hi   ')
    expect(center('hi', 6, '*')).toBe('**hi**')
    expect(center('hello', 3)).toBe('hello')
  })
})

describe('Number extensions', () => {
  it('roundTo', () => {
    expect(roundTo(3.14159, 2)).toBe(3.14)
    expect(roundTo(2.5)).toBe(3)
    expect(roundTo(1.005, 2)).toBe(1.01) // classic float trap
  })

  it('percentOf', () => {
    expect(percentOf(25, 200)).toBe(12.5)
    expect(percentOf(1, 0)).toBe(0)
  })

  it('byte sizes', () => {
    expect(kilobytes(2)).toBe(2048)
    expect(megabytes(1)).toBe(1_048_576)
    expect(gigabytes(1)).toBe(1_073_741_824)
    expect(terabytes(1)).toBe(1_099_511_627_776)
  })
})
