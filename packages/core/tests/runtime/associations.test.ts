/**
 * Association lazy loading tests.
 *
 * Verifies that accessing an association marker on an instance returns:
 *   - belongsTo / hasOne → Promise<record | null>
 *   - hasMany / habtm    → scoped Relation (awaitable)
 *   - hasMany :through   → Relation filtered via subquery through join table
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, MODEL_REGISTRY } from '../../src/runtime/boot.js'
import { Relation } from '../../src/runtime/relation.js'
import { model } from '../../src/runtime/decorators.js'
import { belongsTo, hasMany, hasOne } from '../../src/runtime/markers.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeCol(name: string) { return { columnName: name, _name: name } }

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = fakeCol(c)
  return t
}

function makeDb(rows: any[] = [], joinRows: any[] = []) {
  const captured: { query?: string; config?: any }[] = []

  const findMany = vi.fn(async (cfg: any) => {
    captured.push({ query: 'findMany', config: cfg })
    return rows
  })

  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn(() => chainMock),
    limit: vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    offset: vi.fn(() => chainMock),
    for: vi.fn(() => chainMock),
    then: (res: any, _rej: any) => res(rows),
  }

  const joinChain: any = {
    from: vi.fn(() => joinChain),
    where: vi.fn(() => joinChain),
    then: (res: any) => res(joinRows),
  }

  const db: any = {
    query: {
      businesses: { findMany },
      campaigns: { findMany },
      assets: { findMany },
      users: { findMany },
      text_messages: { findMany },
    },
    select: vi.fn((sel?: any) => {
      if (sel) return joinChain  // subquery select (has selection)
      return chainMock
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([rows[0] ?? { id: 1 }]) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([rows[0] ?? { id: 1 }]) })) })) })),
    transaction: vi.fn((cb: any) => cb(db)),
  }

  return { db, findMany, chainMock, joinChain, captured }
}

// ── Model setup ───────────────────────────────────────────────────────────────

@model('businesses')
class Business extends ApplicationRecord {}

@model('campaigns')
class Campaign extends ApplicationRecord {
  static asset = belongsTo()
}

@model('assets')
class Asset extends ApplicationRecord {
  static business = belongsTo()
  static campaigns = hasMany()
  static primaryCampaign = hasOne('campaigns', { foreignKey: 'primaryAssetId' })
}

@model('users')
class User extends ApplicationRecord {}

@model('text_messages')
class TextMessage extends ApplicationRecord {
  static creator = belongsTo('users', { foreignKey: 'creatorId' })
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const schema = {
  assets: fakeTable(['id', 'title', 'businessId']),
  businesses: fakeTable(['id', 'name']),
  campaigns: fakeTable(['id', 'name', 'assetId', 'primaryAssetId']),
  users: fakeTable(['id', 'name']),
  text_messages: fakeTable(['id', 'content', 'creatorId']),
}

// ── belongsTo lazy loading ────────────────────────────────────────────────────

describe('belongsTo lazy loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a Promise that loads the parent record', async () => {
    const businessRow = { id: 5, name: 'Acme' }
    const mock = makeDb([businessRow])
    boot(mock.db, schema)

    const asset = new Asset({ id: 1, businessId: 5 }, false)
    const business = await (asset as any).business

    expect(business).toBeInstanceOf(Business)
    expect(business._attributes.name).toBe('Acme')
  })

  it('returns null when FK is null', async () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const asset = new Asset({ id: 1, businessId: null }, false)
    const business = await (asset as any).business

    expect(business).toBeNull()
  })

  it('respects explicit foreignKey option', async () => {
    const userRow = { id: 99, name: 'Alice' }
    const mock = makeDb([userRow])
    boot(mock.db, schema)

    const msg = new TextMessage({ id: 1, content: 'Hello', creatorId: 99 }, false)
    const creator = await (msg as any).creator

    expect(creator).toBeInstanceOf(User)
    expect(creator._attributes.id).toBe(99)
  })

  it('resolves association by property name when no explicit table', async () => {
    const mock = makeDb([{ id: 1, businessId: 3 }])
    boot(mock.db, schema)

    // Campaign.asset = belongsTo() — no explicit table, inferred as Asset by name
    const campaign = new Campaign({ id: 1, assetId: 1 }, false)
    // assetId is the FK; "asset" → Asset class in MODEL_REGISTRY
    const loaded = await (campaign as any).asset
    expect(loaded).toBeInstanceOf(Asset)
  })
})

// ── hasMany lazy loading ──────────────────────────────────────────────────────

describe('hasMany lazy loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a scoped Relation filtering by ownerFk', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const asset = new Asset({ id: 7 }, false)
    const rel = (asset as any).campaigns

    expect(rel).toBeInstanceOf(Relation)
    // Should have a WHERE clause for assetId = 7
    expect(rel['_where']).toHaveLength(1)
  })

  it('can be awaited to load records', async () => {
    const campaignRows = [{ id: 1, name: 'C1', assetId: 7 }, { id: 2, name: 'C2', assetId: 7 }]
    const mock = makeDb(campaignRows)
    boot(mock.db, schema)

    const asset = new Asset({ id: 7 }, false)
    const campaigns = await (asset as any).campaigns

    expect(campaigns).toHaveLength(2)
    expect(campaigns[0]).toBeInstanceOf(Campaign)
  })

  it('returns empty relation when owner has no id', () => {
    const mock = makeDb([])
    boot(mock.db, schema)

    const asset = new Asset({ id: null }, false)
    const rel = (asset as any).campaigns
    expect(rel).toBeInstanceOf(Relation)
    expect(rel['_where']).toHaveLength(0)  // no WHERE since id is null
  })
})

// ── hasMany :through lazy loading ─────────────────────────────────────────────

describe('hasMany :through lazy loading', () => {
  @model('teams')
  class Team extends ApplicationRecord {}

  @model('memberships')
  class Membership extends ApplicationRecord {}

  @model('members')
  class Member extends ApplicationRecord {
    static teams = hasMany('teams', { through: 'memberships' })
  }

  const throughSchema = {
    members: fakeTable(['id', 'name']),
    teams: fakeTable(['id', 'name']),
    memberships: fakeTable(['id', 'memberId', 'teamId']),
  }

  it('returns a scoped Relation with a subquery WHERE for through associations', () => {
    const mock = makeDb([])
    boot(mock.db, { ...schema, ...throughSchema })

    const member = new Member({ id: 3 }, false)
    const rel = (member as any).teams

    expect(rel).toBeInstanceOf(Relation)
    // Should have a WHERE clause (the IN subquery)
    expect(rel['_where']).toHaveLength(1)
  })
})

// ── polymorphic belongsTo lazy loading ───────────────────────────────────────

describe('polymorphic belongsTo lazy loading', () => {
  @model('notes')
  class Note extends ApplicationRecord {
    static notable = belongsTo({ polymorphic: true })
  }

  const polymorphicSchema = {
    ...schema,
    notes: fakeTable(['id', 'body', 'notableId', 'notableType']),
  }

  it('routes to the correct model based on <prop>Type column', async () => {
    const assetRow = { id: 7, title: 'Test Asset' }
    const mock = makeDb([assetRow])
    boot(mock.db, polymorphicSchema)

    const note = new Note({ id: 1, notableId: 7, notableType: 'Asset' }, false)
    const notable = await (note as any).notable

    expect(notable).toBeInstanceOf(Asset)
    expect(notable._attributes.id).toBe(7)
  })

  it('returns null when <prop>Id is null', async () => {
    const mock = makeDb([])
    boot(mock.db, polymorphicSchema)

    const note = new Note({ id: 1, notableId: null, notableType: null }, false)
    const notable = await (note as any).notable

    expect(notable).toBeNull()
  })

  it('returns null when the type does not match any registered model', async () => {
    const mock = makeDb([])
    boot(mock.db, polymorphicSchema)

    const note = new Note({ id: 1, notableId: 1, notableType: 'UnknownModel' }, false)
    const notable = await (note as any).notable

    expect(notable).toBeNull()
  })
})

// ── hasMany.order in lazy loading ────────────────────────────────────────────

describe('hasMany.order applied in lazy loading', () => {
  @model('tickets')
  class Ticket extends ApplicationRecord {}

  @model('events')
  class Event extends ApplicationRecord {
    static tickets = hasMany('tickets', { order: { createdAt: 'desc' } } as any)
  }

  const orderedSchema = {
    ...schema,
    tickets: fakeTable(['id', 'eventId', 'createdAt']),
    events: fakeTable(['id']),
  }

  it('returns a Relation with the order pre-applied', async () => {
    const mock = makeDb([])
    boot(mock.db, orderedSchema)

    const event = new Event({ id: 5 }, false)
    const rel = (event as any).tickets  // sync Relation access via Proxy

    // The Relation should have an order clause
    expect((rel as any)._order.length).toBeGreaterThan(0)
  })
})

// ── acceptsNestedAttributesFor runtime ────────────────────────────────────────

describe('acceptsNestedAttributesFor runtime', () => {
  @model('line_items')
  class LineItem extends ApplicationRecord {}

  @model('orders')
  class Order extends ApplicationRecord {
    static lineItems = hasMany('line_items', { acceptsNested: true } as any)
  }

  const nestedSchema = {
    orders: fakeTable(['id']),
    line_items: fakeTable(['id', 'orderId', 'name']),
  }

  function makeNestedDb(orderRow: any = { id: 10 }, lineItemRow: any = { id: 99, orderId: 10, name: 'Widget' }) {
    const db: any = {
      query: {},
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: (r: any) => r([]) })) })) })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockImplementation(() => {
            // First call returns orderRow, second returns lineItemRow
            const callCount = db.insert.mock.calls.length
            return Promise.resolve(callCount <= 1 ? [orderRow] : [lineItemRow])
          })
        }))
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([lineItemRow]) })) })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      transaction: vi.fn((cb: any) => cb(db)),
    }
    return db
  }

  it('creates child records when parent saves with *Attributes array containing new items', async () => {
    const db = makeNestedDb()
    boot(db, nestedSchema)

    const order = new Order({ lineItemsAttributes: [{ name: 'Widget' }] })
    await order.save()

    // Both parent and child inserts were called (total = 2)
    expect(db.insert).toHaveBeenCalledTimes(2)
  })

  it('does not include *Attributes keys in the parent DB payload', async () => {
    const capturedPayloads: any[] = []
    const db = makeNestedDb()
    const origInsert = db.insert
    db.insert = vi.fn((table: any) => {
      const chain = origInsert(table)
      const origValues = chain.values
      chain.values = vi.fn((payload: any) => {
        capturedPayloads.push({ table, payload })
        return origValues(payload)
      })
      return chain
    })
    boot(db, nestedSchema)

    const order = new Order({ lineItemsAttributes: [{ name: 'Widget' }] })
    await order.save()

    // First insert is the parent order — should not have lineItemsAttributes
    const parentInsert = capturedPayloads.find(p => p.table === nestedSchema.orders)
    expect(parentInsert?.payload).not.toHaveProperty('lineItemsAttributes')
  })
})

// ── hasOne lazy loading ───────────────────────────────────────────────────────

describe('hasOne lazy loading', () => {
  it('returns a Promise for the first matching record', async () => {
    const campaignRow = { id: 3, primaryAssetId: 1 }
    const mock = makeDb([campaignRow])
    boot(mock.db, schema)

    const asset = new Asset({ id: 1 }, false)
    const primary = await (asset as any).primaryCampaign

    expect(primary).toBeInstanceOf(Campaign)
    expect(primary._attributes.id).toBe(3)
  })
})
