/**
 * The asset-ownership guard — closes the presign→confirm→attach IDOR.
 *
 * The assets table is deliberately neutral (no user/org columns): once an
 * asset is ATTACHED, authorization flows attachment → parent record → scope
 * chain. But a PENDING asset has no parent yet — that window is what this
 * guard governs, ActiveStorage-style:
 *
 *   presign  STAMPS the asset:  metadata.model  (which model family),
 *                               metadata.scope  (the door's resolved scope
 *                                               values — @scope params AND
 *                                               scopeBy output),
 *                               metadata.uploadToken (random, returned ONCE
 *                                               to the presigning client,
 *                                               redacted from every
 *                                               serialization after)
 *   confirm  proves possession: token + scope must match
 *   attach / form auto-attach   anchor to the RECORD: the loaded record's
 *                               own scope columns must equal the stamp
 *
 * Every failure is NotFound — an attacker probing foreign asset ids learns
 * nothing about which ids exist (no oracle).
 */
import { randomBytes } from 'node:crypto'
import { NotFound } from './errors.js'

export const UPLOAD_TOKEN_KEY = 'uploadToken'

/** High-entropy possession proof, generated at presign. */
export function generateUploadToken(): string {
  return randomBytes(24).toString('base64url')
}

export interface AssetGuardOptions {
  /** The door's model class name — must equal the presign stamp. */
  model: string
  /**
   * Resolves the CURRENT request's value for a stamped scope key:
   * confirm passes URL params + scopeBy output; attach/auto-attach pass the
   * loaded record's own columns. Every stamped key must match.
   */
  anchor: (key: string) => unknown
  /** The client's possession proof — required whenever the asset carries one. */
  uploadToken?: string | undefined
  /** Skip the token check (record-anchored paths, where the id rides a
   *  permitted column and the scope stamp is the whole proof). */
  skipToken?: boolean
  /** Require status 'ready' (attach paths; confirm wants 'pending' itself). */
  requireReady?: boolean
}

/**
 * Verifies an Asset may be touched by the current request. Throws NotFound
 * (never a distinguishing error) on any ownership failure.
 */
export function assertAssetTouchable(asset: any, opts: AssetGuardOptions): void {
  const meta = (asset?.metadata ?? {}) as Record<string, unknown>

  // Un-stamped assets were not presigned through a door — a client-supplied
  // id may only ever name an asset the door family minted. (Server-side
  // code attaching its own assets calls record.attach directly and never
  // passes through this guard.)
  if (meta.model !== opts.model) throw new NotFound('Asset')

  if (!opts.skipToken) {
    const stamped = meta[UPLOAD_TOKEN_KEY]
    if (typeof stamped !== 'string' || stamped.length === 0) throw new NotFound('Asset')
    if (opts.uploadToken !== stamped) throw new NotFound('Asset')
  }

  const scope = (meta.scope ?? {}) as Record<string, unknown>
  for (const [key, stampedValue] of Object.entries(scope)) {
    const current = opts.anchor(key)
    if (current === undefined || current === null) throw new NotFound('Asset')
    if (String(current) !== String(stampedValue)) throw new NotFound('Asset')
  }

  if (opts.requireReady && asset.status !== 'ready') throw new NotFound('Asset')
}
