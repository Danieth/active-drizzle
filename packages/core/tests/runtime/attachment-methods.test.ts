/**
 * ApplicationRecord attachment method tests.
 *
 * Tests .attach(), .detach(), .replace(), .reorder() using a mock DB.
 * Follows the same mock-DB pattern as associations.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock storage before importing asset.ts (asset.ts calls getStorage() at module load)
vi.mock('../../src/storage/storage.js', () => ({
  getStorage: vi.fn(() => ({
    publicUrl: (key: string) => `https://cdn.example.com/${key}`,
    presignGet: async (key: string) => `https://s3.example.com/${key}?signed=1`,
  })),
}))

import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, MODEL_REGISTRY } from '../../src/runtime/boot.js'
import { model } from '../../src/runtime/decorators.js'
import { hasOneAttachment, hasManyAttachments, ATTACHMENT_REGISTRY } from '../../src/runtime/attachments.js'
import { Asset, Attachment } from '../../src/runtime/asset.js'

// ── DB mock helpers ───────────────────────────────────────────────────────────

/**
 * Builds a minimal Drizzle-compatible mock DB that records all inserts/deletes.
 * Returns the db and inspection helpers.
 */
function makeDb(initialAttachments: any[] = []) {
  let attachmentRows = [...initialAttachments]
  let insertCalls: any[] = []
  let deleteCalls: any[] = []
  let updateCalls: any[] = []

  const chainMock: any = {
    from: vi.fn(() => chainMock),
    where: vi.fn(() => chainMock),
    limit: vi.fn(() => chainMock),
    orderBy: vi.fn(() => chainMock),
    offset: vi.fn(() => chainMock),
    for: vi.fn(() => chainMock),
    then: (res: any, _rej: any) => res([...attachmentRows]),
  }

  const db: any = {
    select: vi.fn(() => chainMock),
    insert: vi.fn((table: any) => ({
      values: vi.fn((data: any) => ({
        returning: vi.fn(() => {
          insertCalls.push(data)
          const row = { id: Date.now(), ...data }
          attachmentRows.push(row)
          return Promise.resolve([row])
        }),
      })),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          deleteCalls.push({ table })
          // Remove matching rows (simplistic — removes all for the test)
          const removed = [...attachmentRows]
          attachmentRows = []
          return Promise.resolve(removed)
        }),
      })),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((data: any) => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            updateCalls.push(data)
            return Promise.resolve([data])
          }),
        })),
      })),
    })),
    query: {
      active_drizzle_attachments: {
        findMany: vi.fn(() => Promise.resolve([...attachmentRows])),
      },
      active_drizzle_assets: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
      campaigns: {
        findMany: vi.fn(() => Promise.resolve([])),
      },
    },
    transaction: vi.fn((cb: any) => cb(db)),
  }

  return { db, insertCalls, deleteCalls, updateCalls, getRows: () => attachmentRows }
}

// ── Schema ────────────────────────────────────────────────────────────────────

function fakeCol(name: string) { return { columnName: name, _name: name } }
function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = fakeCol(c)
  return t
}

// ── Models ────────────────────────────────────────────────────────────────────

@model('campaigns')
class Campaign extends ApplicationRecord {
  static logo = hasOneAttachment('logo', { accepts: 'image/*', access: 'public' })
  static documents = hasManyAttachments('documents', { max: 3, access: 'private' })
}

// Populate registry from class scan (normally done via @model + _wireAttachmentRegistry,
// but for unit tests we register explicitly to avoid needing full boot)
ATTACHMENT_REGISTRY.set('Campaign', [
  { name: 'logo', kind: 'one', accepts: 'image/*', access: 'public' },
  { name: 'documents', kind: 'many', max: 3, access: 'private' },
])

const schema = {
  campaigns: fakeTable(['id', 'teamId', 'name']),
  active_drizzle_attachments: fakeTable(['id', 'assetId', 'attachableType', 'attachableId', 'name', 'position']),
  active_drizzle_assets: fakeTable(['id', 'key', 'filename', 'contentType', 'status', 'access']),
}

// Register Attachment + Asset in MODEL_REGISTRY (they auto-register on module load,
// but we need them in the schema too)
function setupDb(attachmentRows: any[] = []) {
  const { db, insertCalls, deleteCalls, updateCalls, getRows } = makeDb(attachmentRows)
  // Clear and re-register models
  Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])
  MODEL_REGISTRY['Campaign'] = Campaign
  MODEL_REGISTRY['campaigns'] = Campaign

  // Register Asset/Attachment (imported at top of file)
  MODEL_REGISTRY['Asset'] = Asset
  MODEL_REGISTRY['Attachment'] = Attachment
  MODEL_REGISTRY['active_drizzle_assets'] = Asset
  MODEL_REGISTRY['active_drizzle_attachments'] = Attachment

  // Boot with the mock db
  boot(db, schema)

  return { db, insertCalls, deleteCalls, updateCalls, getRows }
}

function makeCampaign(attrs: Record<string, any> = {}) {
  return new Campaign({ id: 1, name: 'Test', teamId: 1, ...attrs }, false) as Campaign
}

// ── .attach() ─────────────────────────────────────────────────────────────────

describe('ApplicationRecord.attach()', () => {
  beforeEach(() => {
    ATTACHMENT_REGISTRY.set('Campaign', [
      { name: 'logo', kind: 'one', accepts: 'image/*', access: 'public' },
      { name: 'documents', kind: 'many', max: 3, access: 'private' },
    ])
  })

  it('throws if attachment name is not declared on the model', async () => {
    setupDb()
    const campaign = makeCampaign()
    await expect(campaign.attach('banner', 42)).rejects.toThrow("No attachment 'banner' declared on Campaign")
  })

  it('throws on unsaved records', async () => {
    setupDb()
    const unsaved = new Campaign({ name: 'New' }, true) as Campaign
    await expect(unsaved.attach('logo', 42)).rejects.toThrow("Cannot attach 'logo' on unsaved Campaign record")
  })
})

// ── Proxy attachment access ───────────────────────────────────────────────────

describe('Proxy attachment eager-load access', () => {
  it('returns null for unloaded hasOneAttachment', () => {
    setupDb()
    const campaign = makeCampaign()
    // Access via proxy — not loaded, should return null
    expect((campaign as any).logo).toBeNull()
  })

  it('returns [] for unloaded hasManyAttachments', () => {
    setupDb()
    const campaign = makeCampaign()
    expect((campaign as any).documents).toEqual([])
  })

  it('returns loaded value when attachment is pre-populated in attributes', () => {
    setupDb()
    const fakeAsset = { id: 5, filename: 'logo.png', access: 'public' }
    const campaign = new Campaign({
      id: 1,
      name: 'Test',
      teamId: 1,
      logo: fakeAsset,  // pre-loaded
    }, false) as Campaign
    expect((campaign as any).logo).toEqual(fakeAsset)
  })

  it('returns array when hasManyAttachments is pre-populated', () => {
    setupDb()
    const fakeAssets = [
      { id: 1, filename: 'doc1.pdf', access: 'private' },
      { id: 2, filename: 'doc2.pdf', access: 'private' },
    ]
    const campaign = new Campaign({
      id: 1,
      name: 'Test',
      teamId: 1,
      documents: fakeAssets,
    }, false) as Campaign
    expect((campaign as any).documents).toEqual(fakeAssets)
  })
})

describe('ApplicationRecord.reorder()', () => {
  it('requires reorder list to include all currently attached assets', async () => {
    setupDb([
      { id: 1, assetId: 11, attachableType: 'Campaign', attachableId: 1, name: 'documents', position: 0 },
      { id: 2, assetId: 12, attachableType: 'Campaign', attachableId: 1, name: 'documents', position: 1 },
    ])
    const campaign = makeCampaign()
    await expect(campaign.reorder('documents', [11])).rejects.toThrow(
      "Reorder for 'documents' must include exactly 2 assets",
    )
  })

  it('rejects duplicate asset ids in reorder payload', async () => {
    setupDb([
      { id: 1, assetId: 11, attachableType: 'Campaign', attachableId: 1, name: 'documents', position: 0 },
      { id: 2, assetId: 12, attachableType: 'Campaign', attachableId: 1, name: 'documents', position: 1 },
    ])
    const campaign = makeCampaign()
    await expect(campaign.reorder('documents', [11, 11])).rejects.toThrow(
      "Cannot reorder 'documents' with duplicate asset IDs",
    )
  })
})
