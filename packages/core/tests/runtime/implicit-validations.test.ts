/**
 * Schema-derived implicit validations — "some validations come from the DB".
 *
 * The drizzle schema already declares NOT NULL, varchar lengths, and integer
 * column widths. validate() turns those into friendly errors instead of raw
 * PG failures (23502 / 22001 / 22003).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { pgTable, integer, smallint, varchar, text, serial } from 'drizzle-orm/pg-core'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { Attr } from '../../src/runtime/attr.js'

const authors = pgTable('authors', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 10 }).notNull(),
  bio: text('bio'),                                    // nullable — no implicit check
  age: smallint('age'),
  rank: integer('rank').notNull().default(0),          // DB default — no presence check
  status: integer('status').notNull(),                 // Attr default fills it
  posts: serial('posts'),
})

@model('authors')
class Author extends ApplicationRecord {
  static status = { ...Attr.integer(), default: 1 }
}

@model('authors')
class LaxAuthor extends ApplicationRecord {
  static implicitValidations = false
}

beforeAll(() => {
  boot({} as any, { authors })
})

describe('NOT NULL → presence', () => {
  it('new record missing a required column fails with a friendly message', async () => {
    const a = new Author({}, true)
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('name')).toEqual(["can't be blank"])
  })

  it('identity, defaulted, nullable, and Attr-defaulted columns are exempt', async () => {
    const a = new Author({ name: 'ok' }, true)
    expect(await a.validate()).toBe(true) // id/posts generated, rank has DB default, status has Attr default, bio/age nullable
  })

  it('explicitly nulling a required column fails', async () => {
    const a = new Author({ name: 'ok' }, true)
    ;(a as any).name = null
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('name')).toEqual(["can't be blank"])
  })

  it('persisted records only check changed columns (partial SELECT stays safe)', async () => {
    // Row loaded WITHOUT the required name column — untouched, so no check.
    const a = new Author({ id: 1, bio: 'hi' }, false)
    expect(await a.validate()).toBe(true)

    ;(a as any).bio = 'still fine'
    expect(await a.validate()).toBe(true)

    ;(a as any).name = null // now name IS being written
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('name')).toEqual(["can't be blank"])
  })
})

describe('varchar(n) → max length', () => {
  it('overlong strings fail with the limit in the message', async () => {
    const a = new Author({ name: 'way too long for ten' }, true)
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('name')).toEqual(['is too long (maximum is 10 characters)'])
  })

  it('exactly at the limit passes', async () => {
    const a = new Author({ name: '1234567890' }, true)
    expect(await a.validate()).toBe(true)
  })
})

describe('integer column widths → bounds', () => {
  it('smallint overflow fails before Postgres sees it', async () => {
    const a = new Author({ name: 'ok', age: 40_000 }, true)
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('age')).toEqual(['must be between -32768 and 32767'])
  })

  it('int4 overflow on an updated column', async () => {
    const a = new Author({ id: 1, name: 'ok', rank: 1 }, false)
    ;(a as any).rank = 3_000_000_000
    expect(await a.validate()).toBe(false)
    expect(a.errors.on('rank')).toEqual(['must be between -2147483648 and 2147483647'])
  })

  it('in-range values pass', async () => {
    const a = new Author({ name: 'ok', age: 30_000 }, true)
    expect(await a.validate()).toBe(true)
  })
})

describe('escape hatches', () => {
  it('static implicitValidations = false disables the whole layer', async () => {
    const a = new (LaxAuthor as any)({}, true)
    expect(await a.validate()).toBe(true)
  })

  it('models whose table is not in the booted schema are skipped', async () => {
    @model('ghosts')
    class Ghost extends ApplicationRecord {}
    const g = new (Ghost as any)({}, true)
    expect(await g.validate()).toBe(true)
  })
})
