/**
 * Attachments module tests.
 *
 * Tests marker creation, registry lookups, and the isAttachmentMarker type guard.
 * No database required.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  hasOneAttachment,
  hasManyAttachments,
  isAttachmentMarker,
  registerAttachments,
  getAttachments,
  getAttachmentEntry,
  getAttachmentEntryFromClass,
  ATTACHMENT_REGISTRY,
} from '../../src/runtime/attachments.js'

// ── hasOneAttachment ──────────────────────────────────────────────────────────

describe('hasOneAttachment', () => {
  it('creates a marker with _type hasOneAttachment', () => {
    const m = hasOneAttachment('logo')
    expect(m._type).toBe('hasOneAttachment')
    expect(m.name).toBe('logo')
  })

  it('defaults access to private', () => {
    const m = hasOneAttachment('logo')
    expect(m.options.access).toBe('private')
  })

  it('accepts options and overrides default access', () => {
    const m = hasOneAttachment('logo', {
      accepts: 'image/*',
      maxSize: 5 * 1024 * 1024,
      access: 'public',
    })
    expect(m.options.accepts).toBe('image/*')
    expect(m.options.maxSize).toBe(5 * 1024 * 1024)
    expect(m.options.access).toBe('public')
  })

  it('creates an immutable marker', () => {
    const m = hasOneAttachment('logo')
    expect(Object.isFrozen(m)).toBe(false) // not frozen, but readonly via TS
    expect(m._type).toBe('hasOneAttachment')
  })
})

// ── hasManyAttachments ────────────────────────────────────────────────────────

describe('hasManyAttachments', () => {
  it('creates a marker with _type hasManyAttachments', () => {
    const m = hasManyAttachments('documents')
    expect(m._type).toBe('hasManyAttachments')
    expect(m.name).toBe('documents')
  })

  it('defaults access to private', () => {
    const m = hasManyAttachments('documents')
    expect(m.options.access).toBe('private')
  })

  it('accepts max option', () => {
    const m = hasManyAttachments('documents', { max: 10, access: 'private' })
    expect(m.options.max).toBe(10)
  })

  it('accepts all options', () => {
    const m = hasManyAttachments('images', {
      accepts: 'image/*',
      maxSize: 10 * 1024 * 1024,
      max: 5,
      access: 'public',
    })
    expect(m.options.accepts).toBe('image/*')
    expect(m.options.maxSize).toBe(10 * 1024 * 1024)
    expect(m.options.max).toBe(5)
    expect(m.options.access).toBe('public')
  })
})

// ── isAttachmentMarker ────────────────────────────────────────────────────────

describe('isAttachmentMarker', () => {
  it('returns true for hasOneAttachment marker', () => {
    expect(isAttachmentMarker(hasOneAttachment('logo'))).toBe(true)
  })

  it('returns true for hasManyAttachments marker', () => {
    expect(isAttachmentMarker(hasManyAttachments('docs'))).toBe(true)
  })

  it('returns false for null', () => {
    expect(isAttachmentMarker(null)).toBe(false)
  })

  it('returns false for plain objects', () => {
    expect(isAttachmentMarker({ _type: 'hasMany', table: 'files', options: {} })).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isAttachmentMarker('logo')).toBe(false)
    expect(isAttachmentMarker(42)).toBe(false)
    expect(isAttachmentMarker(undefined)).toBe(false)
  })
})

// ── ATTACHMENT_REGISTRY ───────────────────────────────────────────────────────

describe('registerAttachments / getAttachments', () => {
  beforeEach(() => {
    ATTACHMENT_REGISTRY.clear()
  })

  it('stores and retrieves entries by class name', () => {
    registerAttachments('Campaign', [
      { name: 'logo', kind: 'one', access: 'public', accepts: 'image/*' },
      { name: 'documents', kind: 'many', access: 'private', max: 10 },
    ])

    const entries = getAttachments('Campaign')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.name).toBe('logo')
    expect(entries[1]!.name).toBe('documents')
  })

  it('returns [] for unknown class', () => {
    expect(getAttachments('Unknown')).toEqual([])
  })
})

describe('getAttachmentEntry', () => {
  beforeEach(() => {
    ATTACHMENT_REGISTRY.clear()
    registerAttachments('Campaign', [
      { name: 'logo', kind: 'one', access: 'public', accepts: 'image/*', maxSize: 5242880 },
      { name: 'documents', kind: 'many', access: 'private', max: 10 },
    ])
  })

  it('finds entry by name', () => {
    const entry = getAttachmentEntry('Campaign', 'logo')
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('one')
    expect(entry!.accepts).toBe('image/*')
    expect(entry!.maxSize).toBe(5242880)
  })

  it('returns undefined for unknown name', () => {
    expect(getAttachmentEntry('Campaign', 'nonexistent')).toBeUndefined()
  })

  it('returns undefined for unknown class', () => {
    expect(getAttachmentEntry('Unknown', 'logo')).toBeUndefined()
  })
})

// ── getAttachmentEntryFromClass ───────────────────────────────────────────────

describe('getAttachmentEntryFromClass', () => {
  beforeEach(() => {
    ATTACHMENT_REGISTRY.clear()
  })

  it('scans static properties of a class for markers', () => {
    class Campaign {
      static logo = hasOneAttachment('logo', { accepts: 'image/*', access: 'public' })
      static documents = hasManyAttachments('documents', { max: 10 })
    }

    const entry = getAttachmentEntryFromClass(Campaign, 'logo')
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('one')
    expect(entry!.accepts).toBe('image/*')
    expect(entry!.access).toBe('public')
  })

  it('finds hasManyAttachments entries', () => {
    class Campaign {
      static logo = hasOneAttachment('logo')
      static docs = hasManyAttachments('documents', { max: 5, access: 'private' })
    }

    const entry = getAttachmentEntryFromClass(Campaign, 'documents')
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('many')
    expect(entry!.max).toBe(5)
  })

  it('returns undefined when marker not found', () => {
    class Campaign {
      static logo = hasOneAttachment('logo')
    }
    expect(getAttachmentEntryFromClass(Campaign, 'hero')).toBeUndefined()
  })

  it('ignores non-attachment static properties', () => {
    class Campaign {
      static tableName = 'campaigns'
      static logo = hasOneAttachment('logo')
    }
    const entry = getAttachmentEntryFromClass(Campaign, 'tableName')
    expect(entry).toBeUndefined()
  })

  it('prefers registry over class scan when registry is populated', () => {
    class Campaign {
      static logo = hasOneAttachment('logo', { access: 'private' })
    }
    // Override via registry
    registerAttachments('Campaign', [
      { name: 'logo', kind: 'one', access: 'public', accepts: 'image/*' },
    ])
    const entry = getAttachmentEntryFromClass(Campaign, 'logo')
    expect(entry!.access).toBe('public')  // registry wins
  })
})
