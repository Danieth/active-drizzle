import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'

// ── Mock DB ────────────────────────────────────────────────────────────────

function makeCaptureDb(rows: any[] = []) {
  const captured: { select?: any; where?: any; from?: any; orderBy?: any; limit?: any; offset?: any; insert?: any; update?: any; delete?: any } = {}

  const findMany = vi.fn(async (config: any) => {
    captured.select = config
    return rows
  })

  return {
    db: {
      query: { items: { findMany } },
    } as any,
    findMany,
    captured,
  }
}

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

const schema = {
  items: fakeTable(['id', 'status', 'tenantId', 'deletedAt']),
}

// ── Setup ──────────────────────────────────────────────────────────────────

@model('items')
class Item extends ApplicationRecord {}

let mockDb: ReturnType<typeof makeCaptureDb>

beforeAll(() => {
  mockDb = makeCaptureDb([{ id: 1, status: 0 }])
  boot(mockDb.db, schema)
})

beforeEach(() => {
  vi.clearAllMocks()
  // Clean up any default scopes between tests to ensure isolation
  delete (Item as any).__defaultScopes
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Relation — default scopes & .unscoped()', () => {
  it('does not apply any scopes if none are registered', async () => {
    await Item.all().load()
    expect(mockDb.captured.select?.where).toBeUndefined()
  })

  it('applies a single default scope to queries', async () => {
    const fn = (q: any) => q.where({ deletedAt: null })
    ;(Item as any).__defaultScopes = new Map([['SoftDelete', fn]])

    await Item.all().load()
    expect(mockDb.captured.select).toBeDefined()
    expect(mockDb.captured.select.where).toBeDefined()
  })

  it('applies multiple default scopes cumulatively', async () => {
    const fn1 = (q: any) => q.where({ deletedAt: null })
    const fn2 = (q: any) => q.where({ tenantId: 1 })
    ;(Item as any).__defaultScopes = new Map([
      ['SoftDelete', fn1],
      ['Tenant', fn2],
    ])

    await Item.all().load()
    expect(mockDb.captured.select.where).toBeDefined() // should be an `and()`
  })

  it('unscoped() without arguments ignores all default scopes', async () => {
    const fn1 = (q: any) => q.where({ deletedAt: null })
    const fn2 = (q: any) => q.where({ tenantId: 1 })
    ;(Item as any).__defaultScopes = new Map([
      ['SoftDelete', fn1],
      ['Tenant', fn2],
    ])

    await Item.unscoped().load()
    // No where clauses applied
    expect(mockDb.captured.select.where).toBeUndefined()
  })

  it('unscoped("Name") removes only that specific default scope', async () => {
    const fn1 = (q: any) => q.where({ deletedAt: null }) // SoftDelete
    const fn2 = (q: any) => q.where({ status: 1 })       // ActiveOnly
    ;(Item as any).__defaultScopes = new Map([
      ['SoftDelete', fn1],
      ['ActiveOnly', fn2],
    ])

    // Should still have ActiveOnly
    await Item.unscoped('SoftDelete').load()
    expect(mockDb.captured.select.where).toBeDefined()
    
    // Test that the remaining scope works
    const whereStr = JSON.stringify(mockDb.captured.select.where)
    expect(whereStr).toContain('status')
  })

  it('chains seamlessly with user queries (user where() plus default scope)', async () => {
    const fn = (q: any) => q.where({ deletedAt: null })
    ;(Item as any).__defaultScopes = new Map([['SoftDelete', fn]])

    await Item.where({ status: 2 }).load()
    
    // the query should combine both status=2 and deletedAt IS NULL
    expect(mockDb.captured.select.where).toBeDefined()
  })
})
