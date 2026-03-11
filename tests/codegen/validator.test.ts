/**
 * Validator tests — the "catches errors at build time" feature.
 *
 * Each test follows the same pattern:
 *   1. Set up a schema + model that has a specific mistake
 *   2. project.validate() — returns Diagnostic[]
 *   3. Assert the right error / warning is present
 *
 * The validator is a pure function (ProjectMeta → Diagnostic[]) so these
 * tests require zero async, no file I/O, no mocking.
 */

import { describe, it, expect } from 'vitest'
import {
  createTestProject,
  expectErrors,
  expectNoErrors,
  expectWarnings,
  modelBuilder,
  schemaBuilder,
  schemas,
} from '@/tests/helpers/index.js'

// ---------------------------------------------------------------------------
// Happy paths — no errors on well-formed models
// ---------------------------------------------------------------------------

describe('validator — no errors on valid models', () => {
  it('passes a simple belongsTo with matching table', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('business').build(),
        'Business.model.ts': modelBuilder('Business', 'businesses').hasMany('assets').build(),
      },
    })

    expectNoErrors(project.run())
  })

  it('passes explicit-table belongsTo', () => {
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

    expectNoErrors(project.run())
  })
})

// ---------------------------------------------------------------------------
// Association errors
// ---------------------------------------------------------------------------

describe('validator — association errors', () => {
  it('errors when belongsTo table does not exist in schema', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').belongsTo('foo').build(),
      },
    })

    const result = project.run()
    expectErrors(result, 'table "foos" not found')
  })

  it('includes available tables in the error message', () => {
    // "businesz" is one character off from "businesses" — Levenshtein will catch it
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('businesz', 'businesz', { foreignKey: 'businessId' })
          .build(),
      },
    })

    const result = project.run()
    // Should suggest the closest match
    expectErrors(result, /did you mean.*businesses/i)
  })

  it('errors when hasMany FK column is missing from target table', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        // campaigns table exists but has no asset_id FK
        .table('campaigns', t => t.integer('id').primaryKey().notNull().text('name'))
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets').hasMany('campaigns').build(),
      },
    })

    const result = project.run()
    expectErrors(result, 'column "assetId" not found on table "campaigns"')
  })

  it('warns on missing bidirectional association when target model not found in registry', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        // Asset hasMany businesses, but there's no Business model loaded
        'Asset.model.ts': modelBuilder('Asset', 'assets').hasMany('businesses').build(),
      },
    })

    const result = project.run()
    expectWarnings(result, /bidirectional/i)
  })

  it('warns on missing inverse belongsTo when target MODEL exists but has no inverse', () => {
    // Covers validator.ts lines 112-116: targetModel found but hasInverse = false
    const testSchema = schemaBuilder()
      .table('assets', t => t.integer('id').primaryKey().notNull())
      .table('businesses', t => t.integer('id').primaryKey().notNull().integer('asset_id'))
      .build()

    const project = createTestProject({
      schema: testSchema,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .hasMany('businesses')
          .build(),
        // Business model exists but does NOT have a belongsTo('asset') inverse
        'Business.model.ts': modelBuilder('Business', 'businesses').build(),
      },
    })

    const result = project.run()
    expectWarnings(result, /bidirectional/i)
  })

  it('warns when belongsTo FK column is missing from owner table', () => {
    // Covers validator.ts lines 64-68: belongsTo FK absent from owner's own table
    const testSchema = schemaBuilder()
      .table('assets', t => t.integer('id').primaryKey().notNull())
      // assets table does NOT have a business_id column
      .table('businesses', t => t.integer('id').primaryKey().notNull())
      .build()

    const project = createTestProject({
      schema: testSchema,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('business', 'businesses')  // no explicit foreignKey option
          .build(),
      },
    })

    const result = project.run()
    // Should warn that the FK column is missing
    const fkWarnings = result.warnings.filter(w => /businessId/i.test(w.message))
    expect(fkWarnings.length).toBeGreaterThan(0)
  })

  it('does NOT warn when bidirectional inverse correctly points back', () => {
    const schema = schemaBuilder()
      .table('assets', t => t.integer('id').primaryKey().notNull())
      .table('campaigns', t => t.integer('id').primaryKey().notNull().integer('asset_id'))
      .build()

    const project = createTestProject({
      schema,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .hasMany('campaigns')
          .build(),
        'Campaign.model.ts': modelBuilder('Campaign', 'campaigns')
          .belongsTo('asset', 'assets')
          .build(),
      },
    })

    const result = project.run()
    const bidirectionalWarnings = result.warnings.filter(w => /bidirectional/i.test(w.message))
    expect(bidirectionalWarnings).toHaveLength(0)
  })

  it('errors when hasMany :through table does not exist', () => {
    const schema = schemaBuilder()
      .table('assets', t => t.integer('id').primaryKey().notNull())
      .table('campaigns', t => t.integer('id').primaryKey().notNull())
      .build()

    const project = createTestProject({
      schema,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .hasMany('campaigns', 'campaigns', { through: 'nonexistent_join_table' })
          .build(),
      },
    })

    const result = project.run()
    expectErrors(result, /through table.*nonexistent_join_table.*not found/i)
  })

  it('passes hasMany :through when the join table exists', () => {
    const schema = schemaBuilder()
      .table('assets', t => t.integer('id').primaryKey().notNull())
      .table('campaigns', t => t.integer('id').primaryKey().notNull())
      .table('asset_campaigns', t => t.integer('id').primaryKey().notNull())
      .build()

    const project = createTestProject({
      schema,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .hasMany('campaigns', 'campaigns', { through: 'asset_campaigns' })
          .build(),
      },
    })

    const result = project.run()
    const throughErrors = result.errors.filter(e => /through table/i.test(e.message))
    expect(throughErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Enum errors
// ---------------------------------------------------------------------------

describe('validator — enum errors', () => {
  it('errors when defineEnum is on a non-integer column', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t
          .integer('id').primaryKey().notNull()
          .text('asset_type')   // TEXT, not smallint/integer
        )
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .defineEnum('assetType', { jpg: 116, png: 125 })
          .build(),
      },
    })

    const result = project.run()
    expectErrors(result, /expects INTEGER or SMALLINT/i)
  })
})

// ---------------------------------------------------------------------------
// STI errors
// ---------------------------------------------------------------------------

describe('validator — STI errors', () => {
  it('errors when STI child model has no type column on parent', () => {
    const project = createTestProject({
      // text_messages table has no 'type' column
      schema: schemaBuilder()
        .table('text_messages', t => t.integer('id').primaryKey().notNull().text('content'))
        .build(),
      models: {
        'TextMessage.model.ts': modelBuilder('TextMessage', 'text_messages').build(),
        'OutboundTemplate.model.ts': modelBuilder('OutboundTemplate', 'text_messages', 'TextMessage').build(),
      },
    })

    const result = project.run()
    expectErrors(result, /STI.*no.*type.*column/i)
  })

  it('warns when STI model has no default scope', () => {
    const project = createTestProject({
      schema: schemas.textMessages,
      models: {
        'TextMessage.model.ts': modelBuilder('TextMessage', 'text_messages')
          .defineEnum('type', { outboundTemplate: 1000, bulkSend: 0 })
          .build(),
        'OutboundTemplate.model.ts': modelBuilder('OutboundTemplate', 'text_messages', 'TextMessage').build(),
      },
    })

    const result = project.run()
    expectWarnings(result, /STI.*stiType/i)
  })
})

// ---------------------------------------------------------------------------
// Hook errors
// ---------------------------------------------------------------------------

describe('validator — hook errors', () => {
  it('errors when conditional hook references a non-existent column', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .beforeSave('doThing', 'this.compute()', { condition: 'nonExistentFieldChanged' })
          .build(),
      },
    })

    const result = project.run()
    expectErrors(result, 'nonExistentField')
  })
})

// ---------------------------------------------------------------------------
// Scope body this.X reference checking
// ---------------------------------------------------------------------------

describe('validator — scope body this.X column reference checking', () => {
  it('warns when a scope references a non-existent property via this.X', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('recentOnes', [], 'return this.where({ id: this.nonExistentCol })')
          .build(),
      },
    })

    const result = project.run()
    // Should warn about 'nonExistentCol' not being found
    expectWarnings(result, /nonExistentCol/)
  })

  it('does not warn when a scope references a valid column via this.X', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('recent', [], 'return this.where({ businessId: 1 })')
          .build(),
      },
    })

    const result = project.run()
    expectNoErrors(result)
  })

  it('does not warn about well-known Relation methods like this.where, this.order', () => {
    const project = createTestProject({
      schema: schemas.assetsAndBusinesses,
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .scope('sorted', [], 'return this.order("id", "desc").where({ id: 1 })')
          .build(),
      },
    })

    const result = project.run()
    expectNoErrors(result)
  })
})

// ---------------------------------------------------------------------------
// Attr.set return type vs column type mismatch
// ---------------------------------------------------------------------------

describe('validator — Attr.set return type vs column type', () => {
  it('errors when Attr.set appears to return a string but column is integer', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().integer('score'))
        .build(),
      models: {
        'Asset.model.ts': `
import { ApplicationRecord } from 'active-drizzle/runtime'
import { Attr } from 'active-drizzle/runtime'
export class Asset extends ApplicationRecord {
  static _activeDrizzleTableName = 'assets'
  static score = Attr.new({ set: (v: any) => String(v).toLowerCase() })
}
`,
      },
    })

    const result = project.run()
    expectErrors(result, /score.*string.*integer|Attr\.set.*string.*integer/i)
  })

  it('does not error when Attr.set returns a number for an integer column', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().integer('score'))
        .build(),
      models: {
        'Asset.model.ts': `
import { ApplicationRecord } from 'active-drizzle/runtime'
import { Attr } from 'active-drizzle/runtime'
export class Asset extends ApplicationRecord {
  static _activeDrizzleTableName = 'assets'
  static score = Attr.new({ set: (v: any) => Math.round(Number(v)) })
}
`,
      },
    })

    const result = project.run()
    expectNoErrors(result)
  })
})

// ---------------------------------------------------------------------------
// findClose — Levenshtein-based suggestion quality
// ---------------------------------------------------------------------------

describe('validator — association suggestion quality (Levenshtein)', () => {
  it('suggests the correct table for a one-character typo (asstes → assets)', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Business.model.ts': modelBuilder('Business', 'businesses')
          .hasMany('asstes')
          .build(),
      },
    })
    const result = project.run()
    // hasMany('asstes') → table "asstes", closest is "assets"
    expectErrors(result, /did you mean.*"assets"/i)
  })

  it('suggests the correct table for a two-character typo (businesess → businesses)', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('businesses', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('businesess', 'businesess', { foreignKey: 'businessId' })
          .build(),
      },
    })
    const result = project.run()
    expectErrors(result, /did you mean.*"businesses"/i)
  })

  it('does NOT suggest a completely unrelated table name', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull())
        .table('businesses', t => t.integer('id').primaryKey().notNull())
        .build(),
      models: {
        'Asset.model.ts': modelBuilder('Asset', 'assets')
          .belongsTo('xyz', 'xyz', { foreignKey: 'xyzId' })
          .build(),
      },
    })
    const result = project.run()
    // "xyz" is too far from "assets" or "businesses" — no suggestion should be emitted
    const xyzError = result.errors.find(e => e.message.includes('"xyz"'))
    expect(xyzError).toBeDefined()
    expect(xyzError!.message).not.toContain('Did you mean')
  })
})

// ---------------------------------------------------------------------------
// validateHooks — condition field not in schema (line 150: non-Changed condition)
// ---------------------------------------------------------------------------

describe('validator — hook condition field validation', () => {
  it('errors when hook condition references a field not in the schema (plain field, not *Changed)', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('title'))
        .build(),
      models: {
        'Asset.model.ts': `
import { ApplicationRecord } from 'active-drizzle/runtime'
import { beforeSave } from 'active-drizzle/runtime'
export class Asset extends ApplicationRecord {
  static _activeDrizzleTableName = 'assets'

  @beforeSave({ if: 'nonExistentField' })
  doSomething() {}
}
`,
      },
    })

    const result = project.run()
    // Hook condition 'nonExistentField' is not a column — should produce an error
    expectErrors(result, /nonExistentField/)
  })

  it('does not error when hook condition ends with Changed (valid *Changed accessor)', () => {
    const project = createTestProject({
      schema: schemaBuilder()
        .table('assets', t => t.integer('id').primaryKey().notNull().text('title'))
        .build(),
      models: {
        'Asset.model.ts': `
import { ApplicationRecord } from 'active-drizzle/runtime'
import { beforeSave } from 'active-drizzle/runtime'
export class Asset extends ApplicationRecord {
  static _activeDrizzleTableName = 'assets'

  @beforeSave({ if: 'titleChanged' })
  doSomething() {}
}
`,
      },
    })

    const result = project.run()
    // 'titleChanged' is a valid dirty-tracking accessor for 'title' column
    const hookErrors = result.errors.filter(e => e.message.includes('titleChanged'))
    expect(hookErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validateSti — STI parent model not found in project
// ---------------------------------------------------------------------------

describe('validator — STI parent model not found', () => {
  it('errors when an STI model extends a parent class not present in the project', () => {
    // DigitalProduct extends Product (isSti=true, stiParent='Product')
    // but Product.model.ts is NOT included → validator should error
    const project = createTestProject({
      schema: schemaBuilder()
        .table('products', t =>
          t.integer('id').primaryKey().notNull().text('type').notNull().text('name')
        )
        .build(),
      models: {
        'DigitalProduct.model.ts': modelBuilder('DigitalProduct', 'products', 'Product').build(),
        // Deliberately omitting 'Product.model.ts'
      },
    })

    const result = project.run()
    expectErrors(result, /DigitalProduct.*Product.*not found/i)
  })
})
