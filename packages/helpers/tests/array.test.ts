import { describe, it, expect } from 'vitest'
import {
  first, last, second, third, fourth, fifth,
  compact, uniq, without, including, pluck,
  groupBy, indexBy, countBy, tally, partition,
  sum, minBy, maxBy, sortBy,
  eachSlice, eachCons, inGroupsOf,
  sample, shuffle, toSentence,
} from '../src/array.js'
import { presence, isBlankArray, isPresentArray } from '../src/array.js'

describe('element access', () => {
  it('first / last with and without n', () => {
    expect(first([1, 2, 3])).toBe(1)
    expect(first([1, 2, 3], 2)).toEqual([1, 2])
    expect(first([])).toBeUndefined()
    expect(last([1, 2, 3])).toBe(3)
    expect(last([1, 2, 3], 2)).toEqual([2, 3])
    expect(last([1, 2, 3], 0)).toEqual([])
    expect(last([])).toBeUndefined()
  })

  it('second..fifth', () => {
    const a = [1, 2, 3, 4, 5, 6]
    expect(second(a)).toBe(2)
    expect(third(a)).toBe(3)
    expect(fourth(a)).toBe(4)
    expect(fifth(a)).toBe(5)
    expect(fifth([1])).toBeUndefined()
  })
})

describe('presence', () => {
  it('blank / present / presence', () => {
    expect(isBlankArray([])).toBe(true)
    expect(isBlankArray([1])).toBe(false)
    expect(isPresentArray([1])).toBe(true)
    expect(presence([])).toBeUndefined()
    expect(presence([1, 2])).toEqual([1, 2])
  })
})

describe('filtering / transforming', () => {
  it('compact removes null and undefined only', () => {
    expect(compact([1, null, 2, undefined, 0, '', false])).toEqual([1, 2, 0, '', false])
  })

  it('uniq with and without key fn', () => {
    expect(uniq([1, 2, 2, 3, 1])).toEqual([1, 2, 3])
    const items = [{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }]
    expect(uniq(items, i => i.id)).toEqual([{ id: 1, v: 'a' }, { id: 2, v: 'c' }])
  })

  it('without / including', () => {
    expect(without([1, 2, 3, 2], 2)).toEqual([1, 3])
    expect(including([1, 2], 3, 4)).toEqual([1, 2, 3, 4])
  })

  it('pluck', () => {
    const users = [{ name: 'a', age: 1 }, { name: 'b', age: 2 }]
    expect(pluck(users, 'name')).toEqual(['a', 'b'])
  })
})

describe('grouping / aggregating', () => {
  const users = [
    { name: 'alice', role: 'admin' },
    { name: 'bob', role: 'user' },
    { name: 'carol', role: 'admin' },
  ]

  it('groupBy', () => {
    const g = groupBy(users, u => u.role)
    expect(g.admin!.map(u => u.name)).toEqual(['alice', 'carol'])
    expect(g.user!.map(u => u.name)).toEqual(['bob'])
  })

  it('indexBy keeps last per key', () => {
    const idx = indexBy(users, u => u.role)
    expect(idx.admin!.name).toBe('carol')
  })

  it('countBy / tally', () => {
    expect(countBy(users, u => u.role)).toEqual({ admin: 2, user: 1 })
    const t = tally(['a', 'b', 'a'])
    expect(t.get('a')).toBe(2)
    expect(t.get('b')).toBe(1)
  })

  it('partition', () => {
    const [even, odd] = partition([1, 2, 3, 4], n => n % 2 === 0)
    expect(even).toEqual([2, 4])
    expect(odd).toEqual([1, 3])
  })

  it('sum with and without fn', () => {
    expect(sum([1, 2, 3])).toBe(6)
    expect(sum(users, () => 2)).toBe(6)
    expect(sum([])).toBe(0)
  })

  it('minBy / maxBy / sortBy', () => {
    const items = [{ v: 3 }, { v: 1 }, { v: 2 }]
    expect(minBy(items, i => i.v)).toEqual({ v: 1 })
    expect(maxBy(items, i => i.v)).toEqual({ v: 3 })
    expect(sortBy(items, i => i.v)).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }])
    expect(minBy([], () => 0)).toBeUndefined()
  })

  it('sortBy is stable and does not mutate', () => {
    const items = [{ k: 1, tag: 'a' }, { k: 1, tag: 'b' }, { k: 0, tag: 'c' }]
    const sorted = sortBy(items, i => i.k)
    expect(sorted.map(i => i.tag)).toEqual(['c', 'a', 'b'])
    expect(items[0]!.tag).toBe('a') // original untouched
  })
})

describe('slicing', () => {
  it('eachSlice', () => {
    expect(eachSlice([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(() => eachSlice([1], 0)).toThrow()
  })

  it('eachCons', () => {
    expect(eachCons([1, 2, 3, 4], 2)).toEqual([[1, 2], [2, 3], [3, 4]])
    expect(eachCons([1], 2)).toEqual([])
  })

  it('inGroupsOf pads the last group', () => {
    expect(inGroupsOf([1, 2, 3], 2)).toEqual([[1, 2], [3, null]])
    expect(inGroupsOf([1, 2, 3], 2, 0)).toEqual([[1, 2], [3, 0]])
    expect(inGroupsOf([1, 2], 2)).toEqual([[1, 2]])
  })
})

describe('random', () => {
  it('sample returns an element / n elements', () => {
    expect([1, 2, 3]).toContain(sample([1, 2, 3]))
    expect(sample([], undefined as any)).toBeUndefined()
    const s = sample([1, 2, 3], 2)
    expect(s).toHaveLength(2)
    for (const v of s) expect([1, 2, 3]).toContain(v)
  })

  it('shuffle preserves elements without mutating', () => {
    const orig = [1, 2, 3, 4, 5]
    const shuffled = shuffle(orig)
    expect(shuffled.slice().sort()).toEqual([1, 2, 3, 4, 5])
    expect(orig).toEqual([1, 2, 3, 4, 5])
  })
})

describe('toSentence', () => {
  it('handles 0, 1, 2, and n elements', () => {
    expect(toSentence([])).toBe('')
    expect(toSentence(['a'])).toBe('a')
    expect(toSentence(['a', 'b'])).toBe('a and b')
    expect(toSentence(['a', 'b', 'c'])).toBe('a, b, and c')
  })

  it('respects custom connectors', () => {
    expect(toSentence(['a', 'b', 'c'], { lastWordConnector: ' or ' })).toBe('a, b or c')
  })
})
