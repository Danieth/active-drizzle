/**
 * STI + real inheritance — regression coverage for the two prototype-chain
 * bugs the first STI-heavy consumer surfaced (and their satellite scan
 * sites). A flat single-level model suite structurally cannot catch these:
 * own-properties and all-properties only diverge once a subclass with its
 * own statics is INSTANTIATED.
 *
 *   1. subclass blind to inherited statics (state machines, associations,
 *      defaults, nested markers, attachments) — every static scan must walk
 *      the constructor chain (modelStaticEntries).
 *   2. subclass @model(...) clobbering the registry's by-table slot — the
 *      BASE class must own it regardless of import order, or association
 *      inference silently auto-scopes to whichever subclass loaded last.
 */
import { describe, it, expect, vi } from 'vitest'
import { ApplicationRecord, modelStaticEntries, resolveNestedAssociations } from '../../src/runtime/application-record.js'
import { boot, MODEL_REGISTRY } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { belongsTo, hasMany } from '../../src/runtime/markers.js'
import { hasManyAttachments, getAttachments } from '../../src/runtime/attachments.js'

function fakeCol(name: string) { return { columnName: name, _name: name } }
function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = fakeCol(c)
  return t
}

// ── Fixtures: a base with the full static spread + a bare subclass ───────────

@model('sti_bids')
class StiBid extends ApplicationRecord {}
void StiBid

@model('sti_rfps')
class StiRfp extends ApplicationRecord {
  static company = belongsTo('sti_companies', { foreignKey: 'companyId' })
  static bids = hasMany('sti_bids', { acceptsNested: true } as any)
  static docs = hasManyAttachments('docs', { max: 3 })
}

// The canonical STI child: ONE own static (the discriminator), everything
// else inherited. This is exactly the shape that went blind at runtime.
@model('sti_rfps')
class TermLoanStiRfp extends StiRfp {
  static stiType = 'TermLoan'
}

@model('sti_companies')
class StiCompany extends ApplicationRecord {}
void StiCompany

const stiSchema = {
  sti_rfps: fakeTable(['id', 'type', 'companyId']),
  sti_bids: fakeTable(['id', 'sti_rfpId', 'amount']),
  sti_companies: fakeTable(['id', 'name']),
}

describe('modelStaticEntries — the chain walker', () => {
  it('sees the parent statics from the subclass, subclass shadows win', () => {
    class Shadowing extends StiRfp {
      static stiType = 'Shadow'
      static company = belongsTo('sti_companies', { foreignKey: 'otherId' })
    }
    const entries = Object.fromEntries(modelStaticEntries(Shadowing))
    expect(entries['stiType']).toBe('Shadow')                     // own
    expect(entries['bids']?._type).toBe('hasMany')                // inherited
    expect(entries['company']?.options?.foreignKey).toBe('otherId')  // shadowed, first hit wins
  })
})

describe('subclass inherits the parent statics at runtime', () => {
  it('resolves an INHERITED association from a subclass instance', async () => {
    const companyRow = { id: 5, name: 'Acme' }
    const db: any = {
      query: { sti_companies: { findMany: vi.fn(async () => [companyRow]) } },
      select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn((cb: any) => cb(db)),
    }
    boot(db, stiSchema)
    const rfp = new TermLoanStiRfp({ id: 1, companyId: 5 }, false)
    const company = await (rfp as any).company     // declared on the PARENT
    expect(company?._attributes.name).toBe('Acme')
  })

  it('resolveNestedAssociations sees the parent acceptsNested from the subclass', () => {
    const resolved = resolveNestedAssociations(TermLoanStiRfp)
    expect(resolved.find(r => r.name === 'bids')).toBeDefined()
  })

  it('getAttachments sees the parent attachment markers from the subclass', () => {
    const entries = getAttachments('TermLoanStiRfp')
    expect(entries.find(e => e.name === 'docs')?.max).toBe(3)
  })
})

describe('registry by-table slot — base owns it regardless of import order', () => {
  it('a subclass registering AFTER the base does not clobber the table slot', () => {
    // TermLoanStiRfp's decorator ran after StiRfp's above
    expect(MODEL_REGISTRY['sti_rfps']).toBe(StiRfp)
    // by-class-name entries stay per-class (STI resolution path)
    expect(MODEL_REGISTRY['TermLoanStiRfp']).toBe(TermLoanStiRfp)
    expect(MODEL_REGISTRY['StiRfp']).toBe(StiRfp)
  })

  it('subclass-first import order: base still reclaims the slot', () => {
    @model('order_probe')
    class OrderChild extends ApplicationRecord {
      static stiType = 'Child'
    }
    void OrderChild
    // Without the guard the LAST registration would win; the guard lets the
    // base (no stiType) take the slot even though it registers second
    @model('order_probe')
    class OrderBase extends ApplicationRecord {}
    expect(MODEL_REGISTRY['order_probe']).toBe(OrderBase)
  })

  it('why it matters: base-resolved association never auto-scopes to a stray subclass', () => {
    // hasMany inference resolves through MODEL_REGISTRY[table]; if a subclass
    // held the slot, its stiType WHERE would silently filter another
    // subclass's children to zero rows — plausible-looking wrong data
    const resolved = MODEL_REGISTRY['sti_rfps']
    expect((resolved as any).stiType).toBeUndefined()
  })
})
