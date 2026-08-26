/**
 * The codec-mapping boundary — property↔column + display↔raw — must be crossed
 * by EVERY write and read path, not re-derived per method. Each test here fails
 * against the pre-fix forked implementation and passes once the path routes
 * through the single boundary (relation.ts: mapWriteAttributes / columnKeyFor /
 * toRawValue).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { Attr } from '../../src/runtime/attr.js'

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, name: c, _name: c }
  return t
}

/**
 * A capture DB that records every insert `.values()` and update `.set()`
 * payload, plus the relational findMany config. Rows returned from queries are
 * configurable.
 */
function captureDb(rows: any[] = []) {
  const inserted: any[] = []
  const updatedSets: any[] = []
  const findManyConfigs: any[] = []
  const findMany = vi.fn(async (cfg: any) => { findManyConfigs.push(cfg); return rows })
  const tableFindMany: Record<string, any> = {}
  const db: any = {
    query: new Proxy({}, { get: () => ({ findMany }) }),
    insert: vi.fn(() => ({ values: vi.fn((v: any) => { (Array.isArray(v) ? inserted.push(...v) : inserted.push(v)); return { returning: vi.fn(async () => [{ id: 1, ...(Array.isArray(v) ? v[0] : v) }]) } }) })),
    update: vi.fn(() => ({ set: vi.fn((s: any) => { updatedSets.push(s); return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 1, ...s }]) })) } }) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => rows) })) })) })),
    transaction: vi.fn((cb: any) => cb(db)),
  }
  void tableFindMany
  return { db, inserted, updatedSets, findManyConfigs, findMany }
}

// ── updateAll — property→column + Attr.set ────────────────────────────────────

describe('updateAll routes through the codec boundary', () => {
  @model('ub_products')
  class UbProduct extends ApplicationRecord {
    static price = Attr.money('priceCents')
  }
  const schema = { ub_products: fakeTable(['id', 'priceCents', 'name']) }

  it('maps an Attr.money property to its column AND runs Attr.set (dollars→cents)', async () => {
    const cap = captureDb([])
    boot(cap.db, schema)
    await UbProduct.all().updateAll({ price: 25 } as any)
    expect(cap.updatedSets).toHaveLength(1)
    // The write must land under the COLUMN `priceCents` as raw cents, never
    // under the property `price` (which drizzle would silently drop).
    expect(cap.updatedSets[0]).toEqual({ priceCents: 2500 })
    expect(cap.updatedSets[0]).not.toHaveProperty('price')
  })
})

// ── insertAll — column mapping + Attr defaults + STI stamp ─────────────────────

describe('insertAll routes through the codec boundary', () => {
  @model('ia_products')
  class IaProduct extends ApplicationRecord {
    static price  = Attr.money('priceCents')
    static status = { ...Attr.enum({ draft: 0, live: 1 } as const), default: 'draft' }
  }
  @model('ia_products')
  class IaDigital extends IaProduct {
    static stiType = 'IaDigital'
  }
  const schema = { ia_products: fakeTable(['id', 'priceCents', 'status', 'type']) }

  it('maps property→column, runs Attr.set, and fills Attr defaults', async () => {
    const cap = captureDb([])
    boot(cap.db, schema)
    const n = await IaProduct.insertAll([{ price: 9.99 }])
    expect(n).toBe(1)
    expect(cap.inserted).toHaveLength(1)
    expect(cap.inserted[0].priceCents).toBe(999)         // dollars→cents under the column
    expect(cap.inserted[0]).not.toHaveProperty('price')  // never the property name
    expect(cap.inserted[0].status).toBe(0)               // Attr default 'draft'→0 applied
  })

  it('stamps the STI discriminator on a subclass bulk insert', async () => {
    const cap = captureDb([])
    boot(cap.db, schema)
    await IaDigital.insertAll([{ price: 1 }])
    expect(cap.inserted[0].type).toBe('IaDigital')
  })
})

// ── INSERT defaults loop — data integrity (NULL into NOT NULL) ─────────────────

describe('INSERT defaults are keyed by column, not property [DATA INTEGRITY]', () => {
  @model('def_products')
  class DefProduct extends ApplicationRecord {
    // money attr with a _column AND a default → the exact shape that used to
    // write the default under `price` and leave the NOT NULL `priceCents` blank
    static price = { ...Attr.money('priceCents'), default: 0 }
  }
  const schema = { def_products: fakeTable(['id', 'priceCents']) }

  it('writes an Attr.money default under its column so a NOT NULL column is filled', async () => {
    const cap = captureDb([])
    boot(cap.db, schema)
    await DefProduct.create({})
    expect(cap.inserted).toHaveLength(1)
    // priceCents must be present (raw 0), NOT left undefined under `price`.
    expect(cap.inserted[0].priceCents).toBe(0)
    expect(cap.inserted[0]).not.toHaveProperty('price')
  })
})

// ── find() — STI type scoping + subclass resolution ───────────────────────────

describe('find() routes through Relation (STI scoping + subclass resolution)', () => {
  @model('sti_things')
  class StiThing extends ApplicationRecord {
    static stiTypeColumn = 'type'
  }
  @model('sti_things')
  class Gadget extends StiThing {
    static stiType = 'Gadget'
  }
  @model('sti_things')
  class Widget extends StiThing {
    static stiType = 'Widget'
  }
  void Widget
  const schema = { sti_things: fakeTable(['id', 'type']) }

  it('a subclass find() injects its type into the WHERE (cannot fetch a sibling row)', async () => {
    const cap = captureDb([{ id: 7, type: 'Gadget' }])
    boot(cap.db, schema)
    await Gadget.find(7)
    // The findMany config must carry a WHERE (pk AND the injected sti type),
    // which the old raw-SELECT find() never did.
    expect(cap.findManyConfigs).toHaveLength(1)
    expect(cap.findManyConfigs[0].where).toBeDefined()
  })

  it('an STI-parent find() downcasts to the registered subclass', async () => {
    const cap = captureDb([{ id: 7, type: 'Gadget' }])
    boot(cap.db, schema)
    const found = await StiThing.find(7)
    expect(found).toBeInstanceOf(Gadget)   // subclass resolution, not base StiThing
  })
})

// ── toJSON / attributes — dirty fields serialize in DISPLAY space ──────────────

describe('serialization keeps dirty fields in display space (no cents/enum-int leak)', () => {
  @model('ser_products')
  class SerProduct extends ApplicationRecord {
    static status = Attr.enum({ draft: 0, live: 1 } as const)
    static price  = Attr.money()   // in-place cents↔dollars under `price`
  }
  const schema = { ser_products: fakeTable(['id', 'status', 'price']) }

  beforeEach(() => boot(captureDb([]).db, schema))

  it('a dirty enum serializes as its label, not the raw int', () => {
    const p = new SerProduct({ id: 1, status: 0, price: 1999 }, false)
    ;(p as any).status = 'live'
    expect(p.attributes.status).toBe('live')       // NOT 1
    expect(p.toJSON().status).toBe('live')
  })

  it('a dirty money field serializes as dollars, not raw cents', () => {
    const p = new SerProduct({ id: 1, status: 0, price: 1999 }, false)
    ;(p as any).price = 25          // dollars in
    expect(p.attributes.price).toBe(25)            // NOT 2500 cents
    expect(p.toJSON().price).toBe(25)
  })
})

// ── restoreAttributes — no codec corruption ───────────────────────────────────

describe('restoreAttributes reverts without corrupting the raw codec', () => {
  @model('res_products')
  class ResProduct extends ApplicationRecord {
    static status = Attr.enum({ draft: 0, live: 1 } as const)
    static price  = Attr.money('priceCents')
  }
  const schema = { res_products: fakeTable(['id', 'status', 'priceCents']) }

  beforeEach(() => boot(captureDb([]).db, schema))

  it('restores enum + money to their original raw values (not display-space)', () => {
    const p = new ResProduct({ id: 1, status: 0, priceCents: 1999 }, false)
    ;(p as any).status = 'live'    // raw would become 1
    ;(p as any).price = 25         // raw would become 2500

    p.restoreAttributes()

    expect(p._changes.size).toBe(0)
    // _attributes must still hold the ORIGINAL raw values — the old code wrote
    // display-space `was` ('draft', 19.99) back into the raw columns.
    expect(p._attributes.status).toBe(0)
    expect(p._attributes.priceCents).toBe(1999)
    // …and reads reflect the original display values again.
    expect((p as any).status).toBe('draft')
    expect((p as any).price).toBe(19.99)
  })
})

// ── tally() — encryption guard ────────────────────────────────────────────────

describe('tally() no longer bypasses the encryption guard', () => {
  @model('enc_people')
  class EncPerson extends ApplicationRecord {
    static ssn = (Attr.string() as any).encrypt()   // randomized
  }
  const schema = { enc_people: fakeTable(['id', 'ssn']) }

  it('throws instead of GROUP BYing ciphertext and leaking decrypted labels', async () => {
    boot(captureDb([]).db, schema)
    await expect(EncPerson.all().tally('ssn')).rejects.toThrow(/encrypted/i)
  })
})
