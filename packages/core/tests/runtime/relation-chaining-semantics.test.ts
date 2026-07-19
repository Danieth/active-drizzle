/**
 * PINS the deliberately mixed chaining semantics (see the Relation class
 * doc): where/order MUTATE in place; group/having/clone CLONE. If a
 * refactor unifies these, this test is the checklist of every call site
 * assumption that must move with it (facet fan-out, whereAny scratch
 * clones, orderByIds).
 */
import { describe, it, expect } from 'vitest'
import { boot } from '../../src/runtime/boot.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { model } from '../../src/runtime/decorators.js'
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core'

const ducks = pgTable('ducks', { id: serial('id').primaryKey(), name: text('name'), size: integer('size') })

@model('ducks')
class Duck extends ApplicationRecord {}

boot({} as any, { ducks })

describe('Relation chaining semantics (pinned)', () => {
  it('where() MUTATES in place and returns this', () => {
    const rel: any = Duck.all()
    const chained = rel.where({ size: 1 })
    expect(chained).toBe(rel)                       // same object
    expect(rel._where.length).toBeGreaterThan(0)    // condition landed on the base
  })

  it('group()/having() CLONE — a shared base never accumulates GROUP BYs', () => {
    const base: any = Duck.all()
    const g1 = base.group('name')
    const g2 = base.group('size')
    expect(g1).not.toBe(base)
    expect(base._group).toHaveLength(0)             // base untouched
    expect(g1._group.map((g: any) => g.field)).toEqual(['name'])
    expect(g2._group.map((g: any) => g.field)).toEqual(['size'])   // independent chains
  })

  it('clone() is the explicit fan-out escape hatch', () => {
    const base: any = Duck.all().where({ size: 2 })
    const fork: any = base.clone()
    fork.where({ name: 'x' })
    expect(base._where).toHaveLength(1)             // fork's narrowing stayed on the fork
    expect(fork._where).toHaveLength(2)
  })
})
