import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { SoftDeletable } from '../../src/concerns/builtin/soft-deletable.js'
import { include } from '../../src/concerns/include.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { model } from '../../src/runtime/decorators.js'
import { boot } from '../../src/runtime/boot.js'

describe('SoftDeletable concern', () => {
  it('supplies a defaultScope configuration', () => {
    expect(SoftDeletable.def.defaultScope).toBeDefined()
  })

  it('provides a withDeleted and onlyDeleted scope', () => {
    expect(SoftDeletable.def.scopes?.withDeleted).toBeDefined()
    expect(SoftDeletable.def.scopes?.onlyDeleted).toBeDefined()
  })

  it('provides restore and isDeleted methods/getters', () => {
    expect(SoftDeletable.def.methods?.restore).toBeDefined()
    expect(SoftDeletable.def.getters?.isDeleted).toBeDefined()
  })

  it('overrides destroy with "soft"', () => {
    expect(SoftDeletable.def.overrides?.destroy).toBe('soft')
  })

  it('configures the column name falling back to deletedAt', () => {
    const config = SoftDeletable.def.configure?.({})
    expect(config?.columnName).toBe('deletedAt')

    const custom = SoftDeletable.def.configure?.({ columnName: 'archivedAt' })
    expect(custom?.columnName).toBe('archivedAt')
  })
})

// ── Mock DB Integration ────────────────────────────────────────────────────

function makeCaptureDb(rows: any[] = []) {
  const captured: any = { select: {} }
  const findMany = vi.fn(async (config: any) => { captured.select = config || {}; return rows })
  
  const returningMock = vi.fn().mockResolvedValue(rows.length > 0 ? [rows[0]] : [{ id: 1 }])
  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn((c) => { captured.where = c; return chainMock }),
    limit: vi.fn(() => chainMock),
    returning: returningMock,
    then: (res: any) => res(rows)
  }
  Object.defineProperty(chainMock, Symbol.toStringTag, { value: 'Promise' })
  const selectMock = vi.fn(() => chainMock)
  const updateMock = vi.fn(() => ({ set: vi.fn().mockReturnValue(chainMock) }))

  return {
    db: {
      query: { documents: { findMany } },
      select: selectMock,
      update: updateMock,
    } as any,
    findMany,
    captured,
    updateMock
  }
}

const schema = {
  documents: {
    id: { columnName: 'id', _name: 'id' },
    title: { columnName: 'title', _name: 'title' },
    deletedAt: { columnName: 'deleted_at', _name: 'deletedAt' }
  }
}

@model('documents')
@include(SoftDeletable)
class Document extends ApplicationRecord {
  title!: string;
  deletedAt!: Date | null;
}

describe('SoftDeletable integration', () => {
  let mockDb: ReturnType<typeof makeCaptureDb>

  beforeAll(() => {
    mockDb = makeCaptureDb([{ id: 1, title: 'hello', deletedAt: new Date() }])
    boot(mockDb.db, schema)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockDb.captured)) {
      delete mockDb.captured[key]
    }
  })

  it('automatically applies the is null scope', async () => {
    await Document.all().load()
    expect(mockDb.captured.select.where).toBeDefined()
  })

  it('allows querying with deleted records via withDeleted', async () => {
    await (Document as any).withDeleted().load()
    // Select should not have a where clause applied by default scope
    expect(mockDb.captured.select.where).toBeUndefined()
  })

  it('allows fetching only deleted records via onlyDeleted', async () => {
    await (Document as any).onlyDeleted().load()
    expect(mockDb.captured.select.where).toBeDefined()
  })

  it('overrides destroy to perform an update', async () => {
    const doc = await Document.find(1) as any
    await doc.destroy()
    expect(mockDb.updateMock).toHaveBeenCalled()
  })

  it('provides restore() method to clear the column', async () => {
    const doc = await (Document as any).withDeleted().first()
    await doc.restore()
    expect(mockDb.updateMock).toHaveBeenCalled()
  })
})
