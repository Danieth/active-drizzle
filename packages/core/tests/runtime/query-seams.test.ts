/**
 * Query-seam correctness that all traces back to _clone() completeness plus two
 * builder bugs:
 *   - _clone() must copy _forUpdate (withLock) and the unscoped flags.
 *   - last() must reverse via the order-spec list, not string-matching.
 *   - inBatches() must page by keyset seek, not limit/offset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { asc } from 'drizzle-orm'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, name: c, _name: c }
  return t
}

const schema = { qs_posts: fakeTable(['id', 'title', 'deletedAt']) }

@model('qs_posts')
class QsPost extends ApplicationRecord {}

// Capture DB: findMany records its config; the select() chain records .for().
function makeCaptureDb(pages: any[][] | any[] = []) {
  const configs: any[] = []
  let call = 0
  const findMany = vi.fn(async (cfg: any) => {
    configs.push(cfg)
    if (Array.isArray(pages) && Array.isArray(pages[0])) return (pages as any[][])[call++] ?? []
    return pages as any[]
  })
  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    limit: vi.fn(() => chainMock),
    offset: vi.fn(() => chainMock),
    for: vi.fn(() => chainMock),
    then: (res: any) => res(Array.isArray(pages) && Array.isArray(pages[0]) ? [] : pages),
  }
  const db: any = {
    query: { qs_posts: { findMany } },
    select: vi.fn(() => chainMock),
    transaction: vi.fn((cb: any) => cb(db)),
  }
  return { db, configs, chainMock, findMany }
}

beforeEach(() => { delete (QsPost as any).__defaultScopes })

// ── withLock — _forUpdate survives the clone (even through default scopes) ─────

describe('withLock() actually acquires the lock (FOR UPDATE survives _clone)', () => {
  it('first() inside withLock emits SELECT ... FOR UPDATE', async () => {
    const cap = makeCaptureDb([{ id: 1, title: 't' }])
    boot(cap.db, schema)
    // A default scope forces _withDefaultScopes() to clone as well — the lock
    // flag must survive BOTH the first() clone and the scope clone.
    ;(QsPost as any).__defaultScopes = new Map([['Soft', (q: any) => q.where({ deletedAt: null })]])

    await new Relation(QsPost).withLock(async (locked) => {
      await locked.first()
    })

    expect(cap.chainMock.for).toHaveBeenCalledWith('update')
  })
})

// ── unscoped — flags survive the clone that first()/take() make ───────────────

describe('unscoped() stays unscoped through first() (matches count())', () => {
  beforeEach(() => {
    ;(QsPost as any).__defaultScopes = new Map([['Soft', (q: any) => q.where({ deletedAt: null })]])
  })

  it('unscoped().first() applies NO default scope', async () => {
    const cap = makeCaptureDb([{ id: 1 }])
    boot(cap.db, schema)
    await QsPost.unscoped().first()
    // first() clones before load(); the clone must keep _skipAllDefaultScopes.
    expect(cap.configs.at(-1)?.where).toBeUndefined()
  })

  it('scoped().first() DOES apply the default scope (control)', async () => {
    const cap = makeCaptureDb([{ id: 1 }])
    boot(cap.db, schema)
    await QsPost.all().first()
    expect(cap.configs.at(-1)?.where).toBeDefined()
  })
})

// ── last() — reverse via order-spec, never `col asc desc` ──────────────────────

describe('last() reverses an explicit order by flipping the spec', () => {
  it('order("title","desc").last() emits ASC on title (not a re-wrapped expr)', async () => {
    const cap = makeCaptureDb([])
    boot(cap.db, schema)
    await QsPost.all().order('title', 'desc').last()
    const orderBy = cap.configs.at(-1)?.orderBy
    expect(orderBy).toHaveLength(1)
    // Structurally equals a fresh asc(title) — the bug produced desc(sql`title asc`).
    expect(orderBy[0]).toEqual(asc(schema.qs_posts.title))
  })
})

// ── inBatches() — keyset seek, no offset ──────────────────────────────────────

describe('inBatches() pages by keyset seek, never offset', () => {
  it('every page has ORDER BY, none has OFFSET, and later pages carry a seek WHERE', async () => {
    // 2 full pages of 2 then empty
    const cap = makeCaptureDb([
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }, { id: 4 }],
      [],
    ])
    boot(cap.db, schema)

    const seen: number[] = []
    await new Relation(QsPost).inBatches(2, async (batch) => {
      for (const r of await batch.load()) seen.push((r as any)._attributes.id)
    })

    const loadConfigs = cap.configs.filter(c => 'limit' in c && c.limit === 2)
    expect(loadConfigs.length).toBeGreaterThanOrEqual(2)
    // Keyset invariants: ORDER BY always, OFFSET never.
    for (const c of loadConfigs) {
      expect(c.orderBy, 'every batch is ordered').toBeDefined()
      expect(c.offset, 'never uses OFFSET').toBeUndefined()
    }
    // The first cursor has no seek predicate; the second does (id > cursor).
    expect(loadConfigs[0].where).toBeUndefined()
    expect(loadConfigs[1].where).toBeDefined()
  })
})
