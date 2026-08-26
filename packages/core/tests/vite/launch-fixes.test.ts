/**
 * Launch codegen fixes — the vite-plugin / watch-mode half.
 *
 *  - model-file DELETION regenerates (drops the model from the manifest)
 *  - a controller-file EDIT is re-read from disk (no stale AST)
 *  - the codegen FAILURE CHANNEL refuses to emit on a validation error (strict)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Project } from 'ts-morph'
import activeDrizzle from '../../src/vite/index.js'
import { extractControllers } from '../../src/codegen/controller-extractor.js'

function tempDir(): string {
  const dir = join(tmpdir(), `ad-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true }); return dir
}
function w(dir: string, p: string, c: string) {
  mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, p), c, 'utf8')
}
function bump(p: string, secs: number) { const t = Date.now() / 1000 + secs; utimesSync(p, t, t) }

const SCHEMA = `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const assets = pgTable('assets', { id: integer('id').primaryKey().notNull(), title: text('title') })
export const widgets = pgTable('widgets', { id: integer('id').primaryKey().notNull(), name: text('name') })`

const assetModel = `import { ApplicationRecord, model } from 'active-drizzle'
@model('assets') export class Asset extends ApplicationRecord {}`
const widgetModel = `import { ApplicationRecord, model } from 'active-drizzle'
@model('widgets') export class Widget extends ApplicationRecord {}`

describe('vite plugin — launch codegen fixes', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function boot(extra: Record<string, unknown> = {}) {
    w(dir, 'db/schema.ts', SCHEMA)
    w(dir, 'src/models/Asset.model.ts', assetModel)
    w(dir, 'src/models/Widget.model.ts', widgetModel)
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({ genDir: false, schema: 'db/schema.ts', models: 'src/models/*.model.ts', outputDir: 'src/models', ...extra })
    plugin.configResolved({ root: dir })
    return plugin
  }
  function wire(plugin: any) {
    const handlers: Record<string, (f: string) => any> = {}
    plugin.configureServer({
      config: { root: dir },
      ws: { send() {} },
      watcher: { on(e: string, cb: any) { handlers[e] = cb } },
    })
    return handlers
  }
  const registry = () => readFileSync(join(dir, 'src/models/_registry.gen.ts'), 'utf8')

  it('DELETING a model file regenerates and drops it from the registry', async () => {
    const plugin = boot()
    await plugin.buildStart()
    expect(registry()).toContain('Widget')

    const handlers = wire(plugin)
    expect(typeof handlers.unlink, 'plugin must register an unlink watcher').toBe('function')

    // Remove Widget.model.ts and fire the unlink event (as chokidar would).
    rmSync(join(dir, 'src/models/Widget.model.ts'))
    await handlers.unlink!(join(dir, 'src/models/Widget.model.ts'))

    expect(registry()).toContain('Asset')
    expect(registry(), 'deleted model must be pruned from the manifest').not.toContain('Widget')
  })

  it('FAILURE CHANNEL: a validation error refuses to emit (strict default)', async () => {
    w(dir, 'db/schema.ts', SCHEMA)
    // belongsTo a table that does not exist → a validation ERROR (not an exception)
    w(dir, 'src/models/Asset.model.ts', `import { ApplicationRecord, model, belongsTo } from 'active-drizzle'
      @model('assets') export class Asset extends ApplicationRecord {
        static ghost = belongsTo('ghosts')
      }`)
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({ genDir: false, schema: 'db/schema.ts', models: 'src/models/Asset.model.ts', outputDir: 'src/models' })
    plugin.configResolved({ root: dir })

    await expect(plugin.buildStart(), 'strict codegen must refuse to emit on error').rejects.toThrow(/Refusing to generate/i)
    // Nothing was written from the invalid meta.
    expect(existsSync(join(dir, 'src/models/_registry.gen.ts'))).toBe(false)
  })

  it('strict:false falls back to emitting despite the error', async () => {
    w(dir, 'db/schema.ts', SCHEMA)
    w(dir, 'src/models/Asset.model.ts', `import { ApplicationRecord, model, belongsTo } from 'active-drizzle'
      @model('assets') export class Asset extends ApplicationRecord {
        static ghost = belongsTo('ghosts')
      }`)
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({ genDir: false, schema: 'db/schema.ts', models: 'src/models/Asset.model.ts', outputDir: 'src/models', strict: false })
    plugin.configResolved({ root: dir })

    await expect(plugin.buildStart()).resolves.not.toThrow()
    expect(existsSync(join(dir, 'src/models/_registry.gen.ts'))).toBe(true)
  })
})

// ── controller-extractor re-reads disk (no stale AST) ──────────────────────
describe('extractControllers — refreshes a changed file from disk', () => {
  it('a persistent Project sees the SECOND version of a .ctrl.ts, not the cached first', () => {
    const dir = tempDir()
    try {
      const ctrl = (path: string) => `import { controller, crud } from 'active-drizzle'
        @controller('${path}') @crud('Asset') export class AssetController {}`
      const file = join(dir, 'Asset.ctrl.ts')
      writeFileSync(file, ctrl('/assets'), 'utf8')

      const project = new Project({ compilerOptions: { strict: false, experimentalDecorators: true }, skipAddingFilesFromTsConfig: true })
      const first = extractControllers(project, [file])
      expect(first.controllers[0]!.basePath).toBe('/assets')

      // Edit on disk, then extract again with the SAME persistent project.
      writeFileSync(file, ctrl('/renamed'), 'utf8'); bump(file, 2)
      const second = extractControllers(project, [file])
      // Previously the cached SourceFile made this still say '/assets'.
      expect(second.controllers[0]!.basePath).toBe('/renamed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
