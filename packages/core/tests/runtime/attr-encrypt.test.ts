/**
 * `.encrypt()` is a CODEC, not a type — it must compose with every Attr kind,
 * preserve the underlying transform, and keep NULL as NULL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Attr } from '../../src/runtime/attr.js'
import {
  envKeyProvider, setKeyProvider, clearKeyProvider, isEncrypted,
} from '../../src/runtime/encryption.js'

beforeEach(() => setKeyProvider(envKeyProvider({
  ACTIVE_DRIZZLE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ACTIVE_DRIZZLE_ENCRYPTION_KEY_ID: 'v1',
})))
afterEach(() => clearKeyProvider())

/** Simulates the DB round-trip: model value → set() → column → get() → model value. */
const roundTrip = (attr: any, value: any) => attr.get(attr.set(value))

describe('the chainable exists on every Attr kind', () => {
  it('is available on scalar, money, json, date, and namespaced factories', () => {
    expect(typeof Attr.string().encrypt).toBe('function')
    expect(typeof Attr.integer().encrypt).toBe('function')
    expect(typeof Attr.boolean().encrypt).toBe('function')
    expect(typeof Attr.json().encrypt).toBe('function')
    expect(typeof Attr.date().encrypt).toBe('function')
    expect(typeof Attr.money('cents').encrypt).toBe('function')
    expect(typeof Attr.array.string().encrypt).toBe('function')   // callable namespace
  })

  it('is NON-enumerable — never leaks into Object.keys / JSON / codegen', () => {
    const a = Attr.string()
    expect(Object.keys(a)).not.toContain('encrypt')
    expect(JSON.stringify(a)).not.toContain('encrypt')
  })

  it('leaves the original Attr untouched (returns a new config)', () => {
    const plain = Attr.string()
    const enc = plain.encrypt!()
    expect(plain._encrypted).toBeUndefined()
    expect(enc._encrypted).toEqual({ mode: 'randomized' })
  })
})

describe('composition with the underlying codec', () => {
  it('string round-trips', () => {
    expect(roundTrip(Attr.string().encrypt!(), 'hello')).toBe('hello')
  })

  it('money still does dollars↔cents — type survives, value is ciphertext at rest', () => {
    const attr = Attr.money('priceInCents').encrypt!()
    const stored = attr.set!(49.99)
    expect(isEncrypted(stored)).toBe(true)            // ciphertext in the column
    expect(String(stored)).not.toContain('4999')      // and the value isn't visible
    expect(attr.get!(stored)).toBe(49.99)             // …but the codec still works
  })

  it('integer stays a NUMBER (not stringified) through the round-trip', () => {
    const v = roundTrip(Attr.integer().encrypt!(), 42)
    expect(v).toBe(42)
    expect(typeof v).toBe('number')
  })

  it('boolean stays a boolean', () => {
    expect(roundTrip(Attr.boolean().encrypt!(), true)).toBe(true)
    expect(roundTrip(Attr.boolean().encrypt!(), false)).toBe(false)
  })

  it('json round-trips a whole object', () => {
    const obj = { a: 1, nested: { b: [1, 2, 3] } }
    expect(roundTrip(Attr.json().encrypt!(), obj)).toEqual(obj)
  })

  it('NULL stays NULL so IS NULL keeps working', () => {
    const attr = Attr.string().encrypt!()
    expect(attr.set!(null)).toBeNull()
    expect(attr.get!(null)).toBeNull()
  })
})

describe('modes', () => {
  it('randomized (default) → different ciphertext each write, so it can never be matched', () => {
    const attr = Attr.string().encrypt!()
    expect(attr.set!('same')).not.toBe(attr.set!('same'))
    expect(attr._encrypted!.mode).toBe('randomized')
  })

  it('deterministic → identical ciphertext, which is what makes where() work', () => {
    const attr = Attr.string().encrypt!({ deterministic: true })
    expect(attr.set!('a@b.co')).toBe(attr.set!('a@b.co'))
    expect(attr._encrypted!.mode).toBe('deterministic')
  })

  it('records blindIndex config for the query layer to pick up', () => {
    const attr = Attr.string().encrypt!({ blindIndex: 'emailBidx', bits: 32 })
    expect(attr._encrypted).toEqual({ mode: 'randomized', blindIndex: 'emailBidx', bits: 32 })
  })
})

describe('the where() equality path — zero new plumbing', () => {
  it('a deterministic search term encrypts to exactly the stored ciphertext', () => {
    // where({ email: 'a@b.co' }) runs the value through Attr.set (see
    // _applyHashWhere), so the predicate matches the column byte-for-byte.
    const attr = Attr.string().encrypt!({ deterministic: true })
    const stored     = attr.set!('a@b.co')   // what a save() wrote
    const searchTerm = attr.set!('a@b.co')   // what where() will compare against
    expect(searchTerm).toBe(stored)
  })

  it('randomized fields can NOT be matched this way (hence the query guards)', () => {
    const attr = Attr.string().encrypt!()
    expect(attr.set!('a@b.co')).not.toBe(attr.set!('a@b.co'))
  })
})
