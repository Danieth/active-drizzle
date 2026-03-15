/**
 * Controller extractor tests — @attachable detection.
 *
 * Uses ts-morph in-memory to test static analysis of @attachable
 * and hasOneAttachment/hasManyAttachments extraction.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractControllers } from '../../src/codegen/controller-extractor.js'

function makeProject(ctrlSource: string, modelSource?: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: false },
  })
  project.createSourceFile('/src/campaign.ctrl.ts', ctrlSource)
  if (modelSource) {
    project.createSourceFile('/src/Campaign.ts', modelSource)
  }
  return project
}

// ── @attachable detection ─────────────────────────────────────────────────────

describe('extractControllers — @attachable', () => {
  it('sets attachable: true when @attachable() is present', () => {
    const project = makeProject(`
      import { controller, crud, attachable } from '@active-drizzle/controller'
      class Campaign {}

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
    `)

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachable).toBe(true)
  })

  it('does not set attachable when @attachable() is absent', () => {
    const project = makeProject(`
      import { controller, crud } from '@active-drizzle/controller'
      class Campaign {}

      @controller()
      @crud(Campaign)
      class CampaignController {}
    `)

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachable).toBeUndefined()
  })

  it('does not set attachable when controller is just plain', () => {
    const project = makeProject(`
      import { controller } from '@active-drizzle/controller'

      @controller()
      class UtilController {}
    `)

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachable).toBeUndefined()
  })
})

// ── Attachment extraction from model ──────────────────────────────────────────

describe('extractControllers — attachment metadata from model', () => {
  it('extracts hasOneAttachment from the model class', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      import { hasOneAttachment } from '@active-drizzle/core'
      export class Campaign {
        static logo = hasOneAttachment('logo', { accepts: 'image/*', maxSize: 5242880, access: 'public' })
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachments).toBeDefined()
    expect(ctrl.attachments).toHaveLength(1)

    const logo = ctrl.attachments![0]!
    expect(logo.name).toBe('logo')
    expect(logo.kind).toBe('one')
    expect(logo.accepts).toBe('image/*')
    expect(logo.maxSize).toBe(5242880)
    expect(logo.access).toBe('public')
  })

  it('extracts hasManyAttachments from the model class', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      import { hasManyAttachments } from '@active-drizzle/core'
      export class Campaign {
        static documents = hasManyAttachments('documents', { max: 10, access: 'private' })
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    const docs = ctrl.attachments?.find(a => a.name === 'documents')
    expect(docs).toBeDefined()
    expect(docs!.kind).toBe('many')
    expect(docs!.max).toBe(10)
    expect(docs!.access).toBe('private')
  })

  it('uses marker argument name (not static property key)', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      import { hasOneAttachment } from '@active-drizzle/core'
      export class Campaign {
        static heroImageField = hasOneAttachment('heroImage')
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    const att = ctrl.attachments?.[0]
    expect(att?.name).toBe('heroImage')
  })

  it('parses maxSize expressions with numeric separators', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      import { hasOneAttachment } from '@active-drizzle/core'
      export class Campaign {
        static logo = hasOneAttachment('logo', { maxSize: 5_000_000 })
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    const logo = ctrl.attachments?.find(a => a.name === 'logo')
    expect(logo?.maxSize).toBe(5000000)
  })

  it('extracts multiple attachments', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      import { hasOneAttachment, hasManyAttachments } from '@active-drizzle/core'
      export class Campaign {
        static logo = hasOneAttachment('logo', { accepts: 'image/*', access: 'public' })
        static heroImage = hasOneAttachment('heroImage', { access: 'public' })
        static documents = hasManyAttachments('documents', { max: 10 })
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachments).toHaveLength(3)
    const names = ctrl.attachments!.map(a => a.name)
    expect(names).toContain('logo')
    expect(names).toContain('heroImage')
    expect(names).toContain('documents')
  })

  it('returns empty attachments array when model has none', () => {
    const project = makeProject(
      `
      import { controller, crud, attachable } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      @attachable()
      class CampaignController {}
      `,
      `
      export class Campaign {
        static name = 'Campaign'
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    // attachments may be undefined or empty — both are acceptable
    expect(ctrl.attachments ?? []).toHaveLength(0)
  })

  it('does not set attachments when @attachable is absent', () => {
    const project = makeProject(
      `
      import { controller, crud } from '@active-drizzle/controller'
      import { Campaign } from './Campaign'

      @controller()
      @crud(Campaign)
      class CampaignController {}
      `,
      `
      import { hasOneAttachment } from '@active-drizzle/core'
      export class Campaign {
        static logo = hasOneAttachment('logo')
      }
      `,
    )

    const meta = extractControllers(project, ['/src/campaign.ctrl.ts'])
    const ctrl = meta.controllers[0]!
    expect(ctrl.attachments).toBeUndefined()
  })
})
