import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  encryptValue, decryptValue, isEncrypted, blindIndex, blindIndexEquals,
  normalizeForIndex, envKeyProvider, setKeyProvider, clearKeyProvider,
  EncryptionError, type KeyProvider,
} from '../../src/runtime/encryption.js'

const KEY  = randomBytes(32).toString('base64')
const KEY2 = randomBytes(32).toString('base64')

function useKey(key = KEY, id = 'v1') {
  setKeyProvider(envKeyProvider({
    ACTIVE_DRIZZLE_ENCRYPTION_KEY: key,
    ACTIVE_DRIZZLE_ENCRYPTION_KEY_ID: id,
  }))
}

beforeEach(() => useKey())
afterEach(() => clearKeyProvider())

describe('round-trip', () => {
  it('encrypts and decrypts back to the original', () => {
    const ct = encryptValue('hello world')!
    expect(ct).not.toContain('hello world')
    expect(decryptValue(ct)).toBe('hello world')
  })

  it('handles unicode, empty strings, and long values', () => {
    for (const v of ['', 'héllo 🌍', 'a'.repeat(10_000), '{"json":true}']) {
      expect(decryptValue(encryptValue(v)!)).toBe(v)
    }
  })

  it('NULL stays NULL — so IS NULL keeps working', () => {
    expect(encryptValue(null)).toBeNull()
    expect(encryptValue(undefined)).toBeNull()
    expect(decryptValue(null)).toBeNull()
  })

  it('produces the documented self-describing format', () => {
    const ct = encryptValue('x')!
    const parts = ct.split(':')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toBe('adx1')     // version
    expect(parts[1]).toBe('v1')       // keyId — enables rotation
    expect(isEncrypted(ct)).toBe(true)
    expect(isEncrypted('plain text')).toBe(false)
  })
})

describe('randomized mode (the safe default)', () => {
  it('same plaintext → DIFFERENT ciphertext every time', () => {
    const a = encryptValue('same')!
    const b = encryptValue('same')!
    expect(a).not.toBe(b)                 // this is what makes it unqueryable
    expect(decryptValue(a)).toBe('same')
    expect(decryptValue(b)).toBe('same')
  })

  it('is the default when no mode is given', () => {
    expect(encryptValue('x')).not.toBe(encryptValue('x'))
  })
})

describe('deterministic mode', () => {
  it('same plaintext → IDENTICAL ciphertext (so WHERE col = ? matches)', () => {
    const a = encryptValue('a@b.co', 'deterministic')!
    const b = encryptValue('a@b.co', 'deterministic')!
    expect(a).toBe(b)
    expect(decryptValue(a)).toBe('a@b.co')
  })

  it('different plaintext → different ciphertext', () => {
    expect(encryptValue('a@b.co', 'deterministic')).not.toBe(encryptValue('c@d.co', 'deterministic'))
  })

  it('is case/whitespace SENSITIVE — no hidden normalization', () => {
    // Deterministic encrypts exact bytes. Normalization belongs to blind
    // indexes; doing it here would silently change what round-trips back.
    expect(encryptValue('A@B.co', 'deterministic')).not.toBe(encryptValue('a@b.co', 'deterministic'))
  })
})

describe('authentication (GCM) — tampering must throw, never silently decrypt', () => {
  it('rejects a modified ciphertext', () => {
    const ct = encryptValue('sensitive')!
    const parts = ct.split(':')
    const body = Buffer.from(parts[4]!, 'base64')
    body[0] = body[0]! ^ 0xff                       // flip a bit
    parts[4] = body.toString('base64')
    expect(() => decryptValue(parts.join(':'))).toThrow(EncryptionError)
  })

  it('rejects a modified auth tag', () => {
    const parts = encryptValue('sensitive')!.split(':')
    const tag = Buffer.from(parts[3]!, 'base64')
    tag[0] = tag[0]! ^ 0xff
    parts[3] = tag.toString('base64')
    expect(() => decryptValue(parts.join(':'))).toThrow(EncryptionError)
  })

  it('rejects decryption under the WRONG key', () => {
    const ct = encryptValue('secret')!
    useKey(KEY2, 'v2')
    expect(() => decryptValue(ct)).toThrow(/could not decrypt/i)
  })

  it('rejects a malformed envelope', () => {
    expect(() => decryptValue('adx1:v1:only:three')).toThrow(EncryptionError)
  })
})

describe('backfill safety (dual-read)', () => {
  it('passes plaintext through untouched, so a half-migrated column still reads', () => {
    // Mid-backfill a column holds BOTH shapes; reads must not explode.
    expect(decryptValue('legacy plaintext')).toBe('legacy plaintext')
    expect(decryptValue(encryptValue('migrated')!)).toBe('migrated')
  })
})

describe('key isolation', () => {
  it('the index key is NOT the data key (domain separation)', () => {
    // If they were equal, a leaked blind index would weaken the cipher.
    const p = envKeyProvider({ ACTIVE_DRIZZLE_ENCRYPTION_KEY: KEY })
    expect(p.dataKey().equals(p.indexKey())).toBe(false)
  })

  it('a missing key produces an actionable error, not a crash', () => {
    clearKeyProvider()
    setKeyProvider(envKeyProvider({}))
    expect(() => encryptValue('x')).toThrow(/ACTIVE_DRIZZLE_ENCRYPTION_KEY/)
  })

  it('rejects a wrong-length key', () => {
    setKeyProvider(envKeyProvider({ ACTIVE_DRIZZLE_ENCRYPTION_KEY: Buffer.from('too short').toString('base64') }))
    expect(() => encryptValue('x')).toThrow(/32 bytes/)
  })

  it('a custom KeyProvider can be installed (the KMS seam)', () => {
    const fixed = Buffer.alloc(32, 7)
    const custom: KeyProvider = { keyId: () => 'kms-1', dataKey: () => fixed, indexKey: () => Buffer.alloc(32, 9) }
    setKeyProvider(custom)
    const ct = encryptValue('via kms')!
    expect(ct.split(':')[1]).toBe('kms-1')       // keyId stamped for rotation
    expect(decryptValue(ct)).toBe('via kms')
  })
})

describe('blind index', () => {
  it('is stable for the same value and differs across values', () => {
    expect(blindIndex('a@b.co')).toBe(blindIndex('a@b.co'))
    expect(blindIndex('a@b.co')).not.toBe(blindIndex('c@d.co'))
  })

  it('normalizes case and whitespace (so lookups actually match)', () => {
    expect(blindIndex('  A@B.co ')).toBe(blindIndex('a@b.co'))
    expect(normalizeForIndex('  MiXeD  ')).toBe('mixed')
  })

  it('never reveals the plaintext', () => {
    const idx = blindIndex('supersecret')!
    expect(idx).not.toContain('supersecret')
    expect(idx).toMatch(/^[0-9a-f]+$/)
  })

  it('truncation trades precision for privacy', () => {
    expect(blindIndex('x', 256)!.length).toBe(64)   // hex chars
    expect(blindIndex('x', 32)!.length).toBe(8)
    expect(blindIndex('x', 32)).toBe(blindIndex('x', 256)!.slice(0, 8))  // prefix of the full hash
  })

  it('rejects nonsensical bit widths', () => {
    expect(() => blindIndex('x', 7)).toThrow(EncryptionError)
    expect(() => blindIndex('x', 512)).toThrow(EncryptionError)
  })

  it('is key-dependent — a different key yields a different index', () => {
    const a = blindIndex('a@b.co')
    useKey(KEY2, 'v2')
    expect(blindIndex('a@b.co')).not.toBe(a)
  })

  it('compares in constant time', () => {
    expect(blindIndexEquals(blindIndex('x'), blindIndex('x'))).toBe(true)
    expect(blindIndexEquals(blindIndex('x'), blindIndex('y'))).toBe(false)
    expect(blindIndexEquals(null, null)).toBe(true)
  })

  it('NULL stays NULL', () => {
    expect(blindIndex(null)).toBeNull()
  })
})
