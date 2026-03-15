/**
 * AssetCleanupTask — deletes pending (orphaned) assets from S3 and the database.
 *
 * Run on a schedule (e.g. daily via cron or Trigger.dev).
 * Default: cleans assets pending for > 24 hours.
 */
import { AssetService } from '../services/asset-service.js'

export interface AssetCleanupOptions {
  /** Age in milliseconds before a pending asset is considered orphaned. Default: 24h. */
  olderThanMs?: number
}

export async function runAssetCleanup(options?: AssetCleanupOptions): Promise<{ cleaned: number }> {
  const cleaned = await AssetService.cleanupOrphans(options?.olderThanMs)
  return { cleaned }
}
