/**
 * The asset-ownership guard — the presign→confirm→attach IDOR is closed.
 *
 * Threat model: attacker A (tenant 1) knows/guesses asset ids belonging to
 * victim V (tenant 2). Every path that accepts a client-supplied asset id
 * must refuse foreign ids with a NON-ORACLE NotFound:
 *   - confirm  (was: global Asset.find — could read AND destroy V's uploads)
 *   - attach   (was: raw id into record.attach — steal V's private files)
 *   - form PATCH `logoAssetId` (was: _autoAttach with zero checks — same)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertAssetTouchable, generateUploadToken } from '../src/attach-guard.js'
import { NotFound } from '../src/errors.js'

const TOKEN = generateUploadToken()

function makeAsset(over: Record<string, any> = {}): any {
  return {
    id: 9,
    status: 'ready',
    metadata: {
      attachmentName: 'logo',
      model: 'Deal',
      scope: { organizationId: 1 },
      uploadToken: TOKEN,
      ...over.metadata,
    },
    ...over,
  }
}

describe('assertAssetTouchable — the ownership stamp', () => {
  it('happy path: same model, matching scope, correct token', () => {
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', uploadToken: TOKEN,
      anchor: (k) => ({ organizationId: 1 } as any)[k],
    })).not.toThrow()
  })

  it('CROSS-TENANT: a scope mismatch is NotFound (never an oracle)', () => {
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', uploadToken: TOKEN,
      anchor: (k) => ({ organizationId: 2 } as any)[k],   // attacker's tenant
    })).toThrow(NotFound)
  })

  it('CROSS-DOOR: an asset presigned for another model family is NotFound', () => {
    expect(() => assertAssetTouchable(makeAsset({ metadata: { model: 'Invoice', scope: {}, uploadToken: TOKEN } }), {
      model: 'Deal', uploadToken: TOKEN, anchor: () => 1,
    })).toThrow(NotFound)
  })

  it('WRONG/MISSING token is NotFound; unstamped assets are NEVER client-attachable', () => {
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', uploadToken: 'stolen-guess',
      anchor: (k) => ({ organizationId: 1 } as any)[k],
    })).toThrow(NotFound)
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal',                                       // token absent entirely
      anchor: (k) => ({ organizationId: 1 } as any)[k],
    })).toThrow(NotFound)
    // an asset created server-side (no stamp at all) can't be claimed by id
    expect(() => assertAssetTouchable({ id: 1, status: 'ready', metadata: {} }, {
      model: 'Deal', uploadToken: TOKEN, anchor: () => 1,
    })).toThrow(NotFound)
  })

  it('record-anchored paths skip the token but NEVER the scope', () => {
    const record = { id: 5, organizationId: 1 }
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', skipToken: true, anchor: (k) => (record as any)[k],
    })).not.toThrow()
    const foreignRecord = { id: 5, organizationId: 2 }
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', skipToken: true, anchor: (k) => (foreignRecord as any)[k],
    })).toThrow(NotFound)
  })

  it('an anchor that cannot resolve a stamped key FAILS CLOSED', () => {
    expect(() => assertAssetTouchable(makeAsset(), {
      model: 'Deal', uploadToken: TOKEN, anchor: () => undefined,
    })).toThrow(NotFound)
  })

  it('requireReady refuses pending assets on attach paths', () => {
    expect(() => assertAssetTouchable(makeAsset({ status: 'pending' }), {
      model: 'Deal', uploadToken: TOKEN, requireReady: true,
      anchor: (k) => ({ organizationId: 1 } as any)[k],
    })).toThrow(NotFound)
  })

  it('scope-less doors (no @scope, no scopeBy) still verify model + token', () => {
    const a = makeAsset({ metadata: { model: 'Deal', scope: {}, uploadToken: TOKEN } })
    expect(() => assertAssetTouchable(a, { model: 'Deal', uploadToken: TOKEN, anchor: () => undefined }))
      .not.toThrow()
    expect(() => assertAssetTouchable(a, { model: 'Deal', uploadToken: 'wrong', anchor: () => undefined }))
      .toThrow(NotFound)
  })

  it('tokens are high-entropy and unique', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateUploadToken()))
    expect(seen.size).toBe(50)
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(32)
  })
})

// ── The FORM path (defaultUpdate → _autoAttach) end to end ───────────────────

const assets = new Map<number, any>()
vi.mock('@active-drizzle/core', () => ({
  Asset: {
    where: ({ id }: { id: number }) => ({ first: async () => assets.get(id) ?? null }),
  },
  getAttachments: (model: string) =>
    model === 'Deal' ? [{ name: 'logo', kind: 'one' }] : [],
}))

import { defaultUpdate } from '../src/crud-handlers.js'

describe('form PATCH logoAssetId — the third IDOR path, closed', () => {
  beforeEach(() => assets.clear())

  const makeRecord = () => ({
    id: 5, organizationId: 1, logoAssetId: null,
    save: vi.fn().mockResolvedValue(true), errors: {},
    replace: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(undefined),
  })
  const config: any = { update: { permit: ['name', 'logo', 'logoAssetId'] } }
  const model: any = { name: 'Deal' }

  it("REFUSES another tenant's asset id (scope stamp ≠ record's own columns)", async () => {
    assets.set(77, {
      id: 77, status: 'ready',
      metadata: { model: 'Deal', scope: { organizationId: 2 }, uploadToken: 'x' },
    })
    const record = makeRecord()
    const relation: any = { where: () => ({ first: async () => record }) }
    await expect(
      defaultUpdate(relation, model, config, 5, { logoAssetId: 77 }, {}, { state: {} }),
    ).rejects.toThrow(NotFound)
    expect(record.replace).not.toHaveBeenCalled()
  })

  it('honors a same-tenant, ready, same-model asset', async () => {
    assets.set(88, {
      id: 88, status: 'ready',
      metadata: { model: 'Deal', scope: { organizationId: 1 }, uploadToken: 'x' },
    })
    const record = makeRecord()
    const relation: any = { where: () => ({ first: async () => record }) }
    await defaultUpdate(relation, model, config, 5, { logoAssetId: 88 }, {}, { state: {} })
    expect(record.replace).toHaveBeenCalledWith('logo', 88)
  })

  it('refuses a PENDING asset and a NONEXISTENT id alike (no oracle)', async () => {
    assets.set(99, {
      id: 99, status: 'pending',
      metadata: { model: 'Deal', scope: { organizationId: 1 }, uploadToken: 'x' },
    })
    for (const id of [99, 424242]) {
      const record = makeRecord()
      const relation: any = { where: () => ({ first: async () => record }) }
      await expect(
        defaultUpdate(relation, model, config, 5, { logoAssetId: id }, {}, { state: {} }),
      ).rejects.toThrow(NotFound)
    }
  })
})

// ── Bulk mutation rules + singleton pipeline (same review, same commit) ──────

import { sanitizeMutationPayload, buildGovernedWriteData } from '../src/crud-handlers.js'
import { ValidationError } from '../src/errors.js'

describe('bulk mutations honor the SAME rules as non-bulk', () => {
  it('sanitizeMutationPayload: params allowlist + required, record-free', () => {
    const mut: any = { method: 'sendBack', params: ['reason'], required: ['reason'] }
    expect(sanitizeMutationPayload(mut, { reason: 'nope', evil: 'x' }))
      .toEqual({ reason: 'nope' })                       // allowlist strips
    expect(() => sanitizeMutationPayload(mut, { reason: '  ' }))
      .toThrow(ValidationError)                          // required enforced
  })
})

describe('singleton update runs the GOVERNED pipeline', () => {
  it('record-aware permit + nested sanitize flow through buildGovernedWriteData', async () => {
    const permitFn = vi.fn((_ctx: any, _ctrl: any, record: any) =>
      record?.locked ? [] : ['theme'])
    const config: any = { permit: permitFn }
    const record = { id: 1, locked: false }
    const out = await buildGovernedWriteData(
      { theme: 'dark', role: 'admin' }, config, { userId: 1 }, { name: 'Settings' }, { state: {} }, record,
    )
    expect(out).toEqual({ theme: 'dark' })               // permit filtered
    expect(permitFn).toHaveBeenCalledWith({ userId: 1 }, { state: {} }, record)  // record-AWARE

    const locked = await buildGovernedWriteData(
      { theme: 'dark' }, config, { userId: 1 }, { name: 'Settings' }, { state: {} }, { id: 1, locked: true },
    )
    expect(locked).toEqual({})                           // record state closes the door
  })
})
