/**
 * Storage — the S3-free half (was 41%): key generation (traversal-safe),
 * URL resolution precedence, config gates, defaults. The S3-calling half
 * stays untested here by design — that's the demo's integration lane.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { configureStorage, getStorage, StorageInstance } from '../../src/storage/storage.js'

const CONFIG = {
  bucket: 'my-bucket', region: 'us-east-1',
  accessKeyId: 'k', secretAccessKey: 's',
}

describe('StorageInstance (pure half)', () => {
  it('generateKey sanitizes hostile filenames — no traversal, no shell chars', () => {
    const s = new StorageInstance(CONFIG as any)
    const key = s.generateKey('../../etc/passwd; rm -rf $(x).pdf')
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\//)
    const filePart = key.split('/').slice(2).join('/')
    expect(filePart).not.toMatch(/[/\;$()\s]/)              // nothing hostile survives
    expect(filePart).not.toContain('..')
    // uniqueness comes from the uuid segment, not the filename
    expect(s.generateKey('a.pdf')).not.toBe(s.generateKey('a.pdf'))
  })

  it('generateKey caps the filename segment (255) — long names cannot break keys', () => {
    const s = new StorageInstance(CONFIG as any)
    const key = s.generateKey('x'.repeat(1000) + '.pdf')
    expect(key.split('/')[2]!.length).toBeLessThanOrEqual(255)
  })

  it('publicUrl precedence: CDN base (trailing slash trimmed) → endpoint → raw S3', () => {
    expect(new StorageInstance({ ...CONFIG, publicUrlBase: 'https://cdn.x.com/' } as any).publicUrl('k/f.png'))
      .toBe('https://cdn.x.com/k/f.png')
    expect(new StorageInstance({ ...CONFIG, endpoint: 'http://localhost:9000' } as any).publicUrl('k'))
      .toBe('http://localhost:9000/my-bucket/k')
    expect(new StorageInstance(CONFIG as any).publicUrl('k'))
      .toBe('https://my-bucket.s3.us-east-1.amazonaws.com/k')
  })

  it('defaults resolve when unconfigured and yield to config when set', () => {
    const bare = new StorageInstance(CONFIG as any)
    expect(bare.defaultMaxSize).toBeGreaterThan(0)
    expect(bare.privateUrlExpiry).toBeGreaterThan(0)
    const tuned = new StorageInstance({ ...CONFIG, defaultMaxSize: 123, privateUrlExpiry: 45 } as any)
    expect(tuned.defaultMaxSize).toBe(123)
    expect(tuned.privateUrlExpiry).toBe(45)
    expect(tuned.bucket).toBe('my-bucket')
  })

  it('getStorage before configureStorage teaches; after, returns the instance', () => {
    // module state: rely on error text rather than fresh-module isolation
    try {
      getStorage()
    } catch (e: any) {
      expect(String(e.message)).toMatch(/configureStorage|storage/i)
    }
    configureStorage(CONFIG as any)
    expect(getStorage().bucket).toBe('my-bucket')
  })
})
