/**
 * Generator tests — verifies the content of generated .d.ts files.
 *
 * Pattern:
 *   1. Build a project with specific model features
 *   2. project.run() → CodegenRunResult
 *   3. Assert specific strings are/aren't present in generated file content
 *   4. Snapshot the full output for regression protection
 *
 * Snapshots are stored alongside this file in __snapshots__/.
 * Update them with: bun test --update-snapshots
 */

import { describe, it, expect } from 'vitest'
import {
  createTestProject,
  expectNoErrors,
  modelBuilder,
  schemaBuilder,
  schemas,
} from '@/tests/helpers/index.js'

// ---------------------------------------------------------------------------
// Association types
// ---------------------------------------------------------------------------

describe('generator — association types', () => {
  it('generates Promise<T> return type for belongsTo', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('business').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').build(),
      },
    })

    const result = project.run()
    expectNoErrors(result)

    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''
    expect(genFile).toContain('business: Promise<BusinessRecord>')
  })

  it('generates nullable Promise for optional belongsTo', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().integer('creator_id'))
        .table('users', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('creator', 'users', { foreignKey: 'creatorId' })
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''
    expect(genFile).toContain('creator: Promise<UserRecord | null>')
  })

  it('generates Relation<T> for hasMany', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Business.model.ts': modelBuilder('Business', 'businesses').hasMany('assets').build(),
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('business').build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Business.model.gen.d.ts'] ?? ''
    expect(genFile).toContain('assets: Relation<AssetRecord, AssetAssociations>')
  })
})

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

describe('generator — enum types', () => {
  it('generates is<Value>() predicates for each enum value', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().smallint('asset_type'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .defineEnum('assetType', { jpg: 116, png: 125, gif: 111 })
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('isJpg(): boolean')
    expect(genFile).toContain('isPng(): boolean')
    expect(genFile).toContain('isGif(): boolean')
  })

  it('generates to<Value>() bang setters', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().smallint('asset_type'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .defineEnum('assetType', { jpg: 116, png: 125 })
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('toJpg(): AssetRecord')
    expect(genFile).toContain('toPng(): AssetRecord')
  })

  it('generates scope properties for enum groups', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().smallint('asset_type'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .defineEnum('assetType', { jpg: 116, mp4: 202 })
          .enumGroup('images', 'assetType', [100, 199])
          .enumGroup('videos', 'assetType', [200, 299])
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('images: Relation<AssetRecord, AssetAssociations>')
    expect(genFile).toContain('videos: Relation<AssetRecord, AssetAssociations>')
    expect(genFile).toContain('isImages(): boolean')
    expect(genFile).toContain('isVideos(): boolean')
  })

  it('generates the static enum object on the class', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().smallint('asset_type'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .defineEnum('assetType', { jpg: 116, png: 125 })
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('assetType: { jpg: 116; png: 125 }')
  })
})

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

describe('generator — dirty tracking types', () => {
  it('generates <field>Changed() for each column', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t
          .integer('id').primaryKey().notNull()
          .text('title')
          .integer('business_id').notNull()
        )
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('titleChanged(): boolean')
    expect(genFile).toContain('businessIdChanged(): boolean')
    expect(genFile).toContain('titleWas(): string | null')
    expect(genFile).toContain('titleChange(): [string | null, string | null] | null')
  })

  it('generates aggregate dirty tracking properties', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('title'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('isChanged(): boolean')
    expect(genFile).toContain('changedFields(): string[]')
    expect(genFile).toContain('changes: Record<string, [unknown, unknown]>')
    expect(genFile).toContain('previousChanges: Record<string, [unknown, unknown]>')
    expect(genFile).toContain('restoreAttributes(): void')
  })
})

// ---------------------------------------------------------------------------
// Scope types
// ---------------------------------------------------------------------------

describe('generator — scope types', () => {
  it('generates zero-arg scope as property on class', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().timestamp('created_at'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('recent', [], `return this.where("created_at > now() - interval '7 days'")`)
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('recent: Relation<AssetRecord, AssetAssociations>')
  })

  it('generates parameterized scope as method', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().timestamp('created_at'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('since', [{ name: 'date', type: 'Date' }], `return this.where("created_at > ?", date)`)
          .build(),
      },
    })

    const result = project.run()
    const genFile = result.files['Asset.model.gen.d.ts'] ?? ''

    expect(genFile).toContain('since(date: Date): Relation<AssetRecord, AssetAssociations>')
  })
})

// ---------------------------------------------------------------------------
// acceptsNestedAttributesFor
// ---------------------------------------------------------------------------

describe('generator — acceptsNestedAttributesFor', () => {
  const makeProject = () =>
    createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t
          .integer('id').primaryKey().notNull()
          .text('title')
        )
        .table('campaigns', t => t
          .integer('id').primaryKey().notNull()
          .integer('asset_id').notNull()
          .text('name').notNull()
        )
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .hasMany('campaigns', undefined, { acceptsNested: true })
          .build(),
        'Campaign.model.ts': modelBuilder('Campaign', 'campaigns').belongsTo('asset').build(),
      },
    })

  it('adds campaignsAttributes to AssetCreate when acceptsNested is true', () => {
    const gen = makeProject().run().files['Asset.model.gen.d.ts'] ?? ''
    expect(gen).toContain('campaignsAttributes?: CampaignCreate[]')
  })

  it('does NOT add attributes field for hasMany without acceptsNested', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .table('campaigns', t => t.integer('id').primaryKey().notNull().integer('asset_id').notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').hasMany('campaigns').build(),
        'Campaign.model.ts': modelBuilder('Campaign', 'campaigns').belongsTo('asset').build(),
      },
    })
    const gen = project.run().files['Asset.model.gen.d.ts'] ?? ''
    expect(gen).not.toContain('campaignsAttributes')
  })
})

// ---------------------------------------------------------------------------
// Snapshot tests — full output regression
// ---------------------------------------------------------------------------

describe('generator — snapshot tests', () => {
  it('Asset model gen matches snapshot', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t
          .integer('id').primaryKey().notNull()
          .smallint('asset_type')
          .text('title')
          .integer('business_id').notNull()
          .timestamp('created_at').notNull()
          .timestamp('updated_at').notNull()
        )
        .table('businesses', t => t.integer('id').primaryKey().notNull().text('name').notNull())
        .table('campaigns', t => t.integer('id').primaryKey().notNull().integer('asset_id').notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('business')
          .hasMany('campaigns')
          .defineEnum('assetType', { jpg: 116, png: 125, gif: 111, mp4: 202, mp3: 305 })
          .enumGroup('images', 'assetType', [100, 199])
          .enumGroup('videos', 'assetType', [200, 299])
          .scope('recent', [], `return this.where("created_at > now() - interval '7 days'")`)
          .scope('since', [{ name: 'date', type: 'Date' }], `return this.where("created_at > ?", date)`)
          .instanceMethod('assetFormat', "string | null", `
            if (this.isImages()) return 'image'
            if (this.isVideos()) return 'video'
            return null
          `)
          .build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').hasMany('assets').build(),
        'Campaign.model.ts': modelBuilder('Campaign', 'campaigns').belongsTo('asset').build(),
      },
    })

    const result = project.run()
    expectNoErrors(result)

    expect(result.files['Asset.model.gen.d.ts']).toMatchSnapshot()
    expect(result.files['Asset.model.gen.ts']).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Client runtime .gen.ts
// ---------------------------------------------------------------------------

describe('generator — Client runtime (.gen.ts)', () => {
  const makeProject = () =>
    createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t
          .integer('id').primaryKey().notNull()
          .text('title')
          .integer('business_id').notNull()
        )
        .table('businesses', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('business').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').build(),
      },
    })

  it('emits a .gen.ts file per model', () => {
    const result = makeProject().run()
    expect('Asset.model.gen.ts' in result.files).toBe(true)
    expect('Business.model.gen.ts' in result.files).toBe(true)
  })

  it('.gen.ts contains the Client class definition', () => {
    const gen = makeProject().run().files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain('class AssetClient')
    expect(gen).toContain('constructor(payload')
    expect(gen).toContain('isChanged()')
    expect(gen).toContain('restoreAttributes()')
    expect(gen).toContain('validate(')
    expect(gen).toContain('toJSON()')
  })

  it('.gen.ts attaches Client to the model constructor', () => {
    const gen = makeProject().run().files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain('(_Asset as any).Client = AssetClient')
  })

  it('.gen.ts imports associated model classes for rehydration', () => {
    const gen = makeProject().run().files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain(`import { Business as _Business }`)
  })

  it('.gen.ts rehydrates belongsTo associations with nested Client', () => {
    const gen = makeProject().run().files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain('payload.business ? new ((_Business as any).Client)')
  })
})

// ---------------------------------------------------------------------------
// Registry — side-effect .gen.ts imports
// ---------------------------------------------------------------------------

describe('generator — registry imports .gen.ts files', () => {
  it('registry includes side-effect imports for each model .gen.js', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .table('businesses', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').build(),
      },
    }).run()

    const registry = result.files['_registry.gen.ts'] ?? ''
    expect(registry).toContain(`import './Asset.model.gen.js'`)
    expect(registry).toContain(`import './Business.model.gen.js'`)
  })
})

// ---------------------------------------------------------------------------
// @computed scopes — emit Promise<unknown> type
// ---------------------------------------------------------------------------

describe('generator — @computed scope types', () => {
  it('emits Promise<unknown> return type for @computed scopes', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .computed('aggregateStats', [], 'return {}')
          .build(),
      },
    }).run()

    const dts = result.files['Asset.model.gen.d.ts'] ?? ''
    expect(dts).toContain('function aggregateStats(): Promise<unknown>')
  })

  it('@scope still emits Relation<> type', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('recent', [], 'return this.where({ active: true })')
          .build(),
      },
    }).run()

    const dts = result.files['Asset.model.gen.d.ts'] ?? ''
    expect(dts).toContain('const recent: Relation<')
  })
})

// ---------------------------------------------------------------------------
// Client — real method bodies + @validate inlining
// ---------------------------------------------------------------------------

describe('generator — Client method bodies and validation', () => {
  it('emits real method body when body is available', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('title'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .instanceMethod('displayTitle', 'string', 'return (this as any).title?.toUpperCase() ?? ""')
          .build(),
      },
    }).run()

    const gen = result.files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain('toUpperCase')
    expect(gen).not.toContain('throw new Error')
  })

  it('inlines @validate method body into Client.validate()', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('title'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .validateMethod('checkTitle', "if (!(this as any).title) return 'title is required'")
          .build(),
      },
    }).run()

    const gen = result.files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain('title is required')
    expect(gen).toContain('_result')
  })

  it('does not emit @server() methods in the Client class', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .serverMethod('sendEmail', 'Promise<void>', 'await EmailService.send(this)')
          .build(),
      },
    }).run()

    const gen = result.files['Asset.model.gen.ts'] ?? ''
    expect(gen).not.toContain('sendEmail')
  })
})

// ---------------------------------------------------------------------------
// Client — Attr.default in constructor
// ---------------------------------------------------------------------------

describe('generator — Client constructor Attr defaults', () => {
  it('uses Attr.new default value in Client constructor', () => {
    const result = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('status'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .attr('status', "Attr.new({ default: 'draft', get: (v: any) => v, set: (v: any) => v })")
          .build(),
      },
    }).run()

    const gen = result.files['Asset.model.gen.ts'] ?? ''
    expect(gen).toContain("'draft'")
  })
})

// ---------------------------------------------------------------------------
// columnToTsType — new column types (uuid, serial, decimal, real)
// ---------------------------------------------------------------------------

describe('generator — columnToTsType for expanded column types', () => {
  it('maps uuid column to string type', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('tokens', t => t.uuid('id').primaryKey().notNull())
        .build(),
      models: {
        'Token.model.ts': modelBuilder('Token', 'tokens').build(),
      },
    })
    const result = project.run()
    const genFile = result.files['Token.model.gen.d.ts'] ?? ''
    expect(genFile).toContain('id: string')
  })

  it('maps serial column to number type', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('items', t => t.serial('id').primaryKey().notNull())
        .build(),
      models: {
        'Item.model.ts': modelBuilder('Item', 'items').build(),
      },
    })
    const result = project.run()
    const genFile = result.files['Item.model.gen.d.ts'] ?? ''
    expect(genFile).toContain('id: number')
  })

  it('maps decimal/numeric column to string type (full-precision)', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('products', t =>
          t.integer('id').primaryKey().notNull().decimal('price')
        )
        .build(),
      models: {
        'Product.model.ts': modelBuilder('Product', 'products').build(),
      },
    })
    const result = project.run()
    const genFile = result.files['Product.model.gen.d.ts'] ?? ''
    // The column is nullable (no .notNull()), so the type includes '| null'
    expect(genFile).toContain('string | null')
  })
})

// ---------------------------------------------------------------------------
// columnToDefault — boolean / text / array hasDefault paths
// ---------------------------------------------------------------------------

describe('generator — columnToDefault for various column types with hasDefault', () => {
  it('emits false as default for a boolean column with hasDefault', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('posts', t => t
          .integer('id').primaryKey().notNull()
          .boolean('published').notNull().defaultVal('false')
        )
        .build(),
      models: {
        'Post.model.ts': modelBuilder('Post', 'posts').build(),
      },
    })
    const result = project.run()
    const gen = result.files['Post.model.gen.ts'] ?? ''
    expect(gen).toContain('false')
  })

  it("emits '' as default for a text column with hasDefault", () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('posts', t => t
          .integer('id').primaryKey().notNull()
          .text('body').notNull().defaultVal("''")
        )
        .build(),
      models: {
        'Post.model.ts': modelBuilder('Post', 'posts').build(),
      },
    })
    const result = project.run()
    const gen = result.files['Post.model.gen.ts'] ?? ''
    // Empty string default should be emitted
    expect(gen).toContain("''")
  })

  it('emits [] as default for a jsonb/array column with hasDefault', () => {
    // Use a Attr with explicit default for the array case since the schema
    // builder normalises array columns to jsonb
    const project = createTestProject({
      schema: schemaBuilder()
        .table('posts', t => t
          .integer('id').primaryKey().notNull()
          .jsonb('tags').notNull().defaultVal('[]')
        )
        .build(),
      models: {
        'Post.model.ts': modelBuilder('Post', 'posts')
          .attr('tags', "Attr.new({ default: [], get: (v: any) => v ?? [], set: (v: any) => v })")
          .build(),
      },
    })
    const result = project.run()
    const gen = result.files['Post.model.gen.ts'] ?? ''
    expect(gen).toContain('[]')
  })
})

// ---------------------------------------------------------------------------
// generateGlobals — placeholder output
// ---------------------------------------------------------------------------

describe('generator — generateGlobals', () => {
  it('is called as part of generate() and produces a placeholder comment', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('posts', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Post.model.ts': modelBuilder('Post', 'posts').build(),
      },
    })
    const result = project.run()
    // _globals.gen.d.ts is emitted by generateGlobals — it must exist
    const globals = result.files['_globals.gen.d.ts'] ?? ''
    expect(globals).toContain('placeholder')
  })
})
