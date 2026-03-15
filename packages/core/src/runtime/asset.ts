/**
 * Asset model — framework-internal ApplicationRecord subclass for file storage metadata.
 *
 * The assets table is intentionally neutral — no user/org columns. Authorization
 * flows through the attachment → parent record → scope chain.
 *
 * url is a computed getter:
 *   public assets  → direct CDN/S3 URL (no expiry, cacheable)
 *   private assets → presigned GET URL (regenerated each serialization)
 */
import { ApplicationRecord } from './application-record.js'
import { MODEL_REGISTRY } from './boot.js'
import { getStorage } from '../storage/storage.js'

export type AssetStatus = 'pending' | 'ready'
export type AssetAccess = 'public' | 'private'

export interface AssetMetadata {
  width?: number
  height?: number
  duration?: number
  thumbnailUrl?: string
  [key: string]: unknown
}

export class Asset extends ApplicationRecord {
  static _activeDrizzleTableName = 'active_drizzle_assets'

  declare _attributes: {
    id: number
    key: string
    filename: string
    contentType: string
    byteSize: number | null
    checksum: string | null
    status: AssetStatus
    access: AssetAccess
    metadata: AssetMetadata
    createdAt: string
    updatedAt: string
    [extra: string]: unknown
  }

  get key(): string { return this._attributes.key }
  get filename(): string { return this._attributes.filename }
  get contentType(): string { return this._attributes.contentType }
  get byteSize(): number | null { return this._attributes.byteSize }
  get checksum(): string | null { return this._attributes.checksum }
  get status(): AssetStatus { return this._attributes.status as AssetStatus }
  get access(): AssetAccess { return this._attributes.access as AssetAccess }
  get metadata(): AssetMetadata { return this._attributes.metadata as AssetMetadata ?? {} }

  /**
   * Synchronous URL for public assets — direct CDN/S3 URL.
   * For private assets, use `await asset.resolveUrl()` instead.
   * Throws if called on a private asset.
   */
  get url(): string {
    if (this.access !== 'public') {
      throw new Error(`asset.url is only available for public assets. Use await asset.resolveUrl() for private assets.`)
    }
    return getStorage().publicUrl(this.key)
  }

  /**
   * Resolves the URL for any asset.
   * Public: returns direct CDN/S3 URL synchronously (wrapped in a promise for uniformity).
   * Private: generates a presigned GET URL (expires based on privateUrlExpiry config).
   */
  async resolveUrl(): Promise<string> {
    const storage = getStorage()
    if (this.access === 'public') {
      return storage.publicUrl(this.key)
    }
    return storage.presignGet(this.key)
  }

  // ── Content type predicates ─────────────────────────────────────────────

  get isImage(): boolean { return this.contentType.startsWith('image/') }
  get isAudio(): boolean { return this.contentType.startsWith('audio/') }
  get isVideo(): boolean { return this.contentType.startsWith('video/') }
  get isPdf(): boolean { return this.contentType === 'application/pdf' }

  get isReady(): boolean { return this.status === 'ready' }
  get isPending(): boolean { return this.status === 'pending' }

  /**
   * Serializes for API responses.
   * Public assets include `url` directly. Private assets omit `url` —
   * the controller must call `await asset.resolveUrl()` and inject it
   * before sending the response if needed.
   */
  override toJSON(opts?: { only?: string[]; except?: string[]; include?: string[] }): Record<string, any> {
    const json = super.toJSON(opts)
    if (this.access === 'public') {
      json.url = getStorage().publicUrl(this.key)
    }
    return json
  }
}

// Register in MODEL_REGISTRY
MODEL_REGISTRY[Asset.name] = Asset
MODEL_REGISTRY[Asset._activeDrizzleTableName] = Asset

/**
 * Attachment join record — framework-internal.
 * Polymorphic: attachableType + attachableId identify the parent record.
 * name identifies which attachment slot (e.g. 'logo', 'documents').
 * position enables ordering for hasManyAttachments.
 */
export class Attachment extends ApplicationRecord {
  static _activeDrizzleTableName = 'active_drizzle_attachments'

  declare _attributes: {
    id: number
    assetId: number
    attachableType: string
    attachableId: number
    name: string
    position: number
    createdAt: string
    [extra: string]: unknown
  }

  get assetId(): number { return this._attributes.assetId }
  get attachableType(): string { return this._attributes.attachableType }
  get attachableId(): number { return this._attributes.attachableId }
  get name(): string { return this._attributes.name }
  get position(): number { return this._attributes.position }
}

MODEL_REGISTRY[Attachment.name] = Attachment
MODEL_REGISTRY[Attachment._activeDrizzleTableName] = Attachment
