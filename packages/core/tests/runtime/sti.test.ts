/**
 * STI (Single Table Inheritance) runtime tests.
 *
 * Verifies:
 *   1. STI subclass queries auto-inject `WHERE type = stiType`
 *   2. Querying the parent table instantiates correct subclasses
 *   3. Parent class queries are unaffected when no type column is present
 *   4. @model registers classes in MODEL_REGISTRY
 *   5. Relation.withLock() runs inside a transaction with _forUpdate set
 *   6. @computed is a no-op decorator (codegen annotation only)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Relation } from '../../src/runtime/relation.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, MODEL_REGISTRY } from '../../src/runtime/boot.js'
import { model, computed } from '../../src/runtime/decorators.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

function makeDb(rows: any[] = []) {
  let capturedConfig: any
  let capturedForUpdate = false

  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    limit: vi.fn(() => chainMock),
    offset: vi.fn(() => chainMock),
    // for('update') call — mock it
    for: vi.fn(() => {
      capturedForUpdate = true
      return { then: (res: any) => res(rows) }
    }),
    then: (res: any) => res(rows),
  }

  const findMany = vi.fn(async (cfg: any) => {
    capturedConfig = cfg
    return rows
  })

  const db: any = {
    query: {
      text_messages: { findMany },
      assets: { findMany },
    },
    select: vi.fn(() => chainMock),
    transaction: vi.fn((cb: any) => cb(db)),
  }

  return { db, findMany, chainMock, getCapturedConfig: () => capturedConfig, wasForUpdate: () => capturedForUpdate }
}

// ── STI Model Hierarchy ───────────────────────────────────────────────────────

const stiSchema = {
  text_messages: fakeTable(['id', 'type', 'title']),
  assets: fakeTable(['id', 'type', 'name']),
}

@model('text_messages')
class TextMessage extends ApplicationRecord {}

@model('text_messages')
class OutboundTemplate extends TextMessage {
  static stiType = 1000
}

@model('text_messages')
class InboundMessage extends TextMessage {
  static stiType = 2000
  static stiTypeColumn = 'type'  // explicit column name (optional, 'type' is the default)
}

// ── @model registers in MODEL_REGISTRY ───────────────────────────────────────

describe('@model — MODEL_REGISTRY registration', () => {
  it('registers the class in MODEL_REGISTRY under its class name', () => {
    expect(MODEL_REGISTRY['TextMessage']).toBe(TextMessage)
    expect(MODEL_REGISTRY['OutboundTemplate']).toBe(OutboundTemplate)
    expect(MODEL_REGISTRY['InboundMessage']).toBe(InboundMessage)
  })
})

// ── STI auto-WHERE injection ──────────────────────────────────────────────────

describe('STI — auto-WHERE injection for subclass queries', () => {
  let mock: ReturnType<typeof makeDb>

  beforeEach(() => {
    mock = makeDb([])
    boot(mock.db, stiSchema)
    vi.clearAllMocks()
  })

  it('injects WHERE type = stiType when querying a subclass', async () => {
    await new Relation(OutboundTemplate).load()

    const config = mock.getCapturedConfig()
    expect(config.where).toBeDefined()
    // The where clause should reference the stiType value (1000)
    const whereStr = JSON.stringify(config.where)
    expect(whereStr).toContain('1000')
  })

  it('does NOT inject WHERE type when querying the parent class', async () => {
    await new Relation(TextMessage).load()

    const config = mock.getCapturedConfig()
    // Parent class queries have no STI filter
    expect(config.where).toBeUndefined()
  })

  it('combines STI filter with additional where() clauses', async () => {
    const rel = new Relation(OutboundTemplate)
    rel.where({ title: 'hello' })

    // Two clauses: title = 'hello' AND type = 1000
    expect(rel['_where']).toHaveLength(1)  // explicit where
    // After _buildFinalWhere the STI clause is prepended
    const finalWhere = rel['_buildFinalWhere']()
    expect(finalWhere).toBeDefined()
  })

  it('uses stiTypeColumn override when specified', () => {
    const rel = new Relation(InboundMessage)
    // _buildFinalWhere should use the 'type' column (explicit stiTypeColumn)
    const finalWhere = rel['_buildFinalWhere']()
    expect(finalWhere).toBeDefined()
    const whereStr = JSON.stringify(finalWhere)
    expect(whereStr).toContain('2000')
  })
})

// ── STI subclass instantiation ────────────────────────────────────────────────

describe('STI — correct subclass instantiation on load', () => {
  it('instantiates the correct subclass based on type column value', async () => {
    const rows = [
      { id: 1, type: 1000, title: 'outbound' },
      { id: 2, type: 2000, title: 'inbound' },
      { id: 3, type: null, title: 'base' },
    ]
    const mock = makeDb(rows)
    boot(mock.db, stiSchema)

    const results = await new Relation(TextMessage).load()

    expect(results[0]).toBeInstanceOf(OutboundTemplate)
    expect(results[1]).toBeInstanceOf(InboundMessage)
    expect(results[2]).toBeInstanceOf(TextMessage)  // falls back to parent
  })

  it('always returns the subclass itself when querying through the subclass', async () => {
    const rows = [{ id: 1, type: 1000, title: 'foo' }]
    const mock = makeDb(rows)
    boot(mock.db, stiSchema)

    const results = await new Relation(OutboundTemplate).load()
    expect(results[0]).toBeInstanceOf(OutboundTemplate)
  })

  it('returns parent class instances for unknown type values', async () => {
    const rows = [{ id: 1, type: 9999, title: 'mystery' }]
    const mock = makeDb(rows)
    boot(mock.db, stiSchema)

    const results = await new Relation(TextMessage).load()
    // 9999 has no registered subclass → falls back to TextMessage
    expect(results[0]).toBeInstanceOf(TextMessage)
  })
})

// ── withLock() ────────────────────────────────────────────────────────────────

describe('Relation.withLock()', () => {
  it('sets _forUpdate on the locked relation passed to the callback', async () => {
    const mock = makeDb([])
    boot(mock.db, stiSchema)

    let lockedRelation: any
    await new Relation(TextMessage).withLock(async (locked) => {
      lockedRelation = locked
    })

    expect(lockedRelation['_forUpdate']).toBe(true)
  })

  it('runs the callback inside a transaction', async () => {
    const mock = makeDb([])
    boot(mock.db, stiSchema)

    await new Relation(TextMessage).withLock(async () => {})

    expect(mock.db.transaction).toHaveBeenCalledOnce()
  })

  it('uses SELECT ... FOR UPDATE when loading a locked relation', async () => {
    const rows = [{ id: 1, type: null, title: 'locked' }]
    const mock = makeDb(rows)
    boot(mock.db, stiSchema)

    let loaded: any[] = []
    await new Relation(TextMessage).withLock(async (locked) => {
      loaded = await locked.load()
    })

    // chainMock.for() should have been called (SELECT FOR UPDATE)
    expect(mock.chainMock.for).toHaveBeenCalledWith('update')
    expect(loaded).toHaveLength(1)
  })

  it('a locked clone is independent — original relation is unmodified', async () => {
    const mock = makeDb([])
    boot(mock.db, stiSchema)

    const original = new Relation(TextMessage)
    await original.withLock(async () => {})

    expect((original as any)._forUpdate).toBeUndefined()
  })
})

// ── @computed decorator ───────────────────────────────────────────────────────

describe('@computed decorator', () => {
  it('is a no-op at runtime — does not modify the decorated method', () => {
    class Example {
      @computed
      static myScope(): string {
        return 'value'
      }
    }

    // Should still call through normally
    expect((Example as any).myScope()).toBe('value')
  })
})
