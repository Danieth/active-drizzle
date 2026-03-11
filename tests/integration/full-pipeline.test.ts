/**
 * Integration tests — runs the full codegen pipeline end-to-end.
 *
 * These tests exercise the whole path:
 *   schema + models → extract → validate → generate → assert output
 *
 * They're intentionally "real world" shaped — the kinds of model files
 * you'd actually find in a Rails-ported codebase.
 */

import { describe, it, expect } from 'vitest'
import {
  createTestProject,
  expectNoErrors,
  modelBuilder,
  schemaBuilder,
  schemas,
} from '@/tests/helpers/index.js'

describe('full pipeline — Asset model (the canonical example)', () => {
  const schema = schemaBuilder()
    .table('assets', t => t
      .integer('id').primaryKey().notNull()
      .smallint('asset_type').notNull()
      .text('title')
      .integer('business_id').notNull()
      .integer('creator_id')
      .timestamp('created_at').notNull()
      .timestamp('updated_at').notNull()
    )
    .table('businesses', t => t.integer('id').primaryKey().notNull().text('name').notNull())
    .table('users', t => t.integer('id').primaryKey().notNull())
    .table('campaigns', t => t.integer('id').primaryKey().notNull().integer('asset_id').notNull())
    .table('ads', t => t.integer('id').primaryKey().notNull().integer('asset_id').notNull())
    .build()

  const assetSrc = modelBuilder('Asset', 'assets')
    .belongsTo('business')
    .belongsTo('creator', 'users', { foreignKey: 'creatorId' })
    .hasMany('campaigns')
    .hasMany('ads')
    .defineEnum('assetType', { jpg: 116, png: 125, gif: 111, mp4: 202, mp3: 305 })
    .enumGroup('images', 'assetType', [100, 199])
    .enumGroup('videos', 'assetType', [200, 299])
    .enumGroup('audios', 'assetType', [300, 399])
    .scope('recent', [], `return this.where("created_at > now() - interval '7 days'")`)
    .scope('since', [{ name: 'date', type: 'Date' }], `return this.where("created_at > ?", date)`)
    .beforeSave('sanitize', 'this.title = this.title?.trim()')
    .instanceMethod('assetFormat', "string | null", `
      if (this.isImages()) return 'image'
      if (this.isVideos()) return 'video'
      if (this.isAudios()) return 'audio'
      return null
    `)
    .build()

  it('runs without errors', () => {
    const project = createTestProject({
      schema,
      models: {
        'Asset.model.ts': assetSrc,
        'Business.model.ts': modelBuilder('Business', 'businesses').hasMany('assets').build(),
        'Campaign.model.ts': modelBuilder('Campaign', 'campaigns').belongsTo('asset').build(),
      },
    })

    expectNoErrors(project.run())
  })

  it('generates a .gen.d.ts file for Asset', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const result = project.run()

    expect('Asset.model.gen.d.ts' in result.files).toBe(true)
  })

  it('generated file contains all 5 enum predicates', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('isJpg(): boolean')
    expect(gen).toContain('isPng(): boolean')
    expect(gen).toContain('isGif(): boolean')
    expect(gen).toContain('isMp4(): boolean')
    expect(gen).toContain('isMp3(): boolean')
  })

  it('generated file contains 3 group predicates', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('isImages(): boolean')
    expect(gen).toContain('isVideos(): boolean')
    expect(gen).toContain('isAudios(): boolean')
  })

  it('generated file contains both association types', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('business: Promise<BusinessRecord>')
    expect(gen).toContain('creator: Promise<UserRecord | null>')
    expect(gen).toContain('campaigns: Relation<CampaignRecord, CampaignAssociations>')
    expect(gen).toContain('ads: Relation<AdRecord, AdAssociations>')
  })

  it('generated file contains both scope types', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('recent: Relation<AssetRecord, AssetAssociations>')
    expect(gen).toContain('since(date: Date): Relation<AssetRecord, AssetAssociations>')
  })

  it('generated file contains dirty tracking for key columns', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('titleChanged(): boolean')
    expect(gen).toContain('businessIdChanged(): boolean')
    expect(gen).toContain('assetTypeChanged(): boolean')
  })

  it('generated file contains instance method', () => {
    const project = createTestProject({ schema, models: { 'Asset.model.ts': assetSrc } })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''

    expect(gen).toContain('assetFormat(): string | null')
  })
})

describe('full pipeline — STI (TextMessage hierarchy)', () => {
  const schema = schemas.textMessages

  it('generates inherited scopes on STI child', () => {
    const project = createTestProject({
      schema,
      models: {
        'TextMessage.model.ts': modelBuilder('TextMessage', 'text_messages')
          .defineEnum('type', { outboundTemplate: 1000, bulkSend: 0 })
          .scope('recent', [], `return this.where("created_at > now() - interval '7 days'")`)
          .build(),
        'OutboundTemplate.model.ts': modelBuilder('OutboundTemplate', 'text_messages', 'TextMessage')
          .build(),
      },
    })

    const result = project.run()
    const gen = result.files['OutboundTemplate.model.gen.d.ts'] ?? ''

    // Child should inherit parent scopes
    expect(gen).toContain('recent: Relation<OutboundTemplateRecord, OutboundTemplateAssociations>')
  })
})

describe('full pipeline — _registry.gen.ts', () => {
  it('generates a registry file', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('business').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').hasMany('assets').build(),
      },
    })

    const result = project.run()
    expect('_registry.gen.ts' in result.files).toBe(true)
  })

  it('registry imports all model classes', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').build(),
      },
    })

    const registry = project.run().files['_registry.gen.ts'] ?? ''

    expect(registry).toContain("import { Asset }")
    expect(registry).toContain("import { Business }")
  })
})
