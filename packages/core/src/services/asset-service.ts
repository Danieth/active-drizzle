/**
 * AssetService — backend-side asset management.
 *
 * Provides programmatic file creation (backend-initiated, no presign needed)
 * and orphan cleanup for pending assets that were never confirmed.
 */
import { Asset } from '../runtime/asset.js'
import { getStorage } from '../storage/storage.js'
import type { AssetAccess } from '../runtime/asset.js'
import { MODEL_REGISTRY, transaction } from '../runtime/boot.js'

export interface CreateFromServiceInput {
  filename: string
  contentType: string
  buffer: Buffer
  access?: AssetAccess
  metadata?: Record<string, unknown>
  attachableTo?: {
    type: string
    id: number
    name: string
  }
}

export class AssetService {
  /**
   * Creates an asset from server-side code (no presign flow needed).
   * Uploads the buffer directly to S3, creates the Asset record,
   * and optionally attaches it to a record.
   */
  static async createFromService(input: CreateFromServiceInput): Promise<typeof Asset.prototype> {
    const storage = getStorage()
    const key = storage.generateKey(input.filename)
    const access = input.access ?? 'private'

    // Generate presigned URL, then upload directly via fetch
    const { url } = await storage.presignPut(key, input.contentType)

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      body: input.buffer,
    })

    if (!response.ok) {
      throw new Error(`AssetService: S3 upload failed with status ${response.status}`)
    }

    try {
      const head = await storage.headObject(key)

      return await transaction(async () => {
        const asset = await Asset.create({
          key,
          filename: input.filename,
          contentType: input.contentType,
          byteSize: head.contentLength,
          checksum: head.etag ?? null,
          status: 'ready',
          access,
          metadata: input.metadata ?? {},
        })

        if (input.attachableTo) {
          const { type, id, name } = input.attachableTo
          const Target = (MODEL_REGISTRY as Record<string, any>)[type]
          if (!Target) throw new Error(`AssetService: attachable model '${type}' is not registered`)
          const record = await Target.find(id)
          await record.attach(name, asset.id)
        }

        return asset
      })
    } catch (error) {
      try { await storage.deleteObject(key) } catch { /* best-effort cleanup */ }
      throw error
    }
  }

  /**
   * Cleans up orphaned assets — pending assets older than the threshold
   * that were never confirmed (presigned but upload never completed/confirmed).
   *
   * @param olderThanMs - Age threshold in milliseconds (default: 24 hours)
   */
  static async cleanupOrphans(olderThanMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const storage = getStorage()

    const allPending = await Asset.where({ status: 'pending' }).load()
    const orphans = allPending.filter((a: any) => new Date(a.createdAt) < cutoff)

    let count = 0
    for (const asset of orphans) {
      try {
        await storage.deleteObject(asset.key)
      } catch {
        // S3 deletion may fail for already-gone objects — continue
      }
      await asset.destroy()
      count++
    }

    return count
  }
}
