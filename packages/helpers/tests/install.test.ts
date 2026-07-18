import { describe, it, expect, beforeAll } from 'vitest'
import { installHelpers } from '../src/install.js'

beforeAll(() => {
  installHelpers()
  installHelpers() // idempotent — must not throw or double-install
})

describe('Array.prototype', () => {
  it('element access', () => {
    expect([1, 2, 3].first()).toBe(1)
    expect([1, 2, 3].first(2)).toEqual([1, 2])
    expect([1, 2, 3].last()).toBe(3)
    expect([1, 2, 3].second()).toBe(2)
    expect([1, 2, 3, 4, 5].fifth()).toBe(5)
  })

  it('presence', () => {
    expect([].isBlank()).toBe(true)
    expect([1].isPresent()).toBe(true)
    expect([].presence()).toBeUndefined()
  })

  it('transforms', () => {
    expect([1, null, 2, undefined].compact()).toEqual([1, 2])
    expect([1, 1, 2].uniq()).toEqual([1, 2])
    expect([1, 2, 3].without(2)).toEqual([1, 3])
    expect([1].including(2)).toEqual([1, 2])
    expect([{ a: 1 }, { a: 2 }].pluckKey('a')).toEqual([1, 2])
  })

  it('aggregates', () => {
    expect([1, 2, 3].sum()).toBe(6)
    expect([{ v: 2 }, { v: 3 }].sum(x => x.v)).toBe(5)
    expect(['a', 'bb'].maxBy(s => s.length)).toBe('bb')
    expect([3, 1, 2].sortBy(n => n)).toEqual([1, 2, 3])
    const groups = ['apple', 'avocado', 'banana'].groupBy(s => s[0]!)
    expect(groups['a']).toEqual(['apple', 'avocado'])
  })

  it('slicing and sentence', () => {
    expect([1, 2, 3].eachSlice(2)).toEqual([[1, 2], [3]])
    expect([1, 2, 3].inGroupsOf(2)).toEqual([[1, 2], [3, null]])
    expect(['a', 'b', 'c'].toSentence()).toBe('a, b, and c')
  })

  it('methods are non-enumerable', () => {
    const keys: string[] = []
    for (const k in [1, 2]) keys.push(k)
    expect(keys).toEqual(['0', '1'])
    expect(Object.keys([1])).toEqual(['0'])
    expect(JSON.stringify([1, 2])).toBe('[1,2]')
  })
})

describe('String.prototype', () => {
  it('inflections', () => {
    expect('user'.pluralize()).toBe('users')
    expect('people'.singularize()).toBe('person')
    expect('user_profile'.camelize()).toBe('userProfile')
    expect('userProfile'.underscore()).toBe('user_profile')
    expect('user_profiles'.classify()).toBe('UserProfile')
    expect('UserProfile'.tableize()).toBe('user_profiles')
    expect('UserProfile'.foreignKey()).toBe('user_profile_id')
    expect('employee_salary'.humanize()).toBe('Employee salary')
    expect('Donald E. Knuth'.parameterize()).toBe('donald-e-knuth')
  })

  it('presence and formatting', () => {
    expect('  '.isBlank()).toBe(true)
    expect('x'.isPresent()).toBe(true)
    expect(''.presence()).toBeUndefined()
    expect('  a  b '.squish()).toBe('a b')
    expect('Once upon a time in a world'.truncate(17)).toBe('Once upon a ti...')
    expect('yes'.toBoolean()).toBe(true)
  })
})

describe('Number.prototype', () => {
  it('ordinals and formatting', () => {
    expect((3).ordinalize()).toBe('3rd')
    expect((11).ordinal()).toBe('th')
    expect((1234567).withDelimiter()).toBe('1,234,567')
    expect((1234.5).toCurrency()).toBe('$1,234.50')
    expect((1234567).toHumanSize()).toBe('1.2 MB')
    expect((1234567).toHuman()).toBe('1.2 Million')
  })

  it('predicates and durations', () => {
    expect((4).even()).toBe(true)
    expect((3).odd()).toBe(true)
    expect((9).multipleOf(3)).toBe(true)
    expect((15).clamp(0, 10)).toBe(10)
    expect((5).minutes()).toBe(300_000)
    expect((2).hours()).toBe(7_200_000)
    expect((0).isBlank()).toBe(false) // Rails: 0 is present
  })
})

describe('Date.prototype', () => {
  const d = new Date(2026, 6, 18, 14, 30) // Saturday

  it('boundaries and arithmetic', () => {
    expect(d.beginningOfDay().getHours()).toBe(0)
    expect(d.endOfMonth().getDate()).toBe(31)
    expect(d.addDays(14).getMonth()).toBe(7)
    expect(d.addMonths(1).getDate()).toBe(18)
    expect(d.beginningOfWeek().getDay()).toBe(1)
  })

  it('predicates and formatting', () => {
    expect(d.isWeekend()).toBe(true)
    expect(new Date().isToday()).toBe(true)
    expect(new Date(2020, 0, 1).isPast()).toBe(true)
    expect(d.toFormattedString('db')).toBe('2026-07-18 14:30:00')
  })
})

describe('new Array.prototype gap-fills', () => {
  it('zip / rotate / sole / from / to', () => {
    expect([1, 2].zip(['a', 'b'])).toEqual([[1, 'a'], [2, 'b']])
    expect([1, 2, 3].rotate()).toEqual([2, 3, 1])
    expect([42].sole()).toBe(42)
    expect(['a', 'b', 'c'].from(1)).toEqual(['b', 'c'])
    expect(['a', 'b', 'c'].to(1)).toEqual(['a', 'b'])
  })

  it('takeWhile / chunkWhile / inGroups', () => {
    expect([1, 2, 5].takeWhile(n => n < 3)).toEqual([1, 2])
    expect([1, 2, 4].chunkWhile((a, b) => b - a === 1)).toEqual([[1, 2], [4]])
    expect([1, 2, 3, 4, 5].inGroups(2, null, false)).toEqual([[1, 2, 3], [4, 5]])
  })
})

describe('new String.prototype gap-fills', () => {
  it('remove / first / last / swapcase / center', () => {
    expect('Hello World'.remove('l')).toBe('Heo Word')
    expect('hello'.first(3)).toBe('hel')
    expect('hello'.last(3)).toBe('llo')
    expect('Hi'.swapcase()).toBe('hI')
    expect('hi'.center(6, '*')).toBe('**hi**')
  })
})

describe('new Number.prototype gap-fills', () => {
  it('byte sizes / roundTo / percentOf', () => {
    expect((2).kilobytes()).toBe(2048)
    expect((5).megabytes()).toBe(5_242_880)
    expect((3.14159).roundTo(2)).toBe(3.14)
    expect((25).percentOf(200)).toBe(12.5)
  })
})

describe('safety', () => {
  it('does not clobber existing native methods', () => {
    // Array.prototype.includes exists natively; our "including" is separate
    expect([1, 2].includes(1)).toBe(true)
    // String.prototype.at is native and untouched
    expect('abc'.at(0)).toBe('a')
  })
})
