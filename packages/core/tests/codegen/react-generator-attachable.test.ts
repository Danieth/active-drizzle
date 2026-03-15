/**
 * React generator tests — @attachable output.
 *
 * Verifies that when a controller has ctrl.attachable = true:
 *  - The attachment metadata constant is emitted
 *  - useUpload / useMultiUpload appear in .use()
 *  - presign / confirm / attach appear in .with()
 *  - Write type includes ${name}AssetId / ${name}AssetIds fields
 *  - useMutation is imported
 */
import { describe, it, expect } from 'vitest'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta, CtrlAttachmentMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

function makeCtrl(overrides: Partial<CtrlMeta> = {}): CtrlMeta {
  return {
    filePath: '/src/campaign.ctrl.ts',
    className: 'CampaignController',
    basePath: '/campaigns',
    scopes: [],
    kind: 'crud',
    modelClass: 'Campaign',
    mutations: [],
    actions: [],
    crudConfig: {
      create: { permit: ['name', 'logo', 'documents'] },
    },
    ...overrides,
  }
}

/** Minimal projectMeta with a Campaign model and a few columns. */
function makeProjectMeta(): ProjectMeta {
  return {
    schema: {
      filePath: '/schema.ts',
      tables: {
        campaigns: {
          name: 'campaigns',
          columns: [
            { name: 'id', dbName: 'id', type: 'serial', nullable: false, hasDefault: true, primaryKey: true, isArray: false, isGenerated: false, pgEnumValues: null },
            { name: 'name', dbName: 'name', type: 'varchar', nullable: false, hasDefault: false, primaryKey: false, isArray: false, isGenerated: false, pgEnumValues: null },
            { name: 'budget', dbName: 'budget', type: 'integer', nullable: true, hasDefault: false, primaryKey: false, isArray: false, isGenerated: false, pgEnumValues: null },
          ],
        },
      },
    },
    models: [
      {
        fileName: 'Campaign.model.ts',
        className: 'Campaign',
        tableName: 'campaigns',
        associations: [],
        enums: [],
        scopes: [],
        propertyDefaults: {},
        validates: [],
      },
    ],
  } as unknown as ProjectMeta
}

const logoAttachment: CtrlAttachmentMeta = {
  name: 'logo',
  kind: 'one',
  accepts: 'image/*',
  maxSize: 5242880,
  access: 'public',
}

const docsAttachment: CtrlAttachmentMeta = {
  name: 'documents',
  kind: 'many',
  max: 10,
  access: 'private',
}

function generate(ctrl: CtrlMeta, withModel = false): string {
  const project: CtrlProjectMeta = { controllers: [ctrl] }
  const meta = withModel ? makeProjectMeta() : null
  const files = generateReactHooks(project, meta, '/output')
  const gen = files.find(f => f.filePath.includes('campaign.gen.ts'))
  return gen?.content ?? ''
}

// ── Attachment metadata constant ──────────────────────────────────────────────

describe('generateReactHooks — attachment metadata constant', () => {
  it('emits ${model}Attachments constant when attachable', () => {
    const ctrl = makeCtrl({
      attachable: true,
      attachments: [logoAttachment],
    })
    const out = generate(ctrl)
    expect(out).toContain('campaignAttachments')
    expect(out).toContain('as const')
  })

  it('includes logo attachment with correct properties', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [logoAttachment] })
    const out = generate(ctrl)
    expect(out).toContain("logo:")
    expect(out).toContain("kind: 'one'")
    expect(out).toContain("accepts: 'image/*'")
    expect(out).toContain("maxSize: 5242880")
    expect(out).toContain("access: 'public'")
  })

  it('includes hasManyAttachments with max', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [docsAttachment] })
    const out = generate(ctrl)
    expect(out).toContain("documents:")
    expect(out).toContain("kind: 'many'")
    expect(out).toContain("max: 10")
    expect(out).toContain("access: 'private'")
  })

  it('does not emit constant when not attachable', () => {
    const ctrl = makeCtrl({ attachable: undefined, attachments: undefined })
    const out = generate(ctrl)
    expect(out).not.toContain('campaignAttachments')
  })

  it('emits empty attachment constant for attachable controllers without extracted attachments', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: undefined })
    const out = generate(ctrl)
    expect(out).toContain('export const campaignAttachments = {')
  })
})

// ── .use() attachment hooks ───────────────────────────────────────────────────

describe('generateReactHooks — .use() upload hooks', () => {
  it('emits useUpload hook in .use()', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [logoAttachment] })
    const out = generate(ctrl)
    expect(out).toContain('useUpload:')
    expect(out).toContain('useUploadFactory(')
  })

  it('emits useMultiUpload hook in .use()', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [docsAttachment] })
    const out = generate(ctrl)
    expect(out).toContain('useMultiUpload:')
    expect(out).toContain('useMultiUploadFactory(')
  })

  it('emits mutatePresign, mutateConfirm, mutateAttach in .use()', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [logoAttachment] })
    const out = generate(ctrl)
    expect(out).toContain('mutatePresign:')
    expect(out).toContain('mutateConfirm:')
    expect(out).toContain('mutateAttach:')
  })

  it('hooks are not emitted when not attachable', () => {
    const ctrl = makeCtrl({ attachable: undefined })
    const out = generate(ctrl)
    expect(out).not.toContain('useUpload:')
    expect(out).not.toContain('mutatePresign:')
  })
})

// ── .with() attachment callers ────────────────────────────────────────────────

describe('generateReactHooks — .with() attachment callers', () => {
  it('emits presign, confirm, attach in .with()', () => {
    const ctrl = makeCtrl({ attachable: true, attachments: [logoAttachment] })
    const out = generate(ctrl)
    expect(out).toContain('presign:')
    expect(out).toContain('confirm:')
    expect(out).toContain('attach:')
  })
})

// ── useMutation import ────────────────────────────────────────────────────────

describe('generateReactHooks — useMutation import for attachable-only', () => {
  it('imports useMutation when attachable is present (even without CRUD mutations)', () => {
    const ctrl: CtrlMeta = {
      filePath: '/src/upload.ctrl.ts',
      className: 'UploadController',
      basePath: '/uploads',
      scopes: [],
      kind: 'plain',
      mutations: [],
      actions: [],
      attachable: true,
      attachments: [logoAttachment],
    }
    const project: CtrlProjectMeta = { controllers: [ctrl] }
    const files = generateReactHooks(project, null, '/output')
    const gen = files.find(f => f.filePath.includes('upload.gen.ts'))
    expect(gen?.content).toContain('useMutation')
  })
})

// ── Write type expansion ──────────────────────────────────────────────────────

describe('generateReactHooks — Write type with attachment fields', () => {
  it('adds logoAssetId to Write type when logo is in permit list', () => {
    const ctrl = makeCtrl({
      attachable: true,
      attachments: [logoAttachment],
      crudConfig: { create: { permit: ['name', 'logo'] } },
    })
    const out = generate(ctrl, true)
    expect(out).toContain('logoAssetId')
    expect(out).toContain('logoAssetId?: number | null')
  })

  it('adds documentsAssetIds to Write type for hasManyAttachments', () => {
    const ctrl = makeCtrl({
      attachable: true,
      attachments: [docsAttachment],
      crudConfig: { create: { permit: ['name', 'documents'] } },
    })
    const out = generate(ctrl, true)
    expect(out).toContain('documentsAssetIds')
  })

  it('does not add asset ID fields when attachment not in permit list', () => {
    const ctrl = makeCtrl({
      attachable: true,
      attachments: [logoAttachment],
      crudConfig: { create: { permit: ['name'] } },  // logo not permitted
    })
    const out = generate(ctrl, true)
    expect(out).not.toContain('logoAssetId')
  })

  it('keeps regular fields separate from attachment fields', () => {
    const ctrl = makeCtrl({
      attachable: true,
      attachments: [logoAttachment],
      crudConfig: { create: { permit: ['name', 'budget', 'logo'] } },
    })
    const out = generate(ctrl, true)
    // Regular fields via Pick, attachment field via intersection
    expect(out).toContain("'name'")
    expect(out).toContain("'budget'")
    expect(out).toContain('logoAssetId')
  })
})
