/**
 * Asset model unit tests.
 *
 * Tests computed properties, predicates, and toJSON serialization.
 * Mocks getStorage() to avoid requiring a real S3 config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock storage before importing asset.ts
vi.mock('../../src/storage/storage.js', () => ({
  getStorage: vi.fn(() => ({
    publicUrl: (key: string) => `https://cdn.example.com/${key}`,
    presignGet: async (key: string) => `https://s3.example.com/${key}?signed=1`,
  })),
}))

import { Asset, Attachment } from '../../src/runtime/asset.js'
import { MODEL_REGISTRY } from '../../src/runtime/boot.js'

// Ensure Asset is registered (happens at module load)
beforeEach(() => {
  MODEL_REGISTRY['Asset'] = Asset
  MODEL_REGISTRY['Attachment'] = Attachment
  MODEL_REGISTRY['active_drizzle_assets'] = Asset
  MODEL_REGISTRY['active_drizzle_attachments'] = Attachment
})

function makeAsset(overrides: Record<string, any> = {}): Asset {
  return new Asset({
    id: 1,
    key: 'uploads/abc/photo.jpg',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    byteSize: 1024,
    checksum: 'abc123',
    status: 'ready',
    access: 'public',
    metadata: {},
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  }, false) as Asset
}

// ── Content-type predicates ───────────────────────────────────────────────────

describe('Asset content-type predicates', () => {
  it('isImage is true for image/* types', () => {
    expect(makeAsset({ contentType: 'image/jpeg' }).isImage).toBe(true)
    expect(makeAsset({ contentType: 'image/png' }).isImage).toBe(true)
    expect(makeAsset({ contentType: 'image/gif' }).isImage).toBe(true)
  })

  it('isImage is false for non-image types', () => {
    expect(makeAsset({ contentType: 'video/mp4' }).isImage).toBe(false)
    expect(makeAsset({ contentType: 'application/pdf' }).isImage).toBe(false)
  })

  it('isVideo is true for video/* types', () => {
    expect(makeAsset({ contentType: 'video/mp4' }).isVideo).toBe(true)
    expect(makeAsset({ contentType: 'video/webm' }).isVideo).toBe(true)
  })

  it('isAudio is true for audio/* types', () => {
    expect(makeAsset({ contentType: 'audio/mpeg' }).isAudio).toBe(true)
    expect(makeAsset({ contentType: 'audio/ogg' }).isAudio).toBe(true)
  })

  it('isPdf is true only for application/pdf', () => {
    expect(makeAsset({ contentType: 'application/pdf' }).isPdf).toBe(true)
    expect(makeAsset({ contentType: 'application/json' }).isPdf).toBe(false)
  })
})

// ── Status predicates ─────────────────────────────────────────────────────────

describe('Asset status predicates', () => {
  it('isReady is true when status is ready', () => {
    expect(makeAsset({ status: 'ready' }).isReady).toBe(true)
    expect(makeAsset({ status: 'pending' }).isReady).toBe(false)
  })

  it('isPending is true when status is pending', () => {
    expect(makeAsset({ status: 'pending' }).isPending).toBe(true)
    expect(makeAsset({ status: 'ready' }).isPending).toBe(false)
  })
})

// ── url getter ────────────────────────────────────────────────────────────────

describe('Asset.url', () => {
  it('returns public CDN URL for public assets', () => {
    const asset = makeAsset({ access: 'public', key: 'uploads/abc/photo.jpg' })
    expect(asset.url).toBe('https://cdn.example.com/uploads/abc/photo.jpg')
  })

  it('throws for private assets (use resolveUrl instead)', () => {
    const asset = makeAsset({ access: 'private' })
    expect(() => asset.url).toThrow('resolveUrl()')
  })
})

// ── resolveUrl ────────────────────────────────────────────────────────────────

describe('Asset.resolveUrl', () => {
  it('returns public CDN URL for public assets', async () => {
    const asset = makeAsset({ access: 'public', key: 'uploads/abc/photo.jpg' })
    const url = await asset.resolveUrl()
    expect(url).toBe('https://cdn.example.com/uploads/abc/photo.jpg')
  })

  it('returns presigned GET URL for private assets', async () => {
    const asset = makeAsset({ access: 'private', key: 'uploads/abc/doc.pdf' })
    const url = await asset.resolveUrl()
    expect(url).toBe('https://s3.example.com/uploads/abc/doc.pdf?signed=1')
  })
})

// ── toJSON ────────────────────────────────────────────────────────────────────

describe('Asset.toJSON', () => {
  it('includes url for public assets', () => {
    const asset = makeAsset({ access: 'public', key: 'uploads/abc/photo.jpg' })
    const json = asset.toJSON()
    expect(json.url).toBe('https://cdn.example.com/uploads/abc/photo.jpg')
  })

  it('omits url for private assets (caller must call resolveUrl)', () => {
    const asset = makeAsset({ access: 'private' })
    const json = asset.toJSON()
    expect(json.url).toBeUndefined()
  })

  it('includes standard fields', () => {
    const asset = makeAsset()
    const json = asset.toJSON()
    expect(json.id).toBe(1)
    expect(json.filename).toBe('photo.jpg')
    expect(json.contentType).toBe('image/jpeg')
    expect(json.status).toBe('ready')
  })
})

// ── Attachment model ──────────────────────────────────────────────────────────

describe('Attachment model', () => {
  it('has correct tableName', () => {
    expect(Attachment._activeDrizzleTableName).toBe('active_drizzle_attachments')
  })

  it('exposes getters for key fields', () => {
    const att = new Attachment({
      id: 1,
      assetId: 42,
      attachableType: 'Campaign',
      attachableId: 7,
      name: 'logo',
      position: 0,
      createdAt: '2024-01-01T00:00:00Z',
    }, false) as Attachment
    expect(att.assetId).toBe(42)
    expect(att.attachableType).toBe('Campaign')
    expect(att.attachableId).toBe(7)
    expect(att.name).toBe('logo')
    expect(att.position).toBe(0)
  })
})
