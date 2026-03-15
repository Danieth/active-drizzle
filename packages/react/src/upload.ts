/**
 * Upload hook factories — useUploadFactory / useMultiUploadFactory.
 *
 * These implement the full presign → XHR PUT → confirm lifecycle with:
 *   - Client-side validation (accepts + maxSize) before presign
 *   - Instant preview via URL.createObjectURL
 *   - Real progress tracking via XHR onprogress
 *   - Abort-on-unmount + reset-as-cancel
 *   - initialAsset support for edit forms
 *   - Concurrency limiting for multi-upload
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type UploadStatus = 'idle' | 'validating' | 'presigning' | 'uploading' | 'confirming' | 'ready' | 'error'

export interface UploadFileInfo {
  name: string
  size: number
  type: string
  previewUrl: string | null
}

export interface AssetData {
  id: number
  key: string
  filename: string
  contentType: string
  byteSize?: number | null
  url?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface CtrlAttachmentMeta {
  name: string
  kind: 'one' | 'many'
  accepts?: string
  maxSize?: number
  max?: number
  access: 'public' | 'private'
}

export interface UploadEndpoints {
  presign: (input: { filename: string; contentType: string; name: string }) => Promise<{
    asset: AssetData
    uploadUrl: string
    constraints: { accepts?: string; maxSize: number; access: string }
  }>
  confirm: (input: { assetId: number }) => Promise<AssetData>
}

// ── UseUpload ─────────────────────────────────────────────────────────────────

export interface UseUploadReturn {
  status: UploadStatus
  progress: number
  loaded: number
  total: number
  file: UploadFileInfo | null
  asset: AssetData | null
  assetId: number | null
  error: string | null
  upload: (file: File) => Promise<AssetData>
  reset: () => void
}

export interface UseUploadOptions {
  initialAsset?: AssetData | null
  onReady?: (asset: AssetData) => void
}

export function useUploadFactory(
  endpoints: UploadEndpoints,
  attachmentMeta: CtrlAttachmentMeta,
  options?: UseUploadOptions,
): UseUploadReturn {
  const { initialAsset, onReady } = options ?? {}

  const [status, setStatus] = useState<UploadStatus>(initialAsset ? 'ready' : 'idle')
  const [progress, setProgress] = useState(initialAsset ? 100 : 0)
  const [loaded, setLoaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [file, setFile] = useState<UploadFileInfo | null>(
    initialAsset
      ? { name: initialAsset.filename, size: initialAsset.byteSize ?? 0, type: initialAsset.contentType, previewUrl: initialAsset.url ?? null }
      : null,
  )
  const [asset, setAsset] = useState<AssetData | null>(initialAsset ?? null)
  const [error, setError] = useState<string | null>(null)

  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const previewUrlRef = useRef<string | null>(initialAsset?.url ?? null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      _cleanup()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function _cleanup() {
    if (xhrRef.current) {
      xhrRef.current.abort()
      xhrRef.current = null
    }
    if (previewUrlRef.current && !previewUrlRef.current.startsWith('http')) {
      URL.revokeObjectURL(previewUrlRef.current)
    }
    previewUrlRef.current = null
  }

  const reset = useCallback(() => {
    _cleanup()
    setStatus('idle')
    setProgress(0)
    setLoaded(0)
    setTotal(0)
    setFile(null)
    setAsset(null)
    setError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const upload = useCallback(async (browserFile: File): Promise<AssetData> => {
    _cleanup()

    // Set file info + preview immediately
    const previewUrl = canPreview(browserFile.type) ? URL.createObjectURL(browserFile) : null
    previewUrlRef.current = previewUrl
    setFile({ name: browserFile.name, size: browserFile.size, type: browserFile.type, previewUrl })
    setTotal(browserFile.size)
    setLoaded(0)
    setProgress(0)
    setError(null)

    // Client-side validation
    setStatus('validating')
    if (attachmentMeta.accepts && !mimeMatches(browserFile.type, attachmentMeta.accepts)) {
      const msg = `File type '${browserFile.type}' is not accepted. Accepted: ${attachmentMeta.accepts}`
      setStatus('error')
      setError(msg)
      throw new Error(msg)
    }
    if (attachmentMeta.maxSize && browserFile.size > attachmentMeta.maxSize) {
      const msg = `File size ${formatBytes(browserFile.size)} exceeds maximum of ${formatBytes(attachmentMeta.maxSize)}`
      setStatus('error')
      setError(msg)
      throw new Error(msg)
    }

    // Presign
    setStatus('presigning')
    let presignResult: Awaited<ReturnType<UploadEndpoints['presign']>>
    try {
      presignResult = await endpoints.presign({
        filename: browserFile.name,
        contentType: browserFile.type,
        name: attachmentMeta.name,
      })
    } catch (e: any) {
      if (!mountedRef.current) throw e
      const msg = e?.message ?? 'Presign failed'
      setStatus('error')
      setError(msg)
      throw e
    }

    // XHR upload with progress
    if (!mountedRef.current) throw new Error('Component unmounted')
    setStatus('uploading')

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhrRef.current = xhr

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && mountedRef.current) {
          setLoaded(e.loaded)
          setTotal(e.total)
          setProgress(Math.round((e.loaded / e.total) * 100))
        }
      }

      xhr.onload = () => {
        xhrRef.current = null
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`))
        }
      }

      xhr.onerror = () => {
        xhrRef.current = null
        reject(new Error('Upload failed — network error'))
      }

      xhr.onabort = () => {
        xhrRef.current = null
        reject(new Error('Upload aborted'))
      }

      xhr.open('PUT', presignResult.uploadUrl)
      xhr.setRequestHeader('Content-Type', browserFile.type)
      xhr.send(browserFile)
    }).catch((e) => {
      if (!mountedRef.current) throw e
      setStatus('error')
      setError(e.message)
      throw e
    })

    // Confirm
    if (!mountedRef.current) throw new Error('Component unmounted')
    setStatus('confirming')

    let confirmedAsset: AssetData
    try {
      confirmedAsset = await endpoints.confirm({ assetId: presignResult.asset.id })
    } catch (e: any) {
      if (!mountedRef.current) throw e
      const msg = e?.message ?? 'Confirm failed'
      setStatus('error')
      setError(msg)
      throw e
    }

    if (!mountedRef.current) throw new Error('Component unmounted')
    setStatus('ready')
    setProgress(100)
    setAsset(confirmedAsset)
    onReady?.(confirmedAsset)

    return confirmedAsset
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints, attachmentMeta, onReady])

  return {
    status,
    progress,
    loaded,
    total,
    file,
    asset,
    assetId: asset?.id ?? null,
    error,
    upload,
    reset,
  }
}

// ── UseMultiUpload ────────────────────────────────────────────────────────────

export interface MultiUploadSlot {
  fileId: string
  status: UploadStatus
  progress: number
  loaded: number
  total: number
  file: UploadFileInfo | null
  asset: AssetData | null
  error: string | null
}

export interface UseMultiUploadReturn {
  uploads: MultiUploadSlot[]
  uploadFiles: (files: File[]) => Promise<AssetData[]>
  removeFile: (fileId: string) => void
  reorder: (orderedFileIds: string[]) => void
  reset: () => void
  isUploading: boolean
  readyAssets: AssetData[]
  readyAssetIds: number[]
}

export interface UseMultiUploadOptions {
  initialAssets?: AssetData[]
  maxConcurrent?: number
  onReady?: (assets: AssetData[]) => void
  onFileReady?: (asset: AssetData) => void
}

export function useMultiUploadFactory(
  endpoints: UploadEndpoints,
  attachmentMeta: CtrlAttachmentMeta,
  options?: UseMultiUploadOptions,
): UseMultiUploadReturn {
  const { initialAssets, maxConcurrent = 3, onReady, onFileReady } = options ?? {}

  const initialSlots: MultiUploadSlot[] = useMemo(() =>
    (initialAssets ?? []).map(a => ({
      fileId: crypto.randomUUID(),
      status: 'ready' as UploadStatus,
      progress: 100,
      loaded: a.byteSize ?? 0,
      total: a.byteSize ?? 0,
      file: { name: a.filename, size: a.byteSize ?? 0, type: a.contentType, previewUrl: a.url ?? null },
      asset: a,
      error: null,
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [])

  const [slots, setSlots] = useState<MultiUploadSlot[]>(initialSlots)
  const xhrsRef = useRef<Map<string, XMLHttpRequest>>(new Map())
  const previewUrlsRef = useRef<Map<string, string>>(new Map())
  const mountedRef = useRef(true)
  const activeRef = useRef(0)
  const queueRef = useRef<Array<{ fileId: string; file: File; resolve: (a: AssetData) => void; reject: (e: Error) => void }>>([])

  function rejectQueued(fileId: string, message: string) {
    const nextQueue: typeof queueRef.current = []
    for (const queued of queueRef.current) {
      if (queued.fileId === fileId) {
        queued.reject(new Error(message))
      } else {
        nextQueue.push(queued)
      }
    }
    queueRef.current = nextQueue
  }

  function rejectAllQueued(message: string) {
    for (const queued of queueRef.current) queued.reject(new Error(message))
    queueRef.current = []
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const xhr of xhrsRef.current.values()) xhr.abort()
      rejectAllQueued('Upload cancelled')
      for (const url of previewUrlsRef.current.values()) {
        if (!url.startsWith('http')) URL.revokeObjectURL(url)
      }
    }
  }, [])

  function updateSlot(fileId: string, updates: Partial<MultiUploadSlot>) {
    if (!mountedRef.current) return
    setSlots(prev => prev.map(s => s.fileId === fileId ? { ...s, ...updates } : s))
  }

  async function processOne(fileId: string, browserFile: File): Promise<AssetData> {
    // Client-side validation
    updateSlot(fileId, { status: 'validating' })
    if (attachmentMeta.accepts && !mimeMatches(browserFile.type, attachmentMeta.accepts)) {
      const msg = `File type '${browserFile.type}' is not accepted. Accepted: ${attachmentMeta.accepts}`
      updateSlot(fileId, { status: 'error', error: msg })
      throw new Error(msg)
    }
    if (attachmentMeta.maxSize && browserFile.size > attachmentMeta.maxSize) {
      const msg = `File size ${formatBytes(browserFile.size)} exceeds maximum of ${formatBytes(attachmentMeta.maxSize)}`
      updateSlot(fileId, { status: 'error', error: msg })
      throw new Error(msg)
    }

    // Presign
    updateSlot(fileId, { status: 'presigning' })
    let presignResult: Awaited<ReturnType<UploadEndpoints['presign']>>
    try {
      presignResult = await endpoints.presign({
        filename: browserFile.name,
        contentType: browserFile.type,
        name: attachmentMeta.name,
      })
    } catch (e: any) {
      updateSlot(fileId, { status: 'error', error: e?.message ?? 'Presign failed' })
      throw e
    }

    // XHR upload
    if (!mountedRef.current) throw new Error('Unmounted')
    updateSlot(fileId, { status: 'uploading' })

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhrsRef.current.set(fileId, xhr)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && mountedRef.current) {
          updateSlot(fileId, {
            loaded: e.loaded,
            total: e.total,
            progress: Math.round((e.loaded / e.total) * 100),
          })
        }
      }

      xhr.onload = () => {
        xhrsRef.current.delete(fileId)
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Upload failed with status ${xhr.status}`))
      }
      xhr.onerror = () => { xhrsRef.current.delete(fileId); reject(new Error('Network error')) }
      xhr.onabort = () => { xhrsRef.current.delete(fileId); reject(new Error('Aborted')) }

      xhr.open('PUT', presignResult.uploadUrl)
      xhr.setRequestHeader('Content-Type', browserFile.type)
      xhr.send(browserFile)
    }).catch((e) => {
      updateSlot(fileId, { status: 'error', error: e.message })
      throw e
    })

    // Confirm
    if (!mountedRef.current) throw new Error('Unmounted')
    updateSlot(fileId, { status: 'confirming' })

    let confirmedAsset: AssetData
    try {
      confirmedAsset = await endpoints.confirm({ assetId: presignResult.asset.id })
    } catch (e: any) {
      updateSlot(fileId, { status: 'error', error: e?.message ?? 'Confirm failed' })
      throw e
    }

    updateSlot(fileId, { status: 'ready', progress: 100, asset: confirmedAsset })
    onFileReady?.(confirmedAsset)
    return confirmedAsset
  }

  function drainQueue() {
    while (activeRef.current < maxConcurrent && queueRef.current.length > 0) {
      const item = queueRef.current.shift()!
      activeRef.current++
      processOne(item.fileId, item.file)
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          activeRef.current = Math.max(0, activeRef.current - 1)
          drainQueue()
        })
    }
  }

  const uploadFiles = useCallback(async (files: File[]): Promise<AssetData[]> => {
    const newSlots: MultiUploadSlot[] = files.map(f => {
      const fileId = crypto.randomUUID()
      const previewUrl = canPreview(f.type) ? URL.createObjectURL(f) : null
      if (previewUrl) previewUrlsRef.current.set(fileId, previewUrl)
      return {
        fileId,
        status: 'idle' as UploadStatus,
        progress: 0,
        loaded: 0,
        total: f.size,
        file: { name: f.name, size: f.size, type: f.type, previewUrl },
        asset: null,
        error: null,
      }
    })

    setSlots(prev => [...prev, ...newSlots])

    const promises = newSlots.map((slot, i) => {
      return new Promise<AssetData>((resolve, reject) => {
        queueRef.current.push({ fileId: slot.fileId, file: files[i]!, resolve, reject })
      })
    })

    drainQueue()

    const results = await Promise.allSettled(promises)
    const assets = results
      .filter((r): r is PromiseFulfilledResult<AssetData> => r.status === 'fulfilled')
      .map(r => r.value)

    if (assets.length === files.length) {
      onReady?.(assets)
    }

    return assets
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoints, attachmentMeta, maxConcurrent, onReady, onFileReady])

  const removeFile = useCallback((fileId: string) => {
    const xhr = xhrsRef.current.get(fileId)
    if (xhr) { xhr.abort(); xhrsRef.current.delete(fileId) }
    rejectQueued(fileId, 'Upload cancelled')
    const url = previewUrlsRef.current.get(fileId)
    if (url && !url.startsWith('http')) { URL.revokeObjectURL(url); previewUrlsRef.current.delete(fileId) }
    setSlots(prev => prev.filter(s => s.fileId !== fileId))
  }, [])

  const reorder = useCallback((orderedFileIds: string[]) => {
    setSlots(prev => {
      const byId = new Map(prev.map(s => [s.fileId, s]))
      const reordered: MultiUploadSlot[] = []
      for (const id of orderedFileIds) {
        const slot = byId.get(id)
        if (slot) reordered.push(slot)
      }
      // Append any slots not in the ordered list (shouldn't happen, but safe)
      for (const slot of prev) {
        if (!orderedFileIds.includes(slot.fileId)) reordered.push(slot)
      }
      return reordered
    })
  }, [])

  const resetAll = useCallback(() => {
    for (const xhr of xhrsRef.current.values()) xhr.abort()
    xhrsRef.current.clear()
    rejectAllQueued('Upload cancelled')
    for (const url of previewUrlsRef.current.values()) {
      if (!url.startsWith('http')) URL.revokeObjectURL(url)
    }
    previewUrlsRef.current.clear()
    activeRef.current = 0
    setSlots([])
  }, [])

  const isUploading = slots.some(s =>
    s.status !== 'idle' && s.status !== 'ready' && s.status !== 'error'
  )

  const readyAssets = slots
    .filter(s => s.status === 'ready' && s.asset)
    .map(s => s.asset!)

  const readyAssetIds = readyAssets.map(a => a.id)

  return {
    uploads: slots,
    uploadFiles,
    removeFile,
    reorder,
    reset: resetAll,
    isUploading,
    readyAssets,
    readyAssetIds,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mimeMatches(contentType: string, pattern: string): boolean {
  if (pattern === '*/*') return true
  if (pattern.endsWith('/*')) {
    return contentType.startsWith(pattern.slice(0, -1))
  }
  return contentType === pattern
}

function canPreview(type: string): boolean {
  return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
