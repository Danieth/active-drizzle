/**
 * Integration: Rails-style query methods against a live Postgres DB.
 *
 * Covers:
 *   – find() raises RecordNotFound; findBy() returns null
 *   – first! / last! bang variants
 *   – count, sum, average, minimum, maximum
 *   – tally — grouped count with Attr.enum labels
 *   – exists / any / many / one / empty
 *   – last(n) / take(n) / ids
 *   – pick — first-row pluck
 *   – none() — empty relation short-circuit
 *   – findOrInitializeBy / findOrCreateBy
 *   – findEach — batched iteration
 *   – Custom single-column primary key  (uuid → string PK)
 *   – Composite primary key  (tenantId + userId)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { pgTable, serial, varchar, integer, boolean, text } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

import { boot }                        from '../../src/runtime/boot.js'
import { RecordNotFound, AbortChain }  from '../../src/runtime/boot.js'
import { ApplicationRecord }           from '../../src/runtime/application-record.js'
import { model, afterCommit }          from '../../src/runtime/decorators.js'
import { Attr }                        from '../../src/runtime/attr.js'
import { hasMany, belongsTo }          from '../../src/runtime/markers.js'

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const authors = pgTable('authors', {
  id:        serial('id').primaryKey(),
  name:      varchar('name', { length: 255 }).notNull(),
  country:   varchar('country', { length: 100 }),
  isActive:  boolean('is_active').notNull().default(true),
})

const books = pgTable('books', {
  id:        serial('id').primaryKey(),
  title:     varchar('title', { length: 255 }).notNull(),
  authorId:  integer('author_id').notNull(),
  genre:     integer('genre').notNull().default(0),          // Attr.enum
  priceInCents: integer('price_in_cents').notNull().default(0), // Attr.for
  inStock:   boolean('in_stock').notNull().default(true),
})

/** Custom single-column string PK */
const tokens = pgTable('tokens', {
  token:     varchar('token', { length: 64 }).primaryKey(),
  userId:    integer('user_id').notNull(),
  scopes:    text('scopes'),
})

/** Composite PK table */
const memberships = pgTable('memberships', {
  tenantId:  integer('tenant_id').notNull(),
  userId:    integer('user_id').notNull(),
  role:      varchar('role', { length: 50 }).notNull().default('member'),
})

const authorsRelations    = relations(authors, ({ many })  => ({ books: many(books) }))
const booksRelations      = relations(books,   ({ one  })  => ({ author: one(authors, { fields: [books.authorId], references: [authors.id] }) }))

const schema = { authors, authorsRelations, books, booksRelations, tokens, memberships }

const DDL = `
CREATE TABLE IF NOT EXISTS authors (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(255) NOT NULL,
  country   VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS books (
  id             SERIAL PRIMARY KEY,
  title          VARCHAR(255) NOT NULL,
  author_id      INTEGER NOT NULL,
  genre          INTEGER NOT NULL DEFAULT 0,
  price_in_cents INTEGER NOT NULL DEFAULT 0,
  in_stock       BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS tokens (
  token   VARCHAR(64) PRIMARY KEY,
  user_id INTEGER NOT NULL,
  scopes  TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role      VARCHAR(50) NOT NULL DEFAULT 'member',
  PRIMARY KEY (tenant_id, user_id)
);
`

// ─────────────────────────────────────────────────────────────────────────────
// Models
// ─────────────────────────────────────────────────────────────────────────────

@model('authors')
class Author extends ApplicationRecord {
  static books = hasMany()
}

@model('books')
class Book extends ApplicationRecord {
  static author = belongsTo()
  static genre  = Attr.enum({ fiction: 0, nonfiction: 1, scienceFiction: 2, mystery: 3 } as const)
  static price  = Attr.for('priceInCents', {
    get: (v: number | null) => (v == null ? null : v / 100),
    set: (v: number) => Math.round(v * 100),
  })
}

/** Custom single-column string PK */
@model('tokens')
class Token extends ApplicationRecord {
  static primaryKey = 'token' as const
}

/** Composite PK */
@model('memberships')
class Membership extends ApplicationRecord {
  static primaryKey = ['tenantId', 'userId'] as const
}

// ─────────────────────────────────────────────────────────────────────────────
// Container lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer
let pool: pg.Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('rails_methods_test').withUsername('test').withPassword('test')
    .start()

  pool = new pg.Pool({ connectionString: container.getConnectionUri(), ssl: false })
  await pool.query(DDL)

  const db = drizzle({ client: pool, schema }) as any
  boot(db, schema)
}, 60_000)

afterAll(async () => {
  await pool.end()
  await container.stop()
}, 30_000)

beforeEach(async () => {
  await pool.query(`TRUNCATE authors, books, tokens, memberships RESTART IDENTITY CASCADE`)
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedLibrary() {
  const tolkien  = await Author.create({ name: 'J.R.R. Tolkien', country: 'GB' })
  const asimov   = await Author.create({ name: 'Isaac Asimov',   country: 'US' })
  const agatha   = await Author.create({ name: 'Agatha Christie', country: 'GB' })

  const lotr  = await Book.create({ title: 'Fellowship of the Ring', authorId: tolkien.id, genre: 0, priceInCents: 1499 })
  const found = await Book.create({ title: 'Foundation',             authorId: asimov.id,  genre: 2, priceInCents: 999  })
  const robot = await Book.create({ title: 'I, Robot',              authorId: asimov.id,  genre: 2, priceInCents: 799  })
  const mur   = await Book.create({ title: 'Murder on the Express', authorId: agatha.id,  genre: 3, priceInCents: 1199 })
  const abc   = await Book.create({ title: 'The ABC Murders',       authorId: agatha.id,  genre: 3, priceInCents: 899, inStock: false })

  return { tolkien, asimov, agatha, lotr, found, robot, mur, abc }
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — find() raises RecordNotFound; findBy() returns null
// ─────────────────────────────────────────────────────────────────────────────

describe('find() — Rails semantics', () => {
  it('find(id) returns the record when found', async () => {
    const author = await Author.create({ name: 'Test Author' })
    const found  = await Author.find(author.id)
    expect((found as any)._attributes.name).toBe('Test Author')
  })

  it('find(id) raises RecordNotFound when missing', async () => {
    await expect(Author.find(999_999)).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('RecordNotFound carries model name and id', async () => {
    let err: RecordNotFound | null = null
    try { await Author.find(42) } catch (e: any) { err = e }
    expect(err).not.toBeNull()
    expect(err!.model).toBe('Author')
    expect(err!.id).toBe(42)
    expect(err!.message).toMatch(/Author.*42/)
  })

  it('findBy() returns null when not found (no error)', async () => {
    const result = await Author.findBy({ name: 'Nobody' })
    expect(result).toBeNull()
  })

  it('findBy() returns the record when found', async () => {
    await Author.create({ name: 'Alice' })
    const found = await Author.findBy({ name: 'Alice' }) as any
    expect(found._attributes.name).toBe('Alice')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2 — first! / last! bang variants
// ─────────────────────────────────────────────────────────────────────────────

describe('first! and last! — raise when empty', () => {
  it('firstBang() raises when relation is empty', async () => {
    await expect(Author.all().firstBang()).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('lastBang() raises when relation is empty', async () => {
    await expect(Author.all().lastBang()).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('firstBang() returns the record when one exists', async () => {
    await Author.create({ name: 'First' })
    const a = await Author.all().firstBang()
    expect((a as any)._attributes.name).toBe('First')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3 — last(n) and take(n)
// ─────────────────────────────────────────────────────────────────────────────

describe('last() and take()', () => {
  it('last() returns the last record by pk DESC', async () => {
    await seedLibrary()
    const last = await Author.last() as any
    expect(last._attributes.name).toBe('Agatha Christie')  // highest id
  })

  it('last(2) returns the last 2 records', async () => {
    await seedLibrary()
    const last2 = await Author.last(2) as any[]
    expect(last2.length).toBe(2)
    // returned in ASC order
    expect(last2[0]._attributes.name).toBe('Isaac Asimov')
    expect(last2[1]._attributes.name).toBe('Agatha Christie')
  })

  it('take() returns any single record without caring about order', async () => {
    await seedLibrary()
    const rec = await Author.take()
    expect(rec).not.toBeNull()
  })

  it('take(2) returns 2 records', async () => {
    await seedLibrary()
    const recs = await Author.take(2) as any[]
    expect(recs.length).toBe(2)
  })

  it('last() on filtered relation respects the WHERE', async () => {
    await seedLibrary()
    const last = await Book.where({ genre: 'mystery' } as any).last() as any
    expect(['Murder on the Express', 'The ABC Murders']).toContain(last._attributes.title)
  })

  it('last(n) reverses the descending logic and returns items in ascending chronological order', async () => {
    // If the fix wasn't there, last(2) would return [id 5, id 4] instead of [id 4, id 5]
    await seedLibrary()
    
    // lotr, foundation, robot, mur, abc
    const books = await Book.last(3) as any[]
    expect(books.length).toBe(3)
    
    // They should be in ASCENDING order (the last 3 created)
    expect(books[0]._attributes.title).toBe('I, Robot')
    expect(books[1]._attributes.title).toBe('Murder on the Express')
    expect(books[2]._attributes.title).toBe('The ABC Murders')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Aggregates: count, sum, average, minimum, maximum
// ─────────────────────────────────────────────────────────────────────────────

describe('Aggregate methods', () => {
  it('count() returns total rows', async () => {
    await seedLibrary()
    expect(await Book.count()).toBe(5)
  })

  it('count() on filtered relation', async () => {
    await seedLibrary()
    expect(await Book.where({ genre: 'scienceFiction' } as any).count()).toBe(2)
  })

  it('sum() with Attr.for column mapping returns correct total', async () => {
    await seedLibrary()
    // priceInCents: 1499 + 999 + 799 + 1199 + 899 = 5395 → sum returns raw cents
    const total = await Book.all().sum('priceInCents')
    expect(total).toBe(5395)
  })

  it('average() returns numeric average', async () => {
    await seedLibrary()
    const avg = await Book.all().average('priceInCents')
    expect(avg).toBeCloseTo(1079)  // 5395 / 5
  })

  it('average() returns null for empty relation', async () => {
    expect(await Book.all().average('priceInCents')).toBeNull()
  })

  it('minimum() returns smallest value', async () => {
    await seedLibrary()
    expect(await Book.all().minimum('priceInCents')).toBe(799)
  })

  it('maximum() returns largest value', async () => {
    await seedLibrary()
    expect(await Book.all().maximum('priceInCents')).toBe(1499)
  })

  it('static shortcuts delegate to Relation', async () => {
    await seedLibrary()
    expect(await Book.count()).toBe(5)
    expect(await Book.minimum('priceInCents')).toBe(799)
    expect(await Book.maximum('priceInCents')).toBe(1499)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — tally: grouped count with Attr.enum labels
// ─────────────────────────────────────────────────────────────────────────────

describe('tally() — grouped count with enum labels', () => {
  it('tally("genre") returns label → count map', async () => {
    await seedLibrary()
    const tally = await Book.all().tally('genre')
    // fiction: 1 (LOTR), scienceFiction: 2 (Foundation, I Robot), mystery: 2
    expect(tally['fiction']).toBe(1)
    expect(tally['scienceFiction']).toBe(2)
    expect(tally['mystery']).toBe(2)
  })

  it('tally("country") on a plain string column', async () => {
    await seedLibrary()
    const tally = await Author.all().tally('country')
    expect(tally['GB']).toBe(2)   // Tolkien + Christie
    expect(tally['US']).toBe(1)   // Asimov
  })

  it('tally with a where scope filters correctly', async () => {
    await seedLibrary()
    const tally = await Book.where({ inStock: true } as any).tally('genre')
    expect(tally['mystery']).toBe(1)     // only 'Murder on the Express' (The ABC Murders is out of stock)
    expect(tally['fiction']).toBe(1)
    expect(tally['scienceFiction']).toBe(2)
  })

  it('static tally delegates to Relation', async () => {
    await seedLibrary()
    const tally = await Book.tally('genre')
    expect(Object.keys(tally).length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6 — exists, any, many, one, empty
// ─────────────────────────────────────────────────────────────────────────────

describe('exists / any / many / one / empty', () => {
  it('exists() returns false on empty DB', async () => {
    expect(await Author.exists()).toBe(false)
  })

  it('exists() returns true after creation', async () => {
    await Author.create({ name: 'Exists' })
    expect(await Author.exists()).toBe(true)
  })

  it('exists({ condition }) combines with where', async () => {
    await Author.create({ name: 'UK Author', country: 'GB' })
    expect(await Author.exists({ country: 'GB' })).toBe(true)
    expect(await Author.exists({ country: 'FR' })).toBe(false)
  })

  it('any() is an alias for exists()', async () => {
    expect(await Author.all().any()).toBe(false)
    await Author.create({ name: 'Someone' })
    expect(await Author.all().any()).toBe(true)
  })

  it('empty() is the inverse of exists()', async () => {
    expect(await Author.all().empty()).toBe(true)
    await Author.create({ name: 'Fill' })
    expect(await Author.all().empty()).toBe(false)
  })

  it('many() true only when > 1 record', async () => {
    await Author.create({ name: 'A1' })
    expect(await Author.all().many()).toBe(false)
    await Author.create({ name: 'A2' })
    expect(await Author.all().many()).toBe(true)
  })

  it('one() true only when exactly 1 record', async () => {
    await Author.create({ name: 'Solo' })
    expect(await Author.all().one()).toBe(true)
    await Author.create({ name: 'Duo' })
    expect(await Author.all().one()).toBe(false)
  })

  it('static any/empty/many/one delegate correctly', async () => {
    expect(await Author.empty()).toBe(true)
    await Author.create({ name: 'X' })
    expect(await Author.any()).toBe(true)
    expect(await Author.one()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7 — pick() and ids()
// ─────────────────────────────────────────────────────────────────────────────

describe('pick() and ids()', () => {
  it('pick(col) returns first row value', async () => {
    await Author.create({ name: 'Pick Me', country: 'AU' })
    const name = await Author.order('id', 'asc').pick('name')
    expect(name).toBe('Pick Me')
  })

  it('pick(col1, col2) returns first row object', async () => {
    await Author.create({ name: 'Multi', country: 'NZ' })
    const row = await Author.order('id', 'asc').pick('name', 'country')
    expect(row).toEqual({ name: 'Multi', country: 'NZ' })
  })

  it('pick() returns null on empty relation', async () => {
    expect(await Author.all().pick('name')).toBeNull()
  })

  it('pick() respects Attr.for (price → dollars)', async () => {
    await seedLibrary()
    const cheapest = await Book.all().order('priceInCents', 'asc').pick('price')
    expect(cheapest).toBeCloseTo(7.99)  // 799 cents
  })

  it('ids() returns array of primary keys', async () => {
    await seedLibrary()
    const ids = await Author.all().order('id', 'asc').ids()
    expect(ids.length).toBe(3)
    expect(ids.every((id: any) => typeof id === 'number')).toBe(true)
  })

  it('ids() with where scope', async () => {
    await seedLibrary()
    const ids = await Author.where({ country: 'GB' } as any).ids()
    expect(ids.length).toBe(2)
  })

  it('static pick delegates to Relation', async () => {
    await Author.create({ name: 'Static Pick', country: 'ZA' })
    const name = await Author.pick('name')
    expect(name).toBe('Static Pick')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8 — none() — zero round-trips, empty result
// ─────────────────────────────────────────────────────────────────────────────

describe('none() — empty relation short-circuit', () => {
  it('none().load() returns [] without hitting the DB', async () => {
    await seedLibrary()
    const result = await Author.none().load()
    expect(result).toEqual([])
  })

  it('none().count() returns 0', async () => {
    await seedLibrary()
    expect(await Author.none().count()).toBe(0)
  })

  it('none().exists() returns false', async () => {
    await seedLibrary()
    expect(await Author.none().exists()).toBe(false)
  })

  it('none().pluck() returns []', async () => {
    await seedLibrary()
    expect(await Author.none().pluck('name')).toEqual([])
  })

  it('chaining after none() is still a none Relation', async () => {
    await seedLibrary()
    const result = await Author.none().where({ country: 'GB' } as any).limit(10).load()
    expect(result).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §9 — findOrInitializeBy / findOrCreateBy
// ─────────────────────────────────────────────────────────────────────────────

describe('findOrInitializeBy and findOrCreateBy', () => {
  it('findOrInitializeBy returns existing record when found', async () => {
    await Author.create({ name: 'Existing', country: 'GB' })
    const author = await Author.findOrInitializeBy({ name: 'Existing' }) as any
    expect(author.isNewRecord).toBe(false)
    expect(author._attributes.country).toBe('GB')
  })

  it('findOrInitializeBy returns new (unsaved) instance when not found', async () => {
    const author = await Author.findOrInitializeBy({ name: 'New Author' }) as any
    expect(author.isNewRecord).toBe(true)
    expect(author._attributes.name).toBe('New Author')
    expect(author.id).toBeUndefined()
  })

  it('findOrCreateBy returns existing record', async () => {
    await Author.create({ name: 'AlreadyThere', country: 'CA' })
    const author = await Author.findOrCreateBy({ name: 'AlreadyThere' }) as any
    expect(author.isNewRecord).toBe(false)
    expect(author._attributes.country).toBe('CA')
    // No duplicate created
    expect(await Author.count()).toBe(1)
  })

  it('findOrCreateBy creates record when not found', async () => {
    const author = await Author.findOrCreateBy({ name: 'Brand New', country: 'DE' }) as any
    expect(author.id).toBeGreaterThan(0)
    expect(author.isNewRecord).toBe(false)
    expect(await Author.count()).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §10 — findEach — single-record iteration
// ─────────────────────────────────────────────────────────────────────────────

describe('findEach() — iterate one record at a time', () => {
  it('visits every matching record exactly once', async () => {
    await seedLibrary()
    const visited: string[] = []
    await Author.all().findEach(2, async (author: any) => {
      visited.push(author._attributes.name)
    })
    expect(visited.length).toBe(3)
    expect(visited).toContain('J.R.R. Tolkien')
    expect(visited).toContain('Isaac Asimov')
    expect(visited).toContain('Agatha Christie')
  })

  it('findEach with filter only visits matching records', async () => {
    await seedLibrary()
    const visited: string[] = []
    await Book.where({ genre: 'mystery' } as any).findEach(1, async (book: any) => {
      visited.push(book._attributes.title)
    })
    expect(visited.length).toBe(2)
    expect(visited.every((t: string) => ['Murder on the Express', 'The ABC Murders'].includes(t))).toBe(true)
  })

  it('findEach and inBatches are stable by automatically sorting by PK', async () => {
    await seedLibrary()
    let offsetChecks: number[] = []

    // Before the fix, Postgres could theoretically return items out of order when offset is used without ORDER BY.
    // The query should automatically inject an ORDER BY authors.id ASC
    await Author.all().inBatches(1, async (batch) => {
      const records = await batch.load()
      if (records.length > 0) {
        offsetChecks.push(records[0].id)
      }
    })

    // Validate that it explicitly iterated 1, 2, 3
    expect(offsetChecks).toEqual([1, 2, 3])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §11 — Custom single-column primary key (Token.primaryKey = 'token')
// ─────────────────────────────────────────────────────────────────────────────

describe('Custom primary key — single column string PK', () => {
  it('Token.find("abc") uses token column, not id', async () => {
    // Insert directly — Token.create uses the token as PK
    await pool.query(`INSERT INTO tokens(token, user_id, scopes) VALUES ('tok_abc', 1, 'read')`)

    const token = await Token.find('tok_abc') as any
    expect(token._attributes.token).toBe('tok_abc')
    expect(token._attributes.userId).toBe(1)
  })

  it('Token.find("missing") raises RecordNotFound', async () => {
    await expect(Token.find('tok_does_not_exist')).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('Token save() uses token as PK for UPDATE', async () => {
    await pool.query(`INSERT INTO tokens(token, user_id, scopes) VALUES ('tok_upd', 2, 'read')`)

    const token = await Token.find('tok_upd') as any
    token.scopes = 'read write'
    await token.save()

    const refreshed = await Token.find('tok_upd') as any
    expect(refreshed._attributes.scopes).toBe('read write')
  })

  it('Token.destroy() uses token as PK for DELETE', async () => {
    await pool.query(`INSERT INTO tokens(token, user_id) VALUES ('tok_del', 3)`)
    const token = await Token.find('tok_del') as any
    await token.destroy()
    await expect(Token.find('tok_del')).rejects.toBeInstanceOf(RecordNotFound)
  })

  it('Token.ids() returns token strings', async () => {
    await pool.query(`INSERT INTO tokens(token, user_id) VALUES ('tok_1', 1), ('tok_2', 2)`)
    const ids = await Token.all().order('token', 'asc').ids()
    expect(ids).toEqual(['tok_1', 'tok_2'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §12 — Composite primary key (Membership.primaryKey = ['tenantId', 'userId'])
// ─────────────────────────────────────────────────────────────────────────────

describe('Composite primary key', () => {
  it('save() creates a membership row', async () => {
    const m = new (Membership as any)({ tenantId: 1, userId: 10, role: 'admin' }, true)
    await m.save()

    const rows = await pool.query(`SELECT * FROM memberships WHERE tenant_id=1 AND user_id=10`)
    expect(rows.rows[0].role).toBe('admin')
  })

  it('save() UPDATE uses composite WHERE (tenantId AND userId)', async () => {
    await pool.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES (2, 20, 'member')`)
    const m = new (Membership as any)({ tenantId: 2, userId: 20, role: 'member' }, false)
    m.role = 'moderator'
    await m.save()

    const rows = await pool.query(`SELECT role FROM memberships WHERE tenant_id=2 AND user_id=20`)
    expect(rows.rows[0].role).toBe('moderator')
  })

  it('destroy() uses composite WHERE', async () => {
    await pool.query(`INSERT INTO memberships(tenant_id, user_id, role) VALUES (3, 30, 'member')`)
    const m = new (Membership as any)({ tenantId: 3, userId: 30, role: 'member' }, false)
    await m.destroy()

    const rows = await pool.query(`SELECT * FROM memberships WHERE tenant_id=3 AND user_id=30`)
    expect(rows.rows.length).toBe(0)
  })

  it('ids() returns objects with each PK column for composite keys', async () => {
    await pool.query(`
      INSERT INTO memberships(tenant_id, user_id) VALUES (4, 40), (4, 41)
    `)
    const ids = await Membership.where({ tenantId: 4 } as any).order('userId', 'asc').ids()
    // Composite pluck returns one object per row with each PK column
    expect(ids).toEqual([
      { tenantId: 4, userId: 40 },
      { tenantId: 4, userId: 41 },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §13 — Complex chains combining new methods
// ─────────────────────────────────────────────────────────────────────────────

describe('Complex chains combining new methods', () => {
  it('expensive books: max > threshold, then pick cheapest title', async () => {
    await seedLibrary()
    const maxPrice = await Book.all().maximum('priceInCents')
    expect(maxPrice).toBe(1499)

    const cheapestTitle = await Book.all().order('priceInCents', 'asc').pick('title')
    expect(cheapestTitle).toBe('I, Robot')
  })

  it('author report: name + book count via count() + tally()', async () => {
    await seedLibrary()
    const total   = await Book.count()
    const byGenre = await Book.tally('genre')

    expect(total).toBe(5)
    expect(byGenre['mystery'] + byGenre['fiction'] + byGenre['scienceFiction']).toBe(5)
  })

  it('findOrCreateBy is idempotent under repeated calls', async () => {
    await Author.findOrCreateBy({ name: 'Idempotent', country: 'XX' })
    await Author.findOrCreateBy({ name: 'Idempotent', country: 'XX' })
    await Author.findOrCreateBy({ name: 'Idempotent', country: 'XX' })
    expect(await Author.count()).toBe(1)
  })

  it('exists + none compose correctly: none() overrides exists()', async () => {
    await seedLibrary()
    expect(await Author.exists()).toBe(true)
    expect(await Author.none().exists()).toBe(false)
  })

  it('average across Attr.for field (price in cents)', async () => {
    await seedLibrary()
    // Raw cents: 1499 + 999 + 799 + 1199 + 899 = 5395 / 5 = 1079
    const avg = await Book.all().average('priceInCents')
    expect(avg).toBeCloseTo(1079)
    // In-stock only: 1499 + 999 + 799 + 1199 = 4496 / 4 = 1124
    const avgInStock = await Book.where({ inStock: true } as any).average('priceInCents')
    expect(avgInStock).toBeCloseTo(1124)
  })

  it('hash condition where() works correctly even if the property is aliased by Attr.for', async () => {
    await seedLibrary()
    // Book has: static price = Attr.for("priceInCents")
    // By passing { price: 9.99 }, relation._applyHashWhere should resolve 'price' to 'priceInCents' and query it
    
    const cheapBook = await Book.where({ price: 7.99 } as any).first() as any
    expect(cheapBook).not.toBeNull()
    expect(cheapBook._attributes.title).toBe('I, Robot')
  })
})
