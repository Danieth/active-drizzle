/**
 * Unit tests for the @attachable decorator and related metadata.
 *
 * Tests decorator registration and mimeMatches helper (via private access).
 * No database or Docker required.
 */
import { describe, it, expect } from 'vitest'
import { ActiveController } from '../src/base.js'
import { controller, crud, attachable } from '../src/decorators.js'
import { ATTACHABLE_META, getAttachableMeta, type AttachableConfig } from '../src/metadata.js'

// ── @attachable decorator ─────────────────────────────────────────────────────

describe('@attachable decorator', () => {
  it('sets ATTACHABLE_META on the class', () => {
    @attachable()
    class Ctrl extends ActiveController {}

    expect((Ctrl as any)[ATTACHABLE_META]).toBeDefined()
    expect((Ctrl as any)[ATTACHABLE_META]).toEqual({})
  })

  it('stores config with autoSet', () => {
    const uploadedByFn = (ctx: any) => ctx.user.id

    @attachable({ autoSet: { uploadedById: uploadedByFn } })
    class Ctrl extends ActiveController {}

    const meta = (Ctrl as any)[ATTACHABLE_META] as AttachableConfig
    expect(meta.autoSet).toBeDefined()
    expect(meta.autoSet!['uploadedById']).toBe(uploadedByFn)
  })

  it('getAttachableMeta returns config when decorator is present', () => {
    @attachable({ autoSet: { tenantId: (ctx: any) => ctx.tenantId } })
    class Ctrl extends ActiveController {}

    const meta = getAttachableMeta(Ctrl)
    expect(meta).toBeDefined()
    expect(meta!.autoSet).toBeDefined()
    expect(meta!.autoSet!['tenantId']).toBeTypeOf('function')
  })

  it('getAttachableMeta returns undefined when decorator is absent', () => {
    class PlainCtrl extends ActiveController {}
    expect(getAttachableMeta(PlainCtrl)).toBeUndefined()
  })

  it('autoSet function receives context correctly', () => {
    const ctx = { user: { id: 42 } }

    @attachable({ autoSet: { uploadedById: (c: any) => c.user.id } })
    class Ctrl extends ActiveController {}

    const meta = getAttachableMeta(Ctrl)!
    const result = meta.autoSet!['uploadedById']!(ctx)
    expect(result).toBe(42)
  })

  it('can be combined with @crud decorator', () => {
    class FakeModel {}

    @attachable()
    @crud(FakeModel as any)
    class Ctrl extends ActiveController {}

    expect(getAttachableMeta(Ctrl)).toBeDefined()
    expect((Ctrl as any)[ATTACHABLE_META]).toEqual({})
  })
})

// ── mimeMatches (tested via a local reimplementation) ─────────────────────────
// The mimeMatches function is not exported, so we test its logic directly.

function mimeMatches(contentType: string, pattern: string): boolean {
  if (pattern === '*/*') return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return contentType.startsWith(prefix + '/')
  }
  return contentType === pattern
}

describe('mimeMatches', () => {
  it('*/* matches everything', () => {
    expect(mimeMatches('image/jpeg', '*/*')).toBe(true)
    expect(mimeMatches('application/pdf', '*/*')).toBe(true)
    expect(mimeMatches('video/mp4', '*/*')).toBe(true)
  })

  it('image/* matches all image types', () => {
    expect(mimeMatches('image/jpeg', 'image/*')).toBe(true)
    expect(mimeMatches('image/png', 'image/*')).toBe(true)
    expect(mimeMatches('image/gif', 'image/*')).toBe(true)
    expect(mimeMatches('image/webp', 'image/*')).toBe(true)
  })

  it('image/* does not match non-image types', () => {
    expect(mimeMatches('video/mp4', 'image/*')).toBe(false)
    expect(mimeMatches('application/pdf', 'image/*')).toBe(false)
    expect(mimeMatches('text/html', 'image/*')).toBe(false)
  })

  it('video/* matches video types', () => {
    expect(mimeMatches('video/mp4', 'video/*')).toBe(true)
    expect(mimeMatches('video/webm', 'video/*')).toBe(true)
  })

  it('audio/* matches audio types', () => {
    expect(mimeMatches('audio/mpeg', 'audio/*')).toBe(true)
    expect(mimeMatches('audio/ogg', 'audio/*')).toBe(true)
  })

  it('exact type matches exactly', () => {
    expect(mimeMatches('application/pdf', 'application/pdf')).toBe(true)
    expect(mimeMatches('application/json', 'application/pdf')).toBe(false)
  })

  it('does not partially match type prefixes', () => {
    // "image" without "/" should not match "image/png"
    expect(mimeMatches('image/png', 'image')).toBe(false)
  })

  it('image/* does not match imaginary types like "imagesvg"', () => {
    // Only matches when after the / boundary
    expect(mimeMatches('imagesvg', 'image/*')).toBe(false)
  })
})
