import { describe, it, expect } from 'vitest'
import {
  isBlank, isPresent, presence,
  slice, except, compactObject, compactBlank,
  transformKeys, camelizeKeys, underscoreKeys, deepCamelizeKeys, deepUnderscoreKeys,
  deepMerge, dig,
} from '../src/object.js'

describe('isBlank / isPresent (Rails blank? semantics)', () => {
  it('covers all blank cases', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank([])).toBe(true)
    expect(isBlank({})).toBe(true)
    expect(isBlank(false)).toBe(true)
    expect(isBlank(new Map())).toBe(true)
    expect(isBlank(new Set())).toBe(true)
    expect(isBlank(NaN)).toBe(true)
  })

  it('covers present cases', () => {
    expect(isBlank(0)).toBe(false) // Rails: 0 is present
    expect(isBlank('x')).toBe(false)
    expect(isBlank([0])).toBe(false)
    expect(isBlank({ a: 1 })).toBe(false)
    expect(isBlank(true)).toBe(false)
    expect(isBlank(new Date())).toBe(false)
    expect(isPresent(0)).toBe(true)
  })

  it('presence returns value or undefined', () => {
    expect(presence('')).toBeUndefined()
    expect(presence('hi')).toBe('hi')
    expect(presence(0)).toBe(0)
    expect(presence([])).toBeUndefined()
  })
})

describe('slice / except / compact', () => {
  const obj = { a: 1, b: 2, c: null, d: undefined, e: '' }

  it('slice picks only given keys', () => {
    expect(slice(obj, 'a', 'b')).toEqual({ a: 1, b: 2 })
    expect(slice(obj, 'a', 'nope' as any)).toEqual({ a: 1 })
  })

  it('except drops given keys', () => {
    expect(except({ a: 1, b: 2, c: 3 }, 'b')).toEqual({ a: 1, c: 3 })
  })

  it('compactObject removes null/undefined only', () => {
    expect(compactObject(obj)).toEqual({ a: 1, b: 2, e: '' })
  })

  it('compactBlank removes all blank values', () => {
    expect(compactBlank(obj)).toEqual({ a: 1, b: 2 })
  })
})

describe('key transformation', () => {
  it('transformKeys / camelizeKeys / underscoreKeys', () => {
    expect(transformKeys({ a: 1 }, k => k.toUpperCase())).toEqual({ A: 1 })
    expect(camelizeKeys({ user_name: 'x', created_at: 'y' })).toEqual({ userName: 'x', createdAt: 'y' })
    expect(underscoreKeys({ userName: 'x' })).toEqual({ user_name: 'x' })
  })

  it('deep variants recurse through nested objects and arrays', () => {
    const input = { user_info: { first_name: 'a', tags_list: [{ tag_id: 1 }] } }
    expect(deepCamelizeKeys(input)).toEqual({ userInfo: { firstName: 'a', tagsList: [{ tagId: 1 }] } })
    const back = deepUnderscoreKeys({ userInfo: { firstName: 'a' } })
    expect(back).toEqual({ user_info: { first_name: 'a' } })
  })

  it('deep variants leave non-plain objects alone', () => {
    const d = new Date()
    expect(deepCamelizeKeys({ created_at: d })).toEqual({ createdAt: d })
  })
})

describe('deepMerge / dig', () => {
  it('deepMerge merges nested plain objects', () => {
    const merged = deepMerge(
      { a: 1, nested: { x: 1, y: 2 } },
      { b: 2, nested: { y: 3, z: 4 } },
    )
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } })
  })

  it('deepMerge overwrites arrays and scalars', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] })
  })

  it('dig traverses safely', () => {
    const obj = { a: { b: [{ c: 42 }] } }
    expect(dig(obj, 'a', 'b', 0, 'c')).toBe(42)
    expect(dig(obj, 'a', 'nope', 0)).toBeUndefined()
    expect(dig(null, 'a')).toBeUndefined()
  })
})
