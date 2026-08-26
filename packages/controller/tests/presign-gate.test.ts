/**
 * The presign route must gate Asset.create() success.
 *
 * Core contract: ApplicationRecord.create() ALWAYS returns the instance —
 * isNewRecord stays true (errors populated) when the INSERT failed. An
 * ungated presign therefore returns 200 with a phantom asset (no id) plus
 * a LIVE presigned upload URL: the client uploads the blob, confirm can
 * never find the row, and the S3 object is orphaned outside the pending-row
 * sweep. The gate is the same isNewRecord→toValidationError pattern
 * defaultCreate uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { call } from '@orpc/server'

const mocks = vi.hoisted(() => ({
  presignPut: vi.fn(async () => ({ url: 'https://s3.example.com/put?signed=1' })),
  create: vi.fn(),
}))

vi.mock('@active-drizzle/core', () => ({
  modelClassName: (m: any) =>
    typeof m === 'function' && typeof m.name === 'string' ? m.name : '',
  getAttachmentEntry: (model: string, name: string) =>
    model === 'Deal' && name === 'logo'
      ? { name: 'logo', kind: 'one', accepts: 'image/*', access: 'private' }
      : null,
  getStorage: () => ({
    generateKey: (filename: string) => `uploads/${filename}`,
    presignPut: mocks.presignPut,
    defaultMaxSize: 5 * 1024 * 1024,
  }),
  Asset: { create: mocks.create },
}))

import { buildRouter } from '../src/router.js'
import { ActiveController } from '../src/base.js'
import { controller, crud, attachable } from '../src/decorators.js'

function Deal() {}
;(Deal as any).all = () => ({})

@controller('/deals')
@attachable()
@crud(Deal as any, { update: { permit: ['name'] } })
class DealController extends ActiveController {}

const { router } = buildRouter(DealController as any)
const presignInput = { filename: 'logo.png', contentType: 'image/png', name: 'logo' }

describe('presign gates Asset.create success', () => {
  beforeEach(() => {
    mocks.presignPut.mockClear()
    mocks.create.mockReset()
  })

  it('a failed INSERT is a 422 with the asset errors — and NO upload URL is ever presigned', async () => {
    // The new create() contract: failed insert → instance returned,
    // isNewRecord true, errors populated (e.g. an @attachable autoSet
    // returning null into a NOT NULL column)
    mocks.create.mockResolvedValue({
      isNewRecord: true,
      errors: { uploadedById: ["can't be blank"] },
      toJSON: () => ({ id: undefined, status: 'pending' }),
    })

    await expect(call(router.presign, presignInput as any, { context: {} }))
      .rejects.toMatchObject({
        code: 'UNPROCESSABLE_ENTITY',
        status: 422,
        data: { errors: { uploadedById: ["can't be blank"] } },
      })
    expect(mocks.presignPut).not.toHaveBeenCalled()
  })

  it('a persisted asset presigns normally (the gate does not break the happy path)', async () => {
    mocks.create.mockResolvedValue({
      isNewRecord: false,
      errors: {},
      toJSON: () => ({ id: 42, status: 'pending' }),
    })

    const res: any = await call(router.presign, presignInput as any, { context: {} })
    expect(res.asset.id).toBe(42)
    expect(res.uploadUrl).toBe('https://s3.example.com/put?signed=1')
    expect(typeof res.uploadToken).toBe('string')
    expect(mocks.presignPut).toHaveBeenCalledTimes(1)
  })
})
