/**
 * FAIL LOUDLY (design philosophy rule #3).
 *
 * Encryption removes most of the query surface, and the failures are silently
 * WRONG rather than loud — a randomized column GROUP BYs into one group per
 * row, COUNT(DISTINCT) returns the row count, a UNIQUE index never fires.
 * Nothing else will ever tell you, so every impossible operation must throw
 * with a message that names the fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { pgTable, integer, text } from 'drizzle-orm/pg-core'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { Attr } from '../../src/runtime/attr.js'
import { model } from '../../src/runtime/decorators.js'
import { envKeyProvider, setKeyProvider, clearKeyProvider } from '../../src/runtime/encryption.js'

const people = pgTable('people', {
  id:        integer('id').primaryKey(),
  name:      text('name'),
  ssn:       text('ssn'),        // randomized
  email:     text('email'),      // deterministic
  phone:     text('phone'),      // blind index (query rewrite not implemented yet)
})

@model('people')
class Person extends ApplicationRecord {
  static ssn   = Attr.string().encrypt!()
  static email = Attr.string().encrypt!({ deterministic: true })
  static phone = Attr.string().encrypt!({ blindIndex: 'phoneBidx' })
}

beforeAll(() => { boot({} as any, { people } as any) })
beforeEach(() => setKeyProvider(envKeyProvider({
  ACTIVE_DRIZZLE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
})))
afterEach(() => clearKeyProvider())

const rel = () => new Relation(Person as any)

describe('ordering is impossible on any encrypted field', () => {
  it('order() throws for randomized AND deterministic', () => {
    expect(() => rel().order('ssn')).toThrow(/cannot ORDER BY encrypted field/i)
    expect(() => rel().order('email')).toThrow(/cannot ORDER BY encrypted field/i)
  })

  it('the message names the model, the field, and the fix', () => {
    expect(() => rel().order('ssn')).toThrow(/Person\.ssn/)
    expect(() => rel().order('ssn')).toThrow(/plaintext column/i)
  })

  it('plaintext columns still sort fine', () => {
    expect(() => rel().order('name')).not.toThrow()
  })
})

describe('keyset pagination needs ordering, so it is impossible too', () => {
  it('seek() throws', () => {
    expect(() => rel().seek(['ssn'])).toThrow(/keyset-paginate/i)
    expect(() => rel().seek(['email'])).toThrow(/keyset-paginate/i)
  })
})

describe('text search can never work on ciphertext', () => {
  it('search() throws', () => {
    expect(() => rel().search('smith', ['ssn'])).toThrow(/text-search/i)
  })
  it('ftsSearch() throws', () => {
    expect(() => rel().ftsSearch('smith', { ssn: 'A' })).toThrow(/text-search/i)
  })
  it('searching a plaintext column is unaffected', () => {
    expect(() => rel().search('smith', ['name'])).not.toThrow()
  })
})

describe('aggregates are impossible', () => {
  it('sum/average/minimum/maximum throw', async () => {
    await expect(rel().sum('ssn')).rejects.toThrow(/aggregate/i)
    await expect(rel().average('ssn')).rejects.toThrow(/aggregate/i)
    await expect(rel().minimum('email')).rejects.toThrow(/aggregate/i)
    await expect(rel().maximum('email')).rejects.toThrow(/aggregate/i)
  })
})

describe('where() — equality only, deterministic only', () => {
  it('randomized equality throws (it could never match)', () => {
    expect(() => rel().where({ ssn: '123-45-6789' })).toThrow(/cannot filter encrypted field/i)
  })

  it('deterministic equality is ALLOWED — this is the whole point', () => {
    expect(() => rel().where({ email: 'a@b.co' })).not.toThrow()
  })

  it('range filters throw on every mode', () => {
    expect(() => rel().where({ email: { gte: 'a' } })).toThrow(/range-filter/i)
    expect(() => rel().where({ ssn: { lte: 'z' } })).toThrow(/range-filter/i)
  })

  it('IS NULL works on every mode — NULL is never encrypted', () => {
    expect(() => rel().where({ ssn: null })).not.toThrow()
    expect(() => rel().where({ email: null })).not.toThrow()
  })

  it('blind-index fields throw until the query rewrite exists (honest, not silent)', () => {
    expect(() => rel().where({ phone: '555-1234' })).toThrow(/cannot filter encrypted field/i)
  })
})

describe('grouping / distinct — deterministic is correct, randomized is not', () => {
  it('randomized GROUP BY throws (it would yield one group per row)', () => {
    expect(() => rel().group('ssn')).toThrow(/cannot GROUP BY encrypted field/i)
  })

  it('deterministic GROUP BY is allowed (equal values really do group)', () => {
    expect(() => rel().group('email')).not.toThrow()
  })

  it('randomized DISTINCT throws; deterministic is allowed', () => {
    expect(() => rel().distinct('ssn')).toThrow(/SELECT DISTINCT/i)
    expect(() => rel().distinct('email')).not.toThrow()
  })
})
