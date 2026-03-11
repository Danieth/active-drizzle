/**
 * Vite plugin tests — verifies the plugin contract.
 *
 * We don't spin up a real Vite devserver; instead we directly call
 * the `runCodegen` internals exposed via the plugin's buildStart hook,
 * using a temp directory with real files on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import activeDrizzle from '../../src/vite/index.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `active-drizzle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeFile(dir: string, path: string, content: string): void {
  const full = join(dir, path)
  mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

const SIMPLE_SCHEMA = `
import { pgTable, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core'

export const assets = pgTable('assets', {
  id: integer('id').primaryKey().notNull(),
  title: text('title'),
  businessId: integer('business_id').notNull(),
  createdAt: timestamp('created_at').notNull(),
})

export const businesses = pgTable('businesses', {
  id: integer('id').primaryKey().notNull(),
  name: text('name').notNull(),
})
`

const ASSET_MODEL = `
import { ApplicationRecord } from 'active-drizzle'
import { model, scope } from 'active-drizzle'
import { belongsTo, hasMany } from 'active-drizzle'

@model('assets')
export class Asset extends ApplicationRecord {
  static business = belongsTo()

  @scope
  static recent() {
    return this.where({})
  }
}
`

const BUSINESS_MODEL = `
import { ApplicationRecord } from 'active-drizzle'
import { model } from 'active-drizzle'
import { hasMany } from 'active-drizzle'

@model('businesses')
export class Business extends ApplicationRecord {
  static assets = hasMany()
}
`

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('activeDrizzle() Vite plugin', () => {
  it('returns a plugin object with correct name and hooks', () => {
    const plugin = activeDrizzle({ schema: 'db/schema.ts', models: 'src/models/**/*.model.ts' })
    expect((plugin as any).name).toBe('active-drizzle')
    expect(typeof (plugin as any).buildStart).toBe('function')
    expect(typeof (plugin as any).configureServer).toBe('function')
    expect((plugin as any).enforce).toBe('pre')
  })
})

describe('activeDrizzle — full codegen run on disk', () => {
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes .gen.d.ts and .gen.ts files next to model files', async () => {
    writeFile(dir, 'db/schema.ts', SIMPLE_SCHEMA)
    writeFile(dir, 'src/models/Asset.model.ts', ASSET_MODEL)
    writeFile(dir, 'src/models/Business.model.ts', BUSINESS_MODEL)
    writeFile(dir, 'tsconfig.json', JSON.stringify({
      compilerOptions: { strict: true, experimentalDecorators: true },
    }))

    const plugin = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
      outputDir: 'src/models',
    })

    ;(plugin as any).configResolved({ root: dir })
    await (plugin as any).buildStart()

    expect(existsSync(join(dir, 'src/models/Asset.model.gen.d.ts'))).toBe(true)
    expect(existsSync(join(dir, 'src/models/Asset.model.gen.ts'))).toBe(true)
    expect(existsSync(join(dir, 'src/models/Business.model.gen.d.ts'))).toBe(true)
  })

  it('writes _registry.gen.ts to the output dir', async () => {
    writeFile(dir, 'db/schema.ts', SIMPLE_SCHEMA)
    writeFile(dir, 'src/models/Asset.model.ts', ASSET_MODEL)
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true } }))

    const plugin = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
      outputDir: 'src/models',
    })

    ;(plugin as any).configResolved({ root: dir })
    await (plugin as any).buildStart()

    expect(existsSync(join(dir, 'src/models/_registry.gen.ts'))).toBe(true)
  })

  it('writes .active-drizzle/schema.md', async () => {
    writeFile(dir, 'db/schema.ts', SIMPLE_SCHEMA)
    writeFile(dir, 'src/models/Asset.model.ts', ASSET_MODEL)
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true } }))

    const plugin = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
    })

    ;(plugin as any).configResolved({ root: dir })
    await (plugin as any).buildStart()

    const docsPath = join(dir, '.active-drizzle/schema.md')
    expect(existsSync(docsPath)).toBe(true)
    const content = readFileSync(docsPath, 'utf8')
    expect(content).toContain('# active-drizzle Schema Reference')
    expect(content).toContain('## Asset')
  })

  it('generated .gen.d.ts contains correct types', async () => {
    writeFile(dir, 'db/schema.ts', SIMPLE_SCHEMA)
    writeFile(dir, 'src/models/Asset.model.ts', ASSET_MODEL)
    writeFile(dir, 'src/models/Business.model.ts', BUSINESS_MODEL)
    writeFile(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true } }))

    const plugin = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
    })

    ;(plugin as any).configResolved({ root: dir })
    await (plugin as any).buildStart()

    const genContent = readFileSync(join(dir, 'src/models/Asset.model.gen.d.ts'), 'utf8')
    expect(genContent).toContain('business: Promise<BusinessRecord>')
    expect(genContent).toContain('titleChanged(): boolean')
    expect(genContent).toContain('AssetWhere')
    expect(genContent).toContain('AssetCreate')
  })

  it('gracefully handles missing schema file', async () => {
    const plugin = activeDrizzle({
      schema: 'nonexistent/schema.ts',
      models: 'src/models/*.model.ts',
    })

    ;(plugin as any).configResolved({ root: dir })
    // Should not throw — just log an error
    await expect((plugin as any).buildStart()).resolves.toBeUndefined()
  })

  it('gracefully handles no model files matching the glob', async () => {
    writeFile(dir, 'db/schema.ts', SIMPLE_SCHEMA)

    const plugin = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',  // no files exist
    })

    ;(plugin as any).configResolved({ root: dir })
    await expect((plugin as any).buildStart()).resolves.toBeUndefined()
  })
})
