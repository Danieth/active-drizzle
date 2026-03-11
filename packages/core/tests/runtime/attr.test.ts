/**
 * Attr system tests — covers all transform types both in isolation
 * (plain function calls) and through the ApplicationRecord Proxy
 * (the real consumer path).
 *
 * No database boot required: ApplicationRecord's constructor + Proxy
 * work entirely off in-memory _attributes state.
 */

import { describe, it, expect } from 'vitest'
import { Attr } from '../../src/runtime/attr.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'

// ---------------------------------------------------------------------------
// Attr.enum — isolated
// ---------------------------------------------------------------------------

describe('Attr.enum — get (integer → label)', () => {
  const assetType = Attr.enum({ jpg: 116, png: 125, gif: 111, mp4: 202 } as const)

  it('maps integer to its label', () => {
    expect(assetType.get!(116)).toBe('jpg')
    expect(assetType.get!(125)).toBe('png')
    expect(assetType.get!(202)).toBe('mp4')
  })

  it('returns null for null input', () => {
    expect(assetType.get!(null)).toBeNull()
    expect(assetType.get!(undefined)).toBeNull()
  })

  it('falls back to raw integer when value is not in map', () => {
    expect(assetType.get!(999)).toBe(999)
  })

  it('exposes _type and values on the config object', () => {
    expect(assetType._type).toBe('enum')
    expect(assetType.values).toEqual({ jpg: 116, png: 125, gif: 111, mp4: 202 })
  })
})

describe('Attr.enum — set (label → integer)', () => {
  const status = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)

  it('maps label string to its integer', () => {
    expect(status.set!('draft')).toBe(0)
    expect(status.set!('sent')).toBe(1)
    expect(status.set!('failed')).toBe(2)
  })

  it('passes through an integer directly', () => {
    expect(status.set!(1)).toBe(1)
  })

  it('returns null for null / undefined', () => {
    expect(status.set!(null)).toBeNull()
    expect(status.set!(undefined)).toBeNull()
  })

  it('returns the raw value when the label is not in the enum (unknown string)', () => {
    // 'archived' is not in the enum — raw value passes through so DB does not corrupt data
    expect(status.set!('archived')).toBe('archived')
  })
})

// ---------------------------------------------------------------------------
// Attr.new — isolated
// ---------------------------------------------------------------------------

describe('Attr.new', () => {
  it('passes the config straight through', () => {
    const attr = Attr.new({ get: v => v * 100, set: v => v / 100 })
    expect(attr.get!(5)).toBe(500)
    expect(attr.set!(500)).toBe(5)
  })

  it('supports default values', () => {
    const attr = Attr.new({ get: v => v, set: v => v, default: 42 })
    expect(attr.default).toBe(42)
  })

  it('supports factory default functions', () => {
    const attr = Attr.new({ get: v => v, set: v => v, default: () => [] })
    expect(typeof attr.default).toBe('function')
    expect((attr.default as () => unknown)()).toEqual([])
  })

  it('validate function returns null on valid value', () => {
    const attr = Attr.new({ get: v => v, set: v => v, validate: v => (v > 0 ? null : 'must be positive') })
    expect(attr.validate!(5)).toBeNull()
  })

  it('validate function returns error message on invalid value', () => {
    const attr = Attr.new({ get: v => v, set: v => v, validate: v => (v > 0 ? null : 'must be positive') })
    expect(attr.validate!(-1)).toBe('must be positive')
  })
})

// ---------------------------------------------------------------------------
// Attr.for — isolated
// ---------------------------------------------------------------------------

describe('Attr.for', () => {
  it('stores _column and passes config through', () => {
    const attr = Attr.for('full_name', { get: (v: string) => v?.trim(), set: (v: string) => v?.trim() })
    expect(attr._column).toBe('full_name')
    expect(attr.get!('  hello  ')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Attr.string / integer / boolean / json — isolated
// ---------------------------------------------------------------------------

describe('Attr.string', () => {
  const attr = Attr.string()

  it('get: coerces to string', () => {
    expect(attr.get!(42)).toBe('42')
    expect(attr.get!(true)).toBe('true')
  })
  it('get: returns null for null', () => { expect(attr.get!(null)).toBeNull() })
  it('set: trims whitespace', () => { expect(attr.set!('  hello  ')).toBe('hello') })
  it('set: returns null for null', () => { expect(attr.set!(null)).toBeNull() })

  it('accepts extra config (e.g. validate)', () => {
    const required = Attr.string({ validate: v => (v ? null : 'required') })
    expect(required.validate!('')).toBe('required')
    expect(required.validate!('hello')).toBeNull()
  })
})

describe('Attr.integer', () => {
  const attr = Attr.integer()

  it('get: coerces to number', () => {
    expect(attr.get!('42')).toBe(42)
    expect(attr.get!(3.7)).toBe(3.7)
  })
  it('get: returns null for null', () => { expect(attr.get!(null)).toBeNull() })
  it('get: returns null for undefined', () => { expect(attr.get!(undefined)).toBeNull() })
  it('set: coerces to number', () => { expect(attr.set!('5')).toBe(5) })
  it('set: returns null for null', () => { expect(attr.set!(null)).toBeNull() })
  it('set: returns null for undefined', () => { expect(attr.set!(undefined)).toBeNull() })
})

describe('Attr.boolean', () => {
  const attr = Attr.boolean()

  it('get: coerces to boolean', () => {
    expect(attr.get!(1)).toBe(true)
    expect(attr.get!(0)).toBe(false)
    expect(attr.get!('true')).toBe(true)
  })
  it('get: returns null for null', () => { expect(attr.get!(null)).toBeNull() })
  it('get: returns null for undefined', () => { expect(attr.get!(undefined)).toBeNull() })
  it('set: coerces to boolean', () => {
    expect(attr.set!(1)).toBe(true)
    expect(attr.set!(0)).toBe(false)
  })
  it('set: returns null for null', () => { expect(attr.set!(null)).toBeNull() })
  it('set: returns null for undefined', () => { expect(attr.set!(undefined)).toBeNull() })
})

describe('Attr.json', () => {
  const attr = Attr.json<{ tags: string[] }>()

  it('get: deserialises JSON string', () => {
    expect(attr.get!('{"tags":["a","b"]}')).toEqual({ tags: ['a', 'b'] })
  })
  it('get: passes through already-parsed objects', () => {
    const obj = { tags: ['a'] }
    expect(attr.get!(obj)).toBe(obj)
  })
  it('get: returns null for null', () => { expect(attr.get!(null)).toBeNull() })
  it('get: returns null for undefined', () => { expect(attr.get!(undefined)).toBeNull() })
  it('get: returns raw string when JSON.parse throws (malformed input)', () => {
    // Malformed JSON — the catch branch returns the raw input unchanged
    const result = attr.get!('not valid json {{{')
    expect(result).toBe('not valid json {{{')
  })
  it('set: serialises object to JSON string', () => {
    expect(attr.set!({ tags: ['x'] })).toBe('{"tags":["x"]}')
  })
  it('set: passes through already-serialised string', () => {
    expect(attr.set!('{"tags":[]}')). toBe('{"tags":[]}')
  })
  it('set: returns null for null', () => { expect(attr.set!(null)).toBeNull() })
  it('set: returns null for undefined', () => { expect(attr.set!(undefined)).toBeNull() })
})

// ---------------------------------------------------------------------------
// ApplicationRecord Proxy integration — Attr get/set through an instance
// ---------------------------------------------------------------------------

describe('ApplicationRecord Proxy — Attr.enum integration', () => {
  class Post extends ApplicationRecord {
    static status = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)
  }

  it('get: reads integer from _attributes and returns label', () => {
    const post = new Post({ id: 1, status: 1 }, false)
    expect((post as any).status).toBe('sent')
  })

  it('set: writes label and stores integer in _changes', () => {
    const post = new Post({ id: 1, status: 0 }, false)
    ;(post as any).status = 'sent'
    expect(post._changes.get('status')).toEqual({ was: 'draft', is: 1 })
  })

  it('set: does not add to _changes when value is unchanged', () => {
    const post = new Post({ id: 1, status: 0 }, false)
    ;(post as any).status = 'draft' // same value
    expect(post._changes.has('status')).toBe(false)
  })

  it('new record: returns default value when attr has one', () => {
    class WithDefault extends ApplicationRecord {
      static status = { ...Attr.enum({ draft: 0, published: 1 } as const), default: 0 }
    }
    const a = new WithDefault({}, true)
    expect((a as any).status).toBe('draft')
  })
})

// ---------------------------------------------------------------------------
// is<Label>() and to<Label>() proxy-synthesised methods
// ---------------------------------------------------------------------------

describe('ApplicationRecord Proxy — is<Label>() predicates', () => {
  class Asset extends ApplicationRecord {
    static assetType = Attr.enum({ jpg: 116, png: 125, gif: 111 } as const)
  }

  it('isJpg() returns true when assetType is jpg', () => {
    const a = new Asset({ id: 1, assetType: 116 }, false)
    expect((a as any).isJpg()).toBe(true)
    expect((a as any).isPng()).toBe(false)
  })

  it('isGif() returns false before and true after setting gif', () => {
    const a = new Asset({ id: 1, assetType: 116 }, false)
    expect((a as any).isGif()).toBe(false)
    ;(a as any).assetType = 'gif'
    expect((a as any).isGif()).toBe(true)
  })
})

describe('ApplicationRecord Proxy — to<Label>() bang setters', () => {
  class Asset extends ApplicationRecord {
    static assetType = Attr.enum({ jpg: 116, png: 125 } as const)
  }

  it('toPng() sets assetType and returns the instance', () => {
    const a = new Asset({ id: 1, assetType: 116 }, false)
    const returned = (a as any).toPng()
    expect((a as any).assetType).toBe('png')
    expect(returned).toBe(a)
  })
})

// ---------------------------------------------------------------------------
// Dirty tracking helpers — <field>Changed / <field>Was / <field>Change
// ---------------------------------------------------------------------------

describe('ApplicationRecord Proxy — dirty tracking helpers', () => {
  class Post extends ApplicationRecord {
    static status = Attr.enum({ draft: 0, sent: 1 } as const)
  }

  it('<field>Changed() is false before any change', () => {
    const p = new Post({ id: 1, status: 0 }, false)
    expect((p as any).statusChanged()).toBe(false)
  })

  it('<field>Changed() is true after a change', () => {
    const p = new Post({ id: 1, status: 0 }, false)
    ;(p as any).status = 'sent'
    expect((p as any).statusChanged()).toBe(true)
  })

  it('<field>Was() returns original value', () => {
    const p = new Post({ id: 1, status: 0 }, false)
    ;(p as any).status = 'sent'
    expect((p as any).statusWas()).toBe('draft')
  })

  it('<field>Change() returns [was, is] tuple', () => {
    const p = new Post({ id: 1, status: 0 }, false)
    ;(p as any).status = 'sent'
    expect((p as any).statusChange()).toEqual(['draft', 1])
  })

  it('<field>Change() returns null when unchanged', () => {
    const p = new Post({ id: 1, status: 0 }, false)
    expect((p as any).statusChange()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attr.date — isolated
// ---------------------------------------------------------------------------

describe('Attr.date', () => {
  const attr = Attr.date()

  it('get: passes through a Date object unchanged', () => {
    const d = new Date('2024-06-15')
    expect(attr.get!(d)).toBe(d)
  })

  it('get: parses an ISO string into a Date', () => {
    const result = attr.get!('2024-06-15T00:00:00.000Z') as Date
    expect(result).toBeInstanceOf(Date)
    expect(result.getFullYear()).toBe(2024)
  })

  it('get: parses a unix timestamp (number)', () => {
    const ts = 1718400000000
    const result = attr.get!(ts) as Date
    expect(result).toBeInstanceOf(Date)
    expect(result.getTime()).toBe(ts)
  })

  it('get: returns null for null / undefined', () => {
    expect(attr.get!(null)).toBeNull()
    expect(attr.get!(undefined)).toBeNull()
  })

  it('get: returns null for invalid strings', () => {
    expect(attr.get!('not-a-date')).toBeNull()
  })

  it('set: passes through a Date object', () => {
    const d = new Date('2024-01-01')
    expect(attr.set!(d)).toBe(d)
  })

  it('set: coerces an ISO string to a Date', () => {
    const result = attr.set!('2024-03-10') as Date
    expect(result).toBeInstanceOf(Date)
  })

  it('set: returns null for null / undefined', () => {
    expect(attr.set!(null)).toBeNull()
    expect(attr.set!(undefined)).toBeNull()
  })

  it('set: returns null for invalid strings', () => {
    expect(attr.set!('garbage')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Attr.decimal — isolated
// ---------------------------------------------------------------------------

describe('Attr.decimal', () => {
  const attr = Attr.decimal()

  it('get: coerces a decimal string to a number', () => {
    expect(attr.get!('19.99')).toBe(19.99)
    expect(attr.get!('0.2')).toBeCloseTo(0.2)
  })

  it('get: coerces an integer string to a number', () => {
    expect(attr.get!('100')).toBe(100)
  })

  it('get: returns null for null / undefined', () => {
    expect(attr.get!(null)).toBeNull()
    expect(attr.get!(undefined)).toBeNull()
  })

  it('get: returns null for non-numeric strings', () => {
    expect(attr.get!('abc')).toBeNull()
  })

  it('set: stores a number as its string representation', () => {
    expect(attr.set!(0.2)).toBe('0.2')
    expect(attr.set!(100)).toBe('100')
  })

  it('set: stores a string as-is', () => {
    expect(attr.set!('19.99')).toBe('19.99')
  })

  it('set: returns null for null / undefined', () => {
    expect(attr.set!(null)).toBeNull()
    expect(attr.set!(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validate() integration with Attr config
// ---------------------------------------------------------------------------

describe('ApplicationRecord.validate() with Attr', () => {
  class Product extends ApplicationRecord {
    static price = Attr.new({
      get: (v: number | null) => (v === null ? null : v / 100),
      set: (v: number | null) => (v === null ? null : Math.round(v * 100)),
      validate: (v: number | null) => (v !== null && v >= 0 ? null : 'price must be non-negative'),
    })
  }

  it('passes when value is valid', async () => {
    const p = new Product({ id: 1, price: 500 }, false)
    expect(await p.validate()).toBe(true)
    expect(p.errors).toEqual({})
  })

  it('fails when value is invalid', async () => {
    const p = new Product({ id: 1, price: -100 }, false)
    expect(await p.validate()).toBe(false)
    expect(p.errors['price']).toContain('price must be non-negative')
  })
})

// ---------------------------------------------------------------------------
// Attr.for() — column remapping through the Proxy
// ---------------------------------------------------------------------------

describe('Attr.for() — column remapping', () => {
  class Widget extends ApplicationRecord {
    static displayName = Attr.for('fullName', {
      get: (v: any) => v?.trim() ?? null,
      set: (v: any) => (v ?? '').trim(),
    })
  }

  it('get reads from the mapped column (_attributes.fullName), not the property name', () => {
    const w = new Widget({ fullName: '  Alice  ' }, false)
    expect((w as any).displayName).toBe('Alice')
  })

  it('set writes changes under the mapped column key', () => {
    const w = new Widget({ fullName: 'Alice' }, false)
    ;(w as any).displayName = ' Bob '
    expect(w._changes.has('fullName')).toBe(true)
    expect(w._changes.get('fullName')?.is).toBe('Bob')
  })

  it('dirty tracking uses the mapped column key', () => {
    const w = new Widget({ fullName: 'Alice' }, false)
    ;(w as any).displayName = 'Bob'
    expect((w as any).fullNameChanged()).toBe(true)
    expect((w as any).fullNameWas()).toBe('Alice')
  })

  it('restores to original mapped-column value via restoreAttributes()', () => {
    const w = new Widget({ fullName: 'Alice' }, false)
    ;(w as any).displayName = 'Bob'
    w.restoreAttributes()
    expect(w._changes.size).toBe(0)
    expect((w as any).displayName).toBe('Alice')
  })
})
