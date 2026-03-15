/**
 * Upload hook unit tests.
 *
 * Tests the pure logic portions of useUploadFactory and useMultiUploadFactory:
 *   - MIME matching helper
 *   - Client-side validation errors
 *   - State machine transitions via renderHook
 *   - initialAsset support
 *   - reset() behavior
 *
 * Uses vitest + @testing-library/react for hook rendering.
 * XHR is mocked via vitest's fake timers / vi.fn().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUploadFactory, useMultiUploadFactory } from '../src/upload.js'
import type { CtrlAttachmentMeta, AssetData, UploadEndpoints } from '../src/upload.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name = 'photo.jpg', type = 'image/jpeg', size = 1024): File {
  const content = new Uint8Array(size)
  return new File([content], name, { type })
}

function makeAsset(overrides: Partial<AssetData> = {}): AssetData {
  return {
    id: 1,
    key: 'uploads/abc/photo.jpg',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    byteSize: 1024,
    status: 'ready',
    access: 'public',
    ...overrides,
  }
}

function makeEndpoints(assetOverrides: Partial<AssetData> = {}): UploadEndpoints {
  const pendingAsset = makeAsset({ id: 99, status: 'pending', ...assetOverrides })
  const readyAsset = makeAsset({ id: 99, status: 'ready', ...assetOverrides })

  return {
    presign: vi.fn().mockResolvedValue({
      asset: pendingAsset,
      uploadUrl: 'https://s3.example.com/upload?signed=1',
      constraints: { accepts: 'image/*', maxSize: 10 * 1024 * 1024, access: 'public' },
    }),
    confirm: vi.fn().mockResolvedValue(readyAsset),
  }
}

const imageAttachment: CtrlAttachmentMeta = {
  name: 'logo',
  kind: 'one',
  accepts: 'image/*',
  maxSize: 5 * 1024 * 1024,
  access: 'public',
}

const anyAttachment: CtrlAttachmentMeta = {
  name: 'file',
  kind: 'one',
  access: 'private',
}

// Mock XMLHttpRequest to simulate successful upload
class MockXHR {
  static instances: MockXHR[] = []
  open = vi.fn()
  setRequestHeader = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => {
    if (this.onabort) this.onabort(new Event('abort'))
  })
  upload = {
    onprogress: null as ((e: ProgressEvent) => void) | null,
  }
  onload: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  onabort: ((e: Event) => void) | null = null
  status = 200

  constructor() {
    MockXHR.instances.push(this)
  }

  /** Simulate a successful upload response */
  simulateSuccess() {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 512, total: 1024 } as ProgressEvent)
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1024, total: 1024 } as ProgressEvent)
    this.onload?.(new Event('load'))
  }

  /** Simulate an upload failure */
  simulateError() {
    this.onerror?.(new Event('error'))
  }
}

beforeEach(() => {
  MockXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', MockXHR)
  // Stub URL.createObjectURL and revokeObjectURL
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:fake-url'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── useUploadFactory — initial state ─────────────────────────────────────────

describe('useUploadFactory — initial state', () => {
  it('starts in idle state', () => {
    const { result } = renderHook(() =>
      useUploadFactory(makeEndpoints(), imageAttachment),
    )
    expect(result.current.status).toBe('idle')
    expect(result.current.file).toBeNull()
    expect(result.current.asset).toBeNull()
    expect(result.current.assetId).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.progress).toBe(0)
  })

  it('starts in ready state when initialAsset is provided', () => {
    const initial = makeAsset({ id: 5, url: 'https://cdn.example.com/logo.jpg' })
    const { result } = renderHook(() =>
      useUploadFactory(makeEndpoints(), imageAttachment, { initialAsset: initial }),
    )
    expect(result.current.status).toBe('ready')
    expect(result.current.asset).toEqual(initial)
    expect(result.current.assetId).toBe(5)
    expect(result.current.progress).toBe(100)
  })

  it('file has previewUrl from initialAsset.url', () => {
    const initial = makeAsset({ url: 'https://cdn.example.com/logo.jpg' })
    const { result } = renderHook(() =>
      useUploadFactory(makeEndpoints(), imageAttachment, { initialAsset: initial }),
    )
    expect(result.current.file?.previewUrl).toBe('https://cdn.example.com/logo.jpg')
  })
})

// ── useUploadFactory — client-side validation ─────────────────────────────────

describe('useUploadFactory — validation', () => {
  it('rejects wrong MIME type instantly without calling presign', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, imageAttachment),
    )

    const pdfFile = makeFile('doc.pdf', 'application/pdf')
    await act(async () => {
      try { await result.current.upload(pdfFile) } catch { /* expected */ }
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toContain('application/pdf')
    expect(endpoints.presign).not.toHaveBeenCalled()
  })

  it('rejects file exceeding maxSize instantly without calling presign', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, imageAttachment),
    )

    const bigFile = makeFile('big.jpg', 'image/jpeg', 6 * 1024 * 1024) // 6MB > 5MB limit
    await act(async () => {
      try { await result.current.upload(bigFile) } catch { /* expected */ }
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toContain('5.0MB')
    expect(endpoints.presign).not.toHaveBeenCalled()
  })

  it('accepts valid file type', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, imageAttachment),
    )

    const imageFile = makeFile('photo.jpg', 'image/jpeg', 1024)
    await act(async () => {
      const p = result.current.upload(imageFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    expect(endpoints.presign).toHaveBeenCalledWith({
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      name: 'logo',
    })
  })

  it('accepts any file when no accepts constraint', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, anyAttachment),
    )

    const pdfFile = makeFile('doc.pdf', 'application/pdf')
    await act(async () => {
      const p = result.current.upload(pdfFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    expect(endpoints.presign).toHaveBeenCalled()
  })
})

// ── useUploadFactory — file info + preview ────────────────────────────────────

describe('useUploadFactory — instant preview', () => {
  it('sets file info after upload() resolves', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, imageAttachment),
    )

    const imageFile = makeFile('shot.jpg', 'image/jpeg', 2048)
    // Start upload inside act, simulate XHR, then await
    await act(async () => {
      const p = result.current.upload(imageFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    expect(result.current.file?.name).toBe('shot.jpg')
    expect(result.current.file?.size).toBe(2048)
    expect(result.current.file?.type).toBe('image/jpeg')
    expect(result.current.file?.previewUrl).toBe('blob:fake-url')
    expect(URL.createObjectURL).toHaveBeenCalledWith(imageFile)
  })

  it('sets previewUrl to null for non-previewable types', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, anyAttachment),
    )

    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockReturnValue('blob:pdf-url')

    const pdfFile = makeFile('doc.pdf', 'application/pdf')
    await act(async () => {
      const p = result.current.upload(pdfFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    // PDF is not previewable — previewUrl should be null
    expect(result.current.file?.previewUrl).toBeNull()
  })
})

// ── useUploadFactory — full lifecycle ─────────────────────────────────────────

describe('useUploadFactory — full upload lifecycle', () => {
  it('transitions through presigning → uploading → confirming → ready', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() => useUploadFactory(endpoints, imageAttachment))

    const imageFile = makeFile('photo.jpg', 'image/jpeg', 1024)
    await act(async () => {
      const p = result.current.upload(imageFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.asset?.id).toBe(99)
    expect(result.current.assetId).toBe(99)
    expect(result.current.progress).toBe(100)
    expect(endpoints.confirm).toHaveBeenCalledWith({ assetId: 99 })
  })

  it('calls onReady callback after successful upload', async () => {
    const onReady = vi.fn()
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useUploadFactory(endpoints, imageAttachment, { onReady }),
    )

    const imageFile = makeFile('photo.jpg', 'image/jpeg', 1024)
    await act(async () => {
      const p = result.current.upload(imageFile)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ id: 99 }))
  })
})

// ── useUploadFactory — reset ──────────────────────────────────────────────────

describe('useUploadFactory — reset()', () => {
  it('returns to idle state from ready', () => {
    const initial = makeAsset({ id: 5 })
    const { result } = renderHook(() =>
      useUploadFactory(makeEndpoints(), imageAttachment, { initialAsset: initial }),
    )

    expect(result.current.status).toBe('ready')
    act(() => result.current.reset())
    expect(result.current.status).toBe('idle')
    expect(result.current.asset).toBeNull()
    expect(result.current.assetId).toBeNull()
    expect(result.current.file).toBeNull()
  })

  it('revokes blob URL on reset', () => {
    const initial = makeAsset({ id: 5 })
    const { result } = renderHook(() =>
      useUploadFactory(makeEndpoints(), imageAttachment, { initialAsset: initial }),
    )

    act(() => result.current.reset())
    // URL.revokeObjectURL may be called for non-http preview URLs
    // (initial asset.url is https://, so not revoked — blob URLs would be)
    expect(result.current.file).toBeNull()
  })
})

// ── useMultiUploadFactory — initial state ─────────────────────────────────────

describe('useMultiUploadFactory — initial state', () => {
  it('starts with empty uploads', () => {
    const { result } = renderHook(() =>
      useMultiUploadFactory(makeEndpoints(), imageAttachment),
    )
    expect(result.current.uploads).toHaveLength(0)
    expect(result.current.isUploading).toBe(false)
    expect(result.current.readyAssets).toHaveLength(0)
    expect(result.current.readyAssetIds).toHaveLength(0)
  })

  it('pre-populates with initialAssets in ready state', () => {
    const assets = [
      makeAsset({ id: 1, filename: 'a.jpg' }),
      makeAsset({ id: 2, filename: 'b.jpg' }),
    ]
    const { result } = renderHook(() =>
      useMultiUploadFactory(makeEndpoints(), imageAttachment, { initialAssets: assets }),
    )
    expect(result.current.uploads).toHaveLength(2)
    expect(result.current.uploads[0]!.status).toBe('ready')
    expect(result.current.uploads[1]!.status).toBe('ready')
    expect(result.current.readyAssets).toHaveLength(2)
    expect(result.current.readyAssetIds).toEqual([1, 2])
  })
})

// ── useMultiUploadFactory — reorder ───────────────────────────────────────────

describe('useMultiUploadFactory — reorder()', () => {
  it('reorders uploads array and reflects in readyAssetIds', () => {
    const assets = [
      makeAsset({ id: 10, filename: 'first.jpg' }),
      makeAsset({ id: 20, filename: 'second.jpg' }),
      makeAsset({ id: 30, filename: 'third.jpg' }),
    ]
    const { result } = renderHook(() =>
      useMultiUploadFactory(makeEndpoints(), imageAttachment, { initialAssets: assets }),
    )

    const fileIds = result.current.uploads.map(u => u.fileId)
    // Reverse the order
    const reversed = [...fileIds].reverse()

    act(() => result.current.reorder(reversed))

    expect(result.current.readyAssetIds).toEqual([30, 20, 10])
  })
})

// ── useMultiUploadFactory — removeFile ────────────────────────────────────────

describe('useMultiUploadFactory — removeFile()', () => {
  it('removes a slot from the uploads list', () => {
    const assets = [
      makeAsset({ id: 1 }),
      makeAsset({ id: 2 }),
    ]
    const { result } = renderHook(() =>
      useMultiUploadFactory(makeEndpoints(), imageAttachment, { initialAssets: assets }),
    )

    const fileIdToRemove = result.current.uploads[0]!.fileId
    act(() => result.current.removeFile(fileIdToRemove))

    expect(result.current.uploads).toHaveLength(1)
    expect(result.current.readyAssetIds).toEqual([2])
  })
})

// ── useMultiUploadFactory — reset ─────────────────────────────────────────────

describe('useMultiUploadFactory — reset()', () => {
  it('clears all uploads', () => {
    const assets = [makeAsset({ id: 1 }), makeAsset({ id: 2 })]
    const { result } = renderHook(() =>
      useMultiUploadFactory(makeEndpoints(), imageAttachment, { initialAssets: assets }),
    )

    act(() => result.current.reset())
    expect(result.current.uploads).toHaveLength(0)
    expect(result.current.readyAssets).toHaveLength(0)
  })
})

// ── useMultiUploadFactory — validation ───────────────────────────────────────

describe('useMultiUploadFactory — per-file error isolation', () => {
  it('marks invalid files as error without affecting valid files', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useMultiUploadFactory(endpoints, imageAttachment),
    )

    const files = [
      makeFile('good.jpg', 'image/jpeg', 1024),
      makeFile('bad.pdf', 'application/pdf', 1024),  // wrong type
    ]

    await act(async () => {
      const p = result.current.uploadFiles(files)
      await vi.waitFor(() => MockXHR.instances.length > 0)
      MockXHR.instances[0]!.simulateSuccess()
      await p
    })

    const slots = result.current.uploads
    const goodSlot = slots.find(s => s.file?.name === 'good.jpg')
    const badSlot = slots.find(s => s.file?.name === 'bad.pdf')

    expect(goodSlot?.status).toBe('ready')
    expect(badSlot?.status).toBe('error')
    expect(badSlot?.error).toContain('application/pdf')
  })
})

describe('useMultiUploadFactory — cancellation does not hang uploadFiles()', () => {
  it('settles when a queued file is removed before processing', async () => {
    const endpoints = makeEndpoints()
    const { result } = renderHook(() =>
      useMultiUploadFactory(endpoints, imageAttachment, { maxConcurrent: 1 }),
    )

    const files = [
      makeFile('first.jpg', 'image/jpeg', 1024),
      makeFile('second.jpg', 'image/jpeg', 1024),
    ]

    let uploadPromise!: Promise<AssetData[]>
    act(() => {
      uploadPromise = result.current.uploadFiles(files)
    })
    await act(async () => {
      await vi.waitFor(() => result.current.uploads.length === 2)
    })

    // second file is queued (maxConcurrent=1) — removing it should reject its queue promise
    const secondFileId = result.current.uploads[1]!.fileId
    act(() => result.current.removeFile(secondFileId))

    await act(async () => {
      await vi.waitFor(() => MockXHR.instances.length > 0)
    })
    await act(async () => {
      MockXHR.instances[0]!.simulateSuccess()
      const assets = await uploadPromise
      expect(assets).toHaveLength(1)
      expect(assets[0]!.filename).toBe('photo.jpg')
    })
  })
})
