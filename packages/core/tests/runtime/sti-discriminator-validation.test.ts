/**
 * Implicit NOT NULL validation must skip the STI discriminator by the SAME
 * condition save()/insertAll stamp it: `ctor.stiTypeColumn ?? 'type'` when
 * `ctor.stiType !== undefined`. Hardcoding the literal column 'type' (or a
 * truthiness test on stiType) fails "can't be blank" on a NOT NULL custom
 * discriminator — before the stamping in runWritePhase ever runs — so
 * create() is blocked for exactly the models the stamping supports.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'

const media = pgTable('media', {
  id:    serial('id').primaryKey(),
  title: text('title').notNull(),
  kind:  text('kind').notNull(),          // custom STI discriminator — NOT NULL, no default
})

const signals = pgTable('signals', {
  id:   serial('id').primaryKey(),
  type: integer('type').notNull(),        // default-named discriminator with a FALSY stiType
})

@model('media')
class Media extends ApplicationRecord {}
void Media

@model('media')
class Video extends Media {
  static stiTypeColumn = 'kind'
  static stiType = 'video'
}

/** NOT an STI model — its NOT NULL 'kind' column must still be validated. */
@model('media')
class PlainMedia extends ApplicationRecord {}

@model('signals')
class ZeroSignal extends ApplicationRecord {
  static stiType = 0                       // defined-but-falsy discriminator value
}

let inserted: any[]
const mockDb: any = {
  query: new Proxy({}, { get: () => ({ findMany: vi.fn(async () => []) }) }),
  insert: vi.fn(() => ({ values: vi.fn((v: any) => { inserted.push(v); return { returning: vi.fn(async () => [{ id: 1, ...v }]) } }) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1 }]) })) })) })),
  delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
  transaction: vi.fn((cb: any) => cb(mockDb)),
}

beforeAll(() => {
  boot(mockDb, { media, signals })
})

describe('custom stiTypeColumn discriminator', () => {
  it('validate() does not report the discriminator as blank — save() stamps it', async () => {
    inserted = []
    const v = new Video({ title: 't' }, true)
    expect(await v.validate()).toBe(true)
  })

  it('create() succeeds and the INSERT payload carries the stamped discriminator', async () => {
    inserted = []
    const v = await (Video as any).create({ title: 't' })
    expect(v.isNewRecord).toBe(false)
    expect(inserted[0].kind).toBe('video')
  })

  it('a NON-STI model with the same NOT NULL column still gets the blank error', async () => {
    const p = new PlainMedia({ title: 't' }, true)
    expect(await p.validate()).toBe(false)
    expect(p.errors.on('kind')).toEqual(["can't be blank"])
  })

  it('other NOT NULL columns on the STI subclass are still validated', async () => {
    const v = new Video({}, true)          // title missing
    expect(await v.validate()).toBe(false)
    expect(v.errors.on('title')).toEqual(["can't be blank"])
    expect(v.errors.on('kind')).toEqual([])
  })
})

describe('defined-but-falsy stiType (0 / empty string)', () => {
  it('skips the discriminator by `!== undefined`, matching the stamping condition', async () => {
    inserted = []
    const s = new ZeroSignal({}, true)
    expect(await s.validate()).toBe(true)
    expect(await s.save()).toBe(true)
    expect(inserted[0].type).toBe(0)       // stamped, not blank
  })
})
