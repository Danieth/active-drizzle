/**
 * Application-level field encryption.
 *
 * DESIGN PHILOSOPHY — five rules this module is built around:
 *
 *  1. **The safe thing is the default.** `.encrypt()` with no options is
 *     randomized: maximum secrecy, zero queryability. You must *opt in* to
 *     leaking equality (`deterministic: true`), never opt out of safety.
 *
 *  2. **Encryption is a codec, not a type.** It composes with whatever Attr
 *     sits underneath (`Attr.money(...).encrypt()` still does dollars↔cents),
 *     so the storage concern stays orthogonal to the domain concern.
 *
 *  3. **Fail loudly, never silently.** Every operation encryption makes
 *     impossible (ordering, ranges, LIKE, aggregates) must throw with a message
 *     naming the fix. Silence is the enemy: a randomized column GROUP BYs into
 *     one group per row and a UNIQUE index on it never fires — wrong answers,
 *     no error. See the guards in relation.ts.
 *
 *  4. **Values never leave the process.** Plaintext must not reach an error
 *     tracker, a log line, a generated client, or a query-param dump. See the
 *     redaction in error-reporting.ts.
 *
 *  5. **The format is forever.** Ciphertext is self-describing and versioned so
 *     keys can rotate and algorithms can change without a flag day.
 *
 * FORMAT:  adx1:<keyId>:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *          AES-256-GCM (authenticated — tampering throws, never silently decrypts)
 */
import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto'

const VERSION  = 'adx1'
const ALGO     = 'aes-256-gcm'
const IV_BYTES = 12          // GCM standard
const KEY_BYTES = 32         // AES-256

// ── Key management ───────────────────────────────────────────────────────────

/**
 * Supplies the keys. Envelope encryption (a KMS-wrapped data key) plugs in here
 * later without touching call sites — that's the whole point of the interface.
 */
export interface KeyProvider {
  /** Short identifier stamped into every value, so rotation is possible. */
  keyId(): string
  /** 32-byte AES key used to encrypt values. */
  dataKey(keyId?: string): Buffer
  /** 32-byte key for deterministic IVs and blind indexes (domain-separated). */
  indexKey(keyId?: string): Buffer
}

export class EncryptionError extends Error {
  constructor(message: string) { super(message); this.name = 'EncryptionError' }
}

/** Derives a domain-separated subkey so the index key is never the data key. */
function subkey(master: Buffer, label: string): Buffer {
  return createHmac('sha256', master).update(label).digest()
}

/**
 * Reads a base64 32-byte key from the environment. The *starting* point — good
 * enough for dev and single-key deployments, replaced by a KMS provider later.
 *
 *   ACTIVE_DRIZZLE_ENCRYPTION_KEY=<base64 32 bytes>
 *   ACTIVE_DRIZZLE_ENCRYPTION_KEY_ID=v1        (optional, defaults to 'env')
 */
export function envKeyProvider(env: Record<string, string | undefined> = process.env): KeyProvider {
  let cached: Buffer | null = null
  const load = (): Buffer => {
    if (cached) return cached
    const raw = env['ACTIVE_DRIZZLE_ENCRYPTION_KEY']
    if (!raw) {
      throw new EncryptionError(
        'No encryption key configured. Set ACTIVE_DRIZZLE_ENCRYPTION_KEY to a base64-encoded ' +
        '32-byte key, or install a KeyProvider with setKeyProvider(). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      )
    }
    const buf = Buffer.from(raw, 'base64')
    if (buf.length !== KEY_BYTES) {
      throw new EncryptionError(
        `ACTIVE_DRIZZLE_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${buf.length}).`,
      )
    }
    cached = buf
    return buf
  }
  const id = env['ACTIVE_DRIZZLE_ENCRYPTION_KEY_ID'] ?? 'env'
  return {
    keyId: () => id,
    dataKey: () => subkey(load(), 'active-drizzle:data'),
    indexKey: () => subkey(load(), 'active-drizzle:index'),
  }
}

let _provider: KeyProvider | null = null

/** Installs the key provider. Call once at boot, before any encrypted read/write. */
export function setKeyProvider(provider: KeyProvider): void { _provider = provider }
/** Removes the provider (test isolation). */
export function clearKeyProvider(): void { _provider = null }

function provider(): KeyProvider {
  if (_provider) return _provider
  _provider = envKeyProvider()          // lazy default; throws only if actually used
  return _provider
}

// ── Value codec ──────────────────────────────────────────────────────────────

const b64 = (b: Buffer) => b.toString('base64')

/** True when a stored value carries our envelope (cheap prefix test). */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(VERSION + ':')
}

export type EncryptMode = 'randomized' | 'deterministic'

/**
 * Encrypts a value.
 *
 * `randomized` (default) uses a fresh IV per call, so the same plaintext yields
 * different ciphertext every time — secure, but never matchable by the DB.
 *
 * `deterministic` derives the IV from the plaintext (HMAC under the index key),
 * so equal plaintext yields byte-identical ciphertext and `WHERE col = ?` works.
 * Safe with GCM specifically because a given (key, IV) pair can then only ever
 * encrypt one plaintext — the nonce-reuse failure mode can't occur. It *does*
 * leak equality, so never use it on low-cardinality columns.
 */
export function encryptValue(plain: string | null | undefined, mode: EncryptMode = 'randomized'): string | null {
  if (plain === null || plain === undefined) return null   // NULL stays NULL — IS NULL keeps working
  const p = provider()
  const key = p.dataKey()
  const text = Buffer.from(String(plain), 'utf8')

  const iv = mode === 'deterministic'
    ? createHmac('sha256', p.indexKey()).update(text).digest().subarray(0, IV_BYTES)
    : randomBytes(IV_BYTES)

  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(text), cipher.final()])
  return `${VERSION}:${p.keyId()}:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`
}

/**
 * Decrypts a value produced by {@link encryptValue}. Values that aren't in our
 * envelope pass through untouched, so a column can be read during a plaintext →
 * ciphertext backfill (dual-read) without blowing up.
 */
export function decryptValue(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null
  if (!isEncrypted(stored)) return String(stored)          // dual-read during backfill

  const parts = String(stored).split(':')
  if (parts.length !== 5) throw new EncryptionError('Malformed encrypted value (expected 5 segments).')
  const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string]

  const p = provider()
  const decipher = createDecipheriv(ALGO, p.dataKey(keyId), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // GCM auth failure: wrong key, or the ciphertext was tampered with.
    throw new EncryptionError(
      `Could not decrypt value (key '${keyId}'). The key is wrong or the data was modified.`,
    )
  }
}

// ── Blind index ──────────────────────────────────────────────────────────────

/** Normalization is part of the contract — change it and every stored hash is invalid. */
export function normalizeForIndex(value: string): string {
  return String(value).trim().toLowerCase()
}

/**
 * Keyed hash of the *normalized* plaintext, for an indexed sidecar column that
 * stays queryable while the real value remains randomized.
 *
 * `bits` deliberately truncates: fewer bits means distinct plaintexts collide,
 * turning the index into a cheap *filter* (fetch candidates, decrypt, compare)
 * instead of an equality oracle. Lower = more privacy, more false positives.
 */
export function blindIndex(value: string | null | undefined, bits = 256): string | null {
  if (value === null || value === undefined) return null
  if (bits < 8 || bits > 256 || bits % 8 !== 0) {
    throw new EncryptionError('blindIndex bits must be a multiple of 8 between 8 and 256.')
  }
  const digest = createHmac('sha256', provider().indexKey())
    .update(normalizeForIndex(String(value)))
    .digest()
  return digest.subarray(0, bits / 8).toString('hex')
}

/** Constant-time compare for blind-index values (avoids a timing oracle). */
export function blindIndexEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
