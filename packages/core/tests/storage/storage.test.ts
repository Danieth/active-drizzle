/**
 * Storage module unit tests.
 *
 * Tests configureStorage, getStorage, and all StorageInstance methods
 * without making real S3 calls (mocks the AWS SDK).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock AWS SDK before importing storage.ts (it's an optional peer dep)
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  GetObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  HeadObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
  DeleteObjectCommand: vi.fn().mockImplementation((args: any) => ({ ...args })),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/bucket/key?signed=1'),
}))

import { configureStorage, getStorage, StorageInstance } from '../../src/storage/storage.js'

// ── configureStorage / getStorage ─────────────────────────────────────────────

describe('configureStorage / getStorage', () => {
  it('configureStorage sets up the storage instance', () => {
    configureStorage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    })
    const storage = getStorage()
    expect(storage.bucket).toBe('test-bucket')
  })
})

// ── StorageInstance ───────────────────────────────────────────────────────────

function makeStorage(overrides: Partial<{
  publicUrlBase: string
  endpoint: string
  privateUrlExpiry: number
  defaultMaxSize: number
}> = {}) {
  const config = {
    bucket: 'my-bucket',
    region: 'us-east-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    ...overrides,
  }
  return new StorageInstance(config)
}

describe('StorageInstance.generateKey', () => {
  it('produces an uploads/uuid/filename pattern', () => {
    const storage = makeStorage()
    const key = storage.generateKey('photo.jpg')
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\/photo\.jpg$/)
  })

  it('sanitizes special characters in filename', () => {
    const storage = makeStorage()
    const key = storage.generateKey('my file (1).jpg')
    expect(key).not.toContain(' ')
    expect(key).not.toContain('(')
    expect(key).not.toContain(')')
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\//)
  })

  it('collapses multiple underscores', () => {
    const storage = makeStorage()
    const key = storage.generateKey('a  b  c.jpg')
    expect(key).not.toMatch(/_{2,}/)
  })

  it('each call generates a unique key', () => {
    const storage = makeStorage()
    const k1 = storage.generateKey('test.jpg')
    const k2 = storage.generateKey('test.jpg')
    expect(k1).not.toBe(k2)
  })

  it('preserves safe characters (alphanumeric, dot, dash)', () => {
    const storage = makeStorage()
    const key = storage.generateKey('my-photo-2024.jpg')
    const filename = key.split('/').pop()!
    expect(filename).toBe('my-photo-2024.jpg')
  })
})

describe('StorageInstance.publicUrl', () => {
  it('uses publicUrlBase when configured', () => {
    const storage = makeStorage({ publicUrlBase: 'https://cdn.example.com' })
    expect(storage.publicUrl('uploads/123/photo.jpg')).toBe(
      'https://cdn.example.com/uploads/123/photo.jpg',
    )
  })

  it('strips trailing slash from publicUrlBase', () => {
    const storage = makeStorage({ publicUrlBase: 'https://cdn.example.com/' })
    expect(storage.publicUrl('uploads/123/photo.jpg')).toBe(
      'https://cdn.example.com/uploads/123/photo.jpg',
    )
  })

  it('uses endpoint URL for S3-compatible providers when no CDN', () => {
    const storage = makeStorage({ endpoint: 'https://r2.example.com' })
    expect(storage.publicUrl('uploads/123/photo.jpg')).toBe(
      'https://r2.example.com/my-bucket/uploads/123/photo.jpg',
    )
  })

  it('falls back to standard S3 URL format', () => {
    const storage = makeStorage()
    expect(storage.publicUrl('uploads/123/photo.jpg')).toBe(
      'https://my-bucket.s3.us-east-1.amazonaws.com/uploads/123/photo.jpg',
    )
  })
})

describe('StorageInstance.defaultMaxSize', () => {
  it('returns configured defaultMaxSize', () => {
    const storage = makeStorage({ defaultMaxSize: 50 * 1024 * 1024 })
    expect(storage.defaultMaxSize).toBe(50 * 1024 * 1024)
  })

  it('falls back to 100MB when not configured', () => {
    const storage = makeStorage()
    expect(storage.defaultMaxSize).toBe(100 * 1024 * 1024)
  })
})

describe('StorageInstance.privateUrlExpiry', () => {
  it('returns configured privateUrlExpiry', () => {
    const storage = makeStorage({ privateUrlExpiry: 7200 })
    expect(storage.privateUrlExpiry).toBe(7200)
  })

  it('falls back to 3600 when not configured', () => {
    const storage = makeStorage()
    expect(storage.privateUrlExpiry).toBe(3600)
  })
})

describe('StorageInstance.bucket', () => {
  it('returns the configured bucket name', () => {
    const storage = makeStorage()
    expect(storage.bucket).toBe('my-bucket')
  })
})
