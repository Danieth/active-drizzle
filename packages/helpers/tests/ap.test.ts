import { describe, it, expect, vi } from 'vitest'
import { ap, apFormat } from '../src/ap.js'

// All tests use colors: false for deterministic output
const opts = { colors: false } as const

describe('scalars', () => {
  it('formats primitives', () => {
    expect(apFormat(null, opts)).toBe('nil')
    expect(apFormat(undefined, opts)).toBe('undefined')
    expect(apFormat('hi', opts)).toBe('"hi"')
    expect(apFormat(42, opts)).toBe('42')
    expect(apFormat(42n, opts)).toBe('42n')
    expect(apFormat(true, opts)).toBe('true')
    expect(apFormat(false, opts)).toBe('false')
  })

  it('formats dates, regexps, errors, functions', () => {
    expect(apFormat(new Date('2026-01-01T00:00:00Z'), opts)).toBe('2026-01-01T00:00:00.000Z')
    expect(apFormat(/ab+c/gi, opts)).toBe('/ab+c/gi')
    expect(apFormat(new TypeError('boom'), opts)).toBe('TypeError: boom')
    function myFn() {}
    expect(apFormat(myFn, opts)).toBe('[Function: myFn]')
  })
})

describe('arrays — awesome_print index style', () => {
  it('prints indexed elements', () => {
    expect(apFormat([1, 'two', null], opts)).toBe(
      '[\n' +
      '    [0] 1,\n' +
      '    [1] "two",\n' +
      '    [2] nil\n' +
      ']'
    )
  })

  it('right-aligns indices for 10+ elements', () => {
    const out = apFormat(Array.from({ length: 11 }, (_, i) => i), opts)
    expect(out).toContain('[ 0] 0')
    expect(out).toContain('[10] 10')
  })

  it('empty array', () => {
    expect(apFormat([], opts)).toBe('[]')
  })

  it('nested arrays indent correctly', () => {
    expect(apFormat([[1]], opts)).toBe(
      '[\n' +
      '    [0] [\n' +
      '        [0] 1\n' +
      '    ]\n' +
      ']'
    )
  })
})

describe('objects — aligned keys', () => {
  it('right-aligns keys like awesome_print', () => {
    expect(apFormat({ id: 1, name: 'x' }, opts)).toBe(
      '{\n' +
      '      id: 1,\n' +
      '    name: "x"\n' +
      '}'
    )
  })

  it('empty object', () => {
    expect(apFormat({}, opts)).toBe('{}')
  })

  it('includes class name for non-plain objects', () => {
    class User { id = 1 }
    expect(apFormat(new User(), opts)).toBe(
      '#<User> {\n' +
      '    id: 1\n' +
      '}'
    )
  })

  it('sortKeys option', () => {
    const out = apFormat({ b: 1, a: 2 }, { ...opts, sortKeys: true })
    expect(out.indexOf('a:')).toBeLessThan(out.indexOf('b:'))
  })
})

describe('maps and sets', () => {
  it('renders Map with => arrows', () => {
    const m = new Map<string, number>([['one', 1], ['three', 3]])
    expect(apFormat(m, opts)).toBe(
      'Map {\n' +
      '      one => 1,\n' +
      '    three => 3\n' +
      '}'
    )
    expect(apFormat(new Map(), opts)).toBe('Map {}')
  })

  it('renders Set as indexed list', () => {
    expect(apFormat(new Set([1, 2]), opts)).toBe(
      'Set [\n' +
      '    [0] 1,\n' +
      '    [1] 2\n' +
      ']'
    )
  })
})

describe('guards', () => {
  it('handles circular references', () => {
    const obj: any = { a: 1 }
    obj.self = obj
    expect(apFormat(obj, opts)).toContain('[Circular]')
  })

  it('respects depth limit', () => {
    const deep = { a: { b: { c: { d: 1 } } } }
    expect(apFormat(deep, { ...opts, depth: 2 })).toContain('...')
  })
})

describe('colors', () => {
  it('adds ANSI codes when colors enabled', () => {
    expect(apFormat('hi', { colors: true })).toBe('\x1b[33m"hi"\x1b[0m')
    expect(apFormat(null, { colors: true })).toBe('\x1b[31mnil\x1b[0m')
  })
})

describe('ap()', () => {
  it('prints and returns the value (pass-through)', () => {
    const out = vi.fn()
    const value = { a: 1 }
    const returned = ap(value, { colors: false, out })
    expect(returned).toBe(value)
    expect(out).toHaveBeenCalledWith('{\n    a: 1\n}')
  })

  it('defaults to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    ap(1, { colors: false })
    expect(spy).toHaveBeenCalledWith('1')
    spy.mockRestore()
  })
})
