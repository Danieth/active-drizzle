/**
 * S3-compatible storage module.
 *
 * The implementor calls configureStorage() once at boot with their S3 credentials.
 * The framework handles presigned URL generation, upload verification, and key
 * management from there. Supports S3, R2, MinIO, DigitalOcean Spaces, Backblaze B2.
 */
import { randomUUID } from 'node:crypto'

// ── Lazy AWS SDK loader ────────────────────────────────────────────────────────
//
// @aws-sdk packages are optional peer dependencies. We load them lazily so that
// importing @active-drizzle/core never fails in environments where they aren't
// installed (e.g. client-side builds, codegen, tests). The first call to any
// storage method that needs AWS will load them on demand.

let _awsSdk: typeof import('@aws-sdk/client-s3') | null = null
let _presigner: typeof import('@aws-sdk/s3-request-presigner') | null = null

async function loadAwsSdk() {
  if (!_awsSdk) {
    try {
      _awsSdk = await import('@aws-sdk/client-s3')
    } catch {
      throw new Error(
        'active-drizzle: @aws-sdk/client-s3 is required for file attachments. Run: npm install @aws-sdk/client-s3',
      )
    }
  }
  if (!_presigner) {
    try {
      _presigner = await import('@aws-sdk/s3-request-presigner')
    } catch {
      throw new Error(
        'active-drizzle: @aws-sdk/s3-request-presigner is required for file attachments. Run: npm install @aws-sdk/s3-request-presigner',
      )
    }
  }
  return { sdk: _awsSdk, presigner: _presigner }
}

type S3ClientType = InstanceType<typeof import('@aws-sdk/client-s3').S3Client>

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StorageConfig {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** For S3-compatible providers (R2, MinIO, Spaces, B2) */
  endpoint?: string
  /** CDN domain for public asset URLs — e.g. 'https://cdn.example.com' */
  publicUrlBase?: string
  /** Expiry in seconds for presigned GET URLs on private assets (default 3600) */
  privateUrlExpiry?: number
  /** Global max file size in bytes (default 100MB). Per-attachment maxSize overrides. */
  defaultMaxSize?: number
}

export interface PresignPutResult {
  url: string
  key: string
}

export interface HeadObjectResult {
  contentLength: number
  contentType: string
  etag?: string
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _config: StorageConfig | null = null
let _s3: S3ClientType | null = null
let _instance: StorageInstance | null = null

const DEFAULT_MAX_SIZE = 100 * 1024 * 1024  // 100MB
const DEFAULT_PRIVATE_URL_EXPIRY = 3600     // 1 hour

export function configureStorage(config: StorageConfig): void {
  _config = config
  _s3 = null
  _instance = null  // reset cached instance so next getStorage() picks up new config
}

export function getStorage(): StorageInstance {
  if (!_config) {
    throw new Error('active-drizzle: call configureStorage() before using file attachments.')
  }
  if (!_instance) {
    _instance = new StorageInstance(_config)
  }
  return _instance
}

// ── Storage instance ──────────────────────────────────────────────────────────

export class StorageInstance {
  constructor(private config: StorageConfig) {}

  /** Lazily initializes the S3Client once (shared via module-level _s3). */
  private async getS3(): Promise<S3ClientType> {
    if (_s3) return _s3
    const { sdk } = await loadAwsSdk()
    _s3 = new sdk.S3Client({
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      ...(this.config.endpoint ? { endpoint: this.config.endpoint, forcePathStyle: true } : {}),
    })
    return _s3
  }

  get bucket(): string { return this.config.bucket }

  /**
   * Generates a presigned PUT URL for direct browser upload.
   * Content-Type is baked into the signature so S3 rejects mismatched types.
   *
   * Note: maxSize enforcement for presigned PUT is client-side only (validated
   * in useUploadFactory before presign is called). S3 presigned PUTs cannot
   * enforce a max content length — they require an exact ContentLength, which
   * we don't have until the user selects a file. Use presignPost() for
   * server-side size enforcement if needed.
   */
  async presignPut(key: string, contentType: string, _maxSize?: number): Promise<PresignPutResult> {
    const [s3, { sdk, presigner }] = await Promise.all([this.getS3(), loadAwsSdk()])
    const command = new sdk.PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: contentType,
    })

    const url = await presigner.getSignedUrl(s3, command, {
      expiresIn: 900, // 15 minutes to complete upload
    })

    return { url, key }
  }

  /** Generates a presigned GET URL for private assets. */
  async presignGet(key: string, expiry?: number): Promise<string> {
    const [s3, { sdk, presigner }] = await Promise.all([this.getS3(), loadAwsSdk()])
    const command = new sdk.GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    })

    return presigner.getSignedUrl(s3, command, {
      expiresIn: expiry ?? this.config.privateUrlExpiry ?? DEFAULT_PRIVATE_URL_EXPIRY,
    })
  }

  /** Returns a direct public URL — via CDN if configured, otherwise raw S3. */
  publicUrl(key: string): string {
    if (this.config.publicUrlBase) {
      const base = this.config.publicUrlBase.replace(/\/$/, '')
      return `${base}/${key}`
    }
    if (this.config.endpoint) {
      return `${this.config.endpoint}/${this.config.bucket}/${key}`
    }
    return `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${key}`
  }

  /** Verifies an upload landed in S3 and returns metadata. */
  async headObject(key: string): Promise<HeadObjectResult> {
    const [s3, { sdk }] = await Promise.all([this.getS3(), loadAwsSdk()])
    const command = new sdk.HeadObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    })

    const response = await s3.send(command)
    return {
      contentLength: (response as any).ContentLength ?? 0,
      contentType: (response as any).ContentType ?? 'application/octet-stream',
      etag: (response as any).ETag?.replace(/"/g, ''),
    }
  }

  /** Deletes an object from S3. */
  async deleteObject(key: string): Promise<void> {
    const [s3, { sdk }] = await Promise.all([this.getS3(), loadAwsSdk()])
    const command = new sdk.DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    })
    await s3.send(command)
  }

  /**
   * Generates an S3 key for a new upload.
   * Convention: uploads/${uuid}/${sanitizedFilename}
   */
  generateKey(filename: string): string {
    const sanitized = filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .substring(0, 255)
    return `uploads/${randomUUID()}/${sanitized}`
  }

  /** Resolved default max size for attachments that don't specify one. */
  get defaultMaxSize(): number {
    return this.config.defaultMaxSize ?? DEFAULT_MAX_SIZE
  }

  /** Resolved private URL expiry. */
  get privateUrlExpiry(): number {
    return this.config.privateUrlExpiry ?? DEFAULT_PRIVATE_URL_EXPIRY
  }
}
