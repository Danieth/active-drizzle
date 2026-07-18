/**
 * Validates.* — the Rails-style declarative validators.
 *
 * Tested three ways: bare (value-only calls), option gates (if/unless/on/
 * allowNull/allowBlank), and end-to-end through record.validate() where the
 * runner supplies (value, record, key).
 */

import { describe, it, expect } from 'vitest'
import { Validates, isBlank } from '../../src/runtime/validators.js'
import { Attr } from '../../src/runtime/attr.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'

const V = Validates

describe('isBlank', () => {
  it('matches Rails blank?', () => {
    expect(isBlank(null)).toBe(true)
    expect(isBlank(undefined)).toBe(true)
    expect(isBlank('')).toBe(true)
    expect(isBlank('   ')).toBe(true)
    expect(isBlank([])).toBe(true)
    expect(isBlank(0)).toBe(false)      // 0 is present, unlike JS falsiness
    expect(isBlank(false)).toBe(false)  // false is present
    expect(isBlank('a')).toBe(false)
    expect(isBlank([1])).toBe(false)
  })
})

describe('Validates.presence / absence', () => {
  it('presence rejects blanks with the Rails message', () => {
    const v = V.presence()
    expect(v(null)).toBe("can't be blank")
    expect(v('')).toBe("can't be blank")
    expect(v('  ')).toBe("can't be blank")
    expect(v([])).toBe("can't be blank")
    expect(v(0)).toBeNull()
    expect(v(false)).toBeNull()
    expect(v('x')).toBeNull()
  })

  it('absence is the inverse', () => {
    const v = V.absence()
    expect(v('x')).toBe('must be blank')
    expect(v(null)).toBeNull()
  })

  it('custom message wins', () => {
    expect(V.presence({ message: 'required!' })('')).toBe('required!')
  })
})

describe('Validates.length', () => {
  it('min/max/is with Rails messages', () => {
    expect(V.length({ min: 3 })('ab')).toBe('is too short (minimum is 3 characters)')
    expect(V.length({ max: 3 })('abcd')).toBe('is too long (maximum is 3 characters)')
    expect(V.length({ is: 2 })('abc')).toBe('is the wrong length (should be 2 characters)')
    expect(V.length({ min: 2, max: 4 })('abc')).toBeNull()
  })

  it('counts array elements too', () => {
    expect(V.length({ max: 2 })([1, 2, 3])).toBe('is too long (maximum is 2 characters)')
    expect(V.length({ min: 1 })([1])).toBeNull()
  })

  it('skips nil — presence() is the requiredness validator', () => {
    expect(V.length({ min: 3 })(null)).toBeNull()
    expect(V.length({ min: 3 })(undefined)).toBeNull()
  })
})

describe('Validates.numericality', () => {
  it('non-numbers fail, numbers pass', () => {
    const v = V.numericality()
    expect(v('abc')).toBe('is not a number')
    expect(v(NaN)).toBe('is not a number')
    expect(v(5)).toBeNull()
    expect(v('5.5')).toBeNull() // numeric strings accepted, Rails-style
  })

  it('bounds and integer/parity constraints', () => {
    expect(V.numericality({ greaterThan: 0 })(0)).toBe('must be greater than 0')
    expect(V.numericality({ greaterThanOrEqualTo: 0 })(-1)).toBe('must be greater than or equal to 0')
    expect(V.numericality({ lessThan: 100 })(100)).toBe('must be less than 100')
    expect(V.numericality({ lessThanOrEqualTo: 100 })(101)).toBe('must be less than or equal to 100')
    expect(V.numericality({ equalTo: 5 })(4)).toBe('must be equal to 5')
    expect(V.numericality({ otherThan: 0 })(0)).toBe('must be other than 0')
    expect(V.numericality({ onlyInteger: true })(2.5)).toBe('must be an integer')
    expect(V.numericality({ odd: true })(2)).toBe('must be odd')
    expect(V.numericality({ odd: true })(-3)).toBeNull()
    expect(V.numericality({ even: true })(3)).toBe('must be even')
    expect(V.numericality({ in: [1, 10] })(11)).toBe('must be in 1..10')
    expect(V.numericality({ in: [1, 10] })(10)).toBeNull()
  })
})

describe('Validates.format', () => {
  it('with / without regexes', () => {
    expect(V.format({ with: /^[a-z]+$/ })('abc')).toBeNull()
    expect(V.format({ with: /^[a-z]+$/ })('ABC')).toBe('is invalid')
    expect(V.format({ without: /\d/ })('abc1')).toBe('is invalid')
    expect(V.format({ without: /\d/ })('abc')).toBeNull()
  })

  it('is not fooled by stateful /g regexes', () => {
    const v = V.format({ with: /a/g })
    expect(v('a')).toBeNull()
    expect(v('a')).toBeNull() // second call would fail if lastIndex leaked
    expect(v('a')).toBeNull()
  })
})

describe('Validates.inclusion / exclusion', () => {
  it('static lists', () => {
    expect(V.inclusion({ in: ['s', 'm', 'l'] })('xl')).toBe('is not included in the list')
    expect(V.inclusion({ in: ['s', 'm', 'l'] })('m')).toBeNull()
    expect(V.exclusion({ in: ['admin', 'root'] })('admin')).toBe('is reserved')
    expect(V.exclusion({ in: ['admin', 'root'] })('daniel')).toBeNull()
  })

  it('record-derived lists', () => {
    const v = V.inclusion({ in: (r: any) => r.allowedSizes })
    expect(v('m', { allowedSizes: ['s', 'm'] })).toBeNull()
    expect(v('xl', { allowedSizes: ['s', 'm'] })).toBe('is not included in the list')
  })
})

describe('Validates.comparison', () => {
  it('compares against literals', () => {
    expect(V.comparison({ greaterThan: 5 })(5)).toBe('must be greater than 5')
    expect(V.comparison({ greaterThan: 5 })(6)).toBeNull()
  })

  it('compares against other record fields (Dates order correctly)', () => {
    const v = V.comparison({ greaterThan: (r: any) => r.startsAt })
    const record = { startsAt: new Date('2024-01-01') }
    expect(v(new Date('2024-06-01'), record)).toBeNull()
    expect(v(new Date('2023-06-01'), record)).toBe(
      'must be greater than 2024-01-01T00:00:00.000Z'
    )
  })

  it('skips when the operand resolves to nil', () => {
    const v = V.comparison({ lessThan: (r: any) => r.deadline })
    expect(v(5, { deadline: null })).toBeNull()
  })
})

describe('Validates.acceptance / confirmation', () => {
  it('acceptance takes the usual checkbox shapes, nil passes', () => {
    const v = V.acceptance()
    expect(v(true)).toBeNull()
    expect(v('1')).toBeNull()
    expect(v('on')).toBeNull()
    expect(v(false)).toBe('must be accepted')
    expect(v('no')).toBe('must be accepted')
    expect(v(null)).toBeNull()
  })

  it('confirmation matches <key>Confirmation on the record', () => {
    const v = V.confirmation()
    expect(v('secret', { passwordConfirmation: 'secret' }, 'password')).toBeNull()
    expect(v('secret', { passwordConfirmation: 'typo' }, 'password')).toBe("doesn't match password")
    // Confirmation field never assigned → passes (Rails semantics)
    expect(v('secret', {}, 'password')).toBeNull()
  })
})

describe('Validates.email / url / uuid', () => {
  it('email', () => {
    const v = V.email()
    expect(v('daniel@example.com')).toBeNull()
    expect(v('a@b.co')).toBeNull()
    expect(v('not-an-email')).toBe('is not a valid email')
    expect(v('two@@example.com')).toBe('is not a valid email')
    expect(v('has space@example.com')).toBe('is not a valid email')
    expect(v('missing@tld')).toBe('is not a valid email')
  })

  it('url', () => {
    const v = V.url()
    expect(v('https://example.com/x?y=1')).toBeNull()
    expect(v('http://localhost:3000')).toBeNull()
    expect(v('ftp://example.com')).toBe('is not a valid URL')
    expect(v('javascript:alert(1)')).toBe('is not a valid URL')
    expect(v('not a url')).toBe('is not a valid URL')
    expect(V.url({ protocols: ['ftp'] })('ftp://example.com')).toBeNull()
  })

  it('uuid', () => {
    const v = V.uuid()
    expect(v('123e4567-e89b-12d3-a456-426614174000')).toBeNull()
    expect(v('123E4567-E89B-12D3-A456-426614174000')).toBeNull()
    expect(v('not-a-uuid')).toBe('is not a valid UUID')
    expect(v('123e4567e89b12d3a456426614174000')).toBe('is not a valid UUID')
  })
})

describe('shared option gates', () => {
  it('if / unless read the record', () => {
    const v = V.presence({ if: (r: any) => r.strict })
    expect(v('', { strict: true })).toBe("can't be blank")
    expect(v('', { strict: false })).toBeNull()
    const u = V.presence({ unless: (r: any) => r.draft })
    expect(u('', { draft: true })).toBeNull()
    expect(u('', { draft: false })).toBe("can't be blank")
  })

  it("on: 'create' / 'update' gate by isNewRecord", () => {
    const v = V.presence({ on: 'create' })
    expect(v('', { isNewRecord: true })).toBe("can't be blank")
    expect(v('', { isNewRecord: false })).toBeNull()
    const u = V.presence({ on: 'update' })
    expect(u('', { isNewRecord: true })).toBeNull()
    expect(u('', { isNewRecord: false })).toBe("can't be blank")
  })

  it('allowNull / allowBlank skip early', () => {
    expect(V.length({ is: 5, allowNull: true })(null)).toBeNull()
    expect(V.format({ with: /x/, allowBlank: true })('')).toBeNull()
  })

  it('bare calls without a record still validate (gates are skipped)', () => {
    const v = V.presence({ if: (r: any) => r.strict })
    expect(v('')).toBe("can't be blank") // no record → condition ignored, check runs
  })
})

// ---------------------------------------------------------------------------
// End-to-end through record.validate()
// ---------------------------------------------------------------------------

describe('Validates through record.validate()', () => {
  class Invoice extends ApplicationRecord {
    static status = Attr.enum({ draft: 0, sent: 1 } as const)
    static title = Attr.string({
      validates: [
        Validates.presence({ if: (r: any) => r.isSent() }),
        Validates.length({ max: 10 }),
      ],
    })
    static amount = Attr.money('amountCents', {
      validates: Validates.numericality({ greaterThan: 0 }),
    })
    static contact = Attr.string({ validates: Validates.email({ allowBlank: true }) })
  }

  it('conditional presence keyed off enum state', async () => {
    const draft = new Invoice({ id: 1, status: 0, title: null, amountCents: 100, contact: null }, false)
    expect(await draft.validate()).toBe(true)

    const sent = new Invoice({ id: 2, status: 1, title: null, amountCents: 100, contact: null }, false)
    expect(await sent.validate()).toBe(false)
    expect(sent.errors.on('title')).toEqual(["can't be blank"])
  })

  it('money validator sees model units (dollars, not cents)', async () => {
    const inv = new Invoice({ id: 3, status: 0, title: 'ok', amountCents: 0, contact: null }, false)
    expect(await inv.validate()).toBe(false)
    expect(inv.errors.on('amount')).toEqual(['must be greater than 0'])
    ;(inv as any).amount = 12.5
    expect(await inv.validate()).toBe(true)
  })

  it('multiple validators stack their messages', async () => {
    const inv = new Invoice(
      { id: 4, status: 1, title: 'way too long for the limit', amountCents: 100, contact: 'bad' },
      false
    )
    expect(await inv.validate()).toBe(false)
    expect(inv.errors.on('title')).toEqual(['is too long (maximum is 10 characters)'])
    expect(inv.errors.on('contact')).toEqual(['is not a valid email'])
  })

  it('allowBlank lets optional fields stay empty', async () => {
    const inv = new Invoice({ id: 5, status: 0, title: 'ok', amountCents: 100, contact: '' }, false)
    expect(await inv.validate()).toBe(true)
  })
})

describe('Validates.uniqueness (serverValidates)', () => {
  function makeModel(existing: any) {
    class User extends ApplicationRecord {
      static override where(cond: Record<string, any>) {
        ;(User as any).lastWhere = cond
        return { first: async () => existing } as any
      }
      static email = Attr.string({ serverValidates: Validates.uniqueness() })
    }
    return User as any
  }

  it('passes when no record matches', async () => {
    const User = makeModel(null)
    const u = new User({ id: 1, email: 'a@b.co' }, false)
    expect(await u.validate()).toBe(true)
    expect(User.lastWhere).toEqual({ email: 'a@b.co' })
  })

  it('fails when another record holds the value', async () => {
    const User = makeModel({ id: 99 })
    const u = new User({ id: 1, email: 'a@b.co' }, false)
    expect(await u.validate()).toBe(false)
    expect(u.errors.on('email')).toEqual(['has already been taken'])
  })

  it('passes when the match is this record (update case)', async () => {
    const User = makeModel({ id: 1 })
    const u = new User({ id: 1, email: 'a@b.co' }, false)
    expect(await u.validate()).toBe(true)
  })

  it('scope adds record fields to the query', async () => {
    class Account extends ApplicationRecord {
      static override where(cond: Record<string, any>) {
        ;(Account as any).lastWhere = cond
        return { first: async () => null } as any
      }
      static slug = Attr.string({
        serverValidates: Validates.uniqueness({ scope: 'tenantId' }),
      })
    }
    const a = new (Account as any)({ id: 1, slug: 'x', tenantId: 7 }, false)
    expect(await a.validate()).toBe(true)
    expect((Account as any).lastWhere).toEqual({ slug: 'x', tenantId: 7 })
  })

  it('blank values skip the query entirely', async () => {
    let queried = false
    class Thing extends ApplicationRecord {
      static override where() {
        queried = true
        return { first: async () => null } as any
      }
      static code = Attr.string({ serverValidates: Validates.uniqueness() })
    }
    const t = new (Thing as any)({ id: 1, code: null }, false)
    expect(await t.validate()).toBe(true)
    expect(queried).toBe(false)
  })
})
