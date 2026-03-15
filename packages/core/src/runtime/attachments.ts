/**
 * Attachment markers — hasOneAttachment / hasManyAttachments.
 *
 * These follow the same static-property-as-marker pattern as belongsTo/hasMany.
 * The proxy in ApplicationRecord detects AttachmentMarker._type and resolves
 * via the polymorphic attachments join table.
 *
 * The ATTACHMENT_REGISTRY tracks all declared attachments per model class name,
 * used at runtime by .attach()/.detach() and at codegen time by the extractor.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AttachmentOptions {
  /** MIME filter — 'image/*', 'audio/*', 'application/pdf', etc. */
  accepts?: string
  /** Max file size in bytes. Falls back to configureStorage().defaultMaxSize. */
  maxSize?: number
  /** Controls S3 ACL and how asset.url resolves. Default 'private'. */
  access?: 'public' | 'private'
}

export interface HasManyAttachmentOptions extends AttachmentOptions {
  /** Maximum number of attachments for this slot. Enforced on attach(). */
  max?: number
}

export type AttachmentMarker = HasOneAttachmentMarker | HasManyAttachmentMarker

export interface HasOneAttachmentMarker {
  readonly _type: 'hasOneAttachment'
  readonly name: string
  readonly options: AttachmentOptions
}

export interface HasManyAttachmentMarker {
  readonly _type: 'hasManyAttachments'
  readonly name: string
  readonly options: HasManyAttachmentOptions
}

// ── Marker functions ──────────────────────────────────────────────────────────

export function hasOneAttachment(name: string, options: AttachmentOptions = {}): HasOneAttachmentMarker {
  const marker: HasOneAttachmentMarker = {
    _type: 'hasOneAttachment',
    name,
    options: { access: 'private', ...options },
  }
  return marker
}

export function hasManyAttachments(name: string, options: HasManyAttachmentOptions = {}): HasManyAttachmentMarker {
  const marker: HasManyAttachmentMarker = {
    _type: 'hasManyAttachments',
    name,
    options: { access: 'private', ...options },
  }
  return marker
}

// ── Attachment registry ───────────────────────────────────────────────────────

export interface AttachmentEntry {
  name: string
  kind: 'one' | 'many'
  accepts?: string
  maxSize?: number
  max?: number
  access: 'public' | 'private'
}

/**
 * Global registry of attachment declarations per model class name.
 * Optional — can be pre-populated via registerAttachments() for performance,
 * but all lookups fall back to scanning MODEL_REGISTRY if not found here.
 */
export const ATTACHMENT_REGISTRY = new Map<string, AttachmentEntry[]>()

/**
 * Explicitly registers attachment declarations for a model class.
 * Not required — getAttachments/getAttachmentEntry scan the class automatically.
 */
export function registerAttachments(className: string, entries: AttachmentEntry[]): void {
  ATTACHMENT_REGISTRY.set(className, entries)
}

/** Scans a model class's static properties for attachment markers. */
function _scanClassAttachments(modelClass: any): AttachmentEntry[] {
  const entries: AttachmentEntry[] = []
  for (const key of Object.getOwnPropertyNames(modelClass)) {
    const prop = modelClass[key]
    if (!prop || typeof prop !== 'object') continue
    if (prop._type === 'hasOneAttachment') {
      entries.push({
        name: prop.name,
        kind: 'one',
        accepts: prop.options?.accepts,
        maxSize: prop.options?.maxSize,
        access: prop.options?.access ?? 'private',
      })
    } else if (prop._type === 'hasManyAttachments') {
      entries.push({
        name: prop.name,
        kind: 'many',
        accepts: prop.options?.accepts,
        maxSize: prop.options?.maxSize,
        max: prop.options?.max,
        access: prop.options?.access ?? 'private',
      })
    }
  }
  return entries
}

/**
 * Gets all attachment declarations for a model class name.
 * Checks registry first, then scans MODEL_REGISTRY if available.
 */
export function getAttachments(className: string): AttachmentEntry[] {
  const registered = ATTACHMENT_REGISTRY.get(className)
  if (registered) return registered
  // Scan MODEL_REGISTRY directly if class is available there
  const modelClass = _getModelClass(className)
  if (!modelClass) return []
  return _scanClassAttachments(modelClass)
}

/** Gets a single attachment declaration by name. */
export function getAttachmentEntry(className: string, name: string): AttachmentEntry | undefined {
  return getAttachments(className).find(a => a.name === name)
}

// Avoid circular import: lazily access MODEL_REGISTRY only when needed.
// boot.ts does not import attachments.ts, so this is safe.
let _modelRegistryRef: Record<string, any> | null = null
function _getModelClass(className: string): any {
  if (!_modelRegistryRef) {
    // MODEL_REGISTRY is populated by @model decorators, which run before queries
    try {
      // Dynamic access via globalThis to avoid ESM circular dependency at parse time
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = globalThis as any
      if (!g.__activeDrizzleModelRegistry) return null
      return g.__activeDrizzleModelRegistry[className] ?? null
    } catch { return null }
  }
  return _modelRegistryRef[className] ?? null
}

/**
 * Called by boot.ts to wire up MODEL_REGISTRY for attachment lookups.
 * This avoids circular imports between attachments.ts and boot.ts.
 */
export function _wireAttachmentRegistry(registry: Record<string, any>): void {
  _modelRegistryRef = registry
}

/** Scans a model class directly (used internally by attach() where the class is already known). */
export function getAttachmentEntryFromClass(modelClass: any, name: string): AttachmentEntry | undefined {
  const className: string = modelClass?.name
  if (!className) return undefined
  // Check registry first (fast path)
  const registered = ATTACHMENT_REGISTRY.get(className)
  if (registered) return registered.find(a => a.name === name)
  // Scan static props
  return _scanClassAttachments(modelClass).find(a => a.name === name)
}

/** Type guard for attachment markers. */
export function isAttachmentMarker(value: unknown): value is AttachmentMarker {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_type' in value &&
    (value._type === 'hasOneAttachment' || value._type === 'hasManyAttachments')
  )
}
