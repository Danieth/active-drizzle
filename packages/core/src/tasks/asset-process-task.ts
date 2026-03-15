/**
 * AssetProcessTask — post-upload metadata extraction.
 *
 * After an asset is confirmed, this task can extract:
 *   - Image dimensions (width, height) via sharp
 *   - Video/audio duration via ffprobe
 *   - Generate thumbnail URLs
 *
 * The implementor integrates this into their job queue (Trigger.dev, BullMQ, etc.).
 * This module provides the processing logic.
 */
import { Asset } from '../runtime/asset.js'

export interface ProcessResult {
  width?: number
  height?: number
  duration?: number
  thumbnailUrl?: string
}

/**
 * Processes a confirmed asset — extracts metadata based on content type.
 * The implementor should call this after asset confirmation, passing
 * any processing functions they want to use.
 */
export async function processAsset(
  assetId: number,
  processors?: {
    image?: (key: string, contentType: string) => Promise<Partial<ProcessResult>>
    video?: (key: string, contentType: string) => Promise<Partial<ProcessResult>>
    audio?: (key: string, contentType: string) => Promise<Partial<ProcessResult>>
  },
): Promise<ProcessResult> {
  const asset = await Asset.find(assetId)
  if (!asset || asset.status !== 'ready') return {}

  let result: ProcessResult = {}

  if (asset.isImage && processors?.image) {
    result = { ...result, ...await processors.image(asset.key, asset.contentType) }
  } else if (asset.isVideo && processors?.video) {
    result = { ...result, ...await processors.video(asset.key, asset.contentType) }
  } else if (asset.isAudio && processors?.audio) {
    result = { ...result, ...await processors.audio(asset.key, asset.contentType) }
  }

  if (Object.keys(result).length > 0) {
    const existing = asset.metadata ?? {}
    asset.metadata = { ...existing, ...result }
    await asset.save()
  }

  return result
}
