/**
 * Regression: deleting a model file must remove its DERIVED outputs too.
 *
 * The 'unlink' listener regenerated registry/barrel/globals without the
 * deleted model, but the model's own `X.model.gen.ts` /
 * `X.model.types.gen.d.ts` stayed on disk forever — still importing the
 * now-deleted source module. The demo tsconfig includes `.gen/**`, so tsc
 * and the editor reported TS2307 inside a file stamped AUTO-GENERATED — DO
 * NOT EDIT, with no hint that the fix is to hand-delete it. Deleting the
 * LAST model file was even worse: the empty glob early-returned BEFORE the
 * prune loop, freezing the registry with a dead import.
 *
 * Fix: genDir mode sweeps its models dir against the expected output set on
 * every run (also healing orphans left while the server was down); legacy
 * co-located mode deletes the pruned source's derived outputs; the prune/
 * regen path now runs even when zero model files remain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import activeDrizzle from '../../src/vite/index.js'

function tempDir(): string {
  const dir = join(tmpdir(), `ad-unlink-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true }); return dir
}
function w(dir: string, p: string, c: string) {
  mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, p), c, 'utf8')
}

const SCHEMA = `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', { id: integer('id').primaryKey().notNull(), title: text('title') })
export const users = pgTable('users', { id: integer('id').primaryKey().notNull(), name: text('name') })`

const POST_MODEL = `import { ApplicationRecord, model } from 'active-drizzle'
@model('posts')
export class Post extends ApplicationRecord {}`

const USER_MODEL = `import { ApplicationRecord, model } from 'active-drizzle'
@model('users')
export class User extends ApplicationRecord {}`

describe('unlink: stale .gen outputs are deleted with their model', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makePlugin(models: Record<string, string>, opts: Record<string, unknown> = {}) {
    w(dir, 'db/schema.ts', SCHEMA)
    for (const [p, c] of Object.entries(models)) w(dir, p, c)
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({ schema: 'db/schema.ts', models: 'src/models/*.model.ts', ...opts })
    plugin.configResolved({ root: dir })
    return plugin
  }
  function wire(plugin: any) {
    let unlink!: (f: string) => any
    plugin.configureServer({
      config: { root: dir },
      ws: { send() {} },
      watcher: { on(e: string, cb: any) { if (e === 'unlink') unlink = cb } },
    })
    return { unlink }
  }

  it('genDir mode: deleting a model removes its .gen.ts and .types.gen.d.ts and prunes the manifest', async () => {
    const plugin = makePlugin({
      'src/models/Post.model.ts': POST_MODEL,
      'src/models/User.model.ts': USER_MODEL,
    })
    await plugin.buildStart()
    expect(existsSync(join(dir, '.gen/models/Post.model.gen.ts'))).toBe(true)
    expect(existsSync(join(dir, '.gen/models/Post.model.types.gen.d.ts'))).toBe(true)
    const { unlink } = wire(plugin)

    const postPath = join(dir, 'src/models/Post.model.ts')
    rmSync(postPath)
    await unlink(postPath)

    // manifest half (already worked) …
    const registry = readFileSync(join(dir, '.gen/models/_registry.gen.ts'), 'utf8')
    expect(registry).not.toContain('Post')
    expect(readFileSync(join(dir, '.gen/models/index.ts'), 'utf8')).not.toContain('Post.model.gen')
    // … AND the derived outputs (the half that used to stay behind, TS2307)
    expect(existsSync(join(dir, '.gen/models/Post.model.gen.ts'))).toBe(false)
    expect(existsSync(join(dir, '.gen/models/Post.model.types.gen.d.ts'))).toBe(false)
    // the surviving model is untouched
    expect(existsSync(join(dir, '.gen/models/User.model.gen.ts'))).toBe(true)
  })

  it('deleting the LAST model file still prunes the registry (no frozen dead import)', async () => {
    const plugin = makePlugin({ 'src/models/Post.model.ts': POST_MODEL })
    await plugin.buildStart()
    expect(readFileSync(join(dir, '.gen/models/_registry.gen.ts'), 'utf8')).toContain('Post')
    const { unlink } = wire(plugin)

    const postPath = join(dir, 'src/models/Post.model.ts')
    rmSync(postPath)
    await unlink(postPath)

    expect(existsSync(join(dir, '.gen/models/Post.model.gen.ts'))).toBe(false)
    expect(existsSync(join(dir, '.gen/models/Post.model.types.gen.d.ts'))).toBe(false)
    const registry = readFileSync(join(dir, '.gen/models/_registry.gen.ts'), 'utf8')
    expect(registry, 'registry must not keep importing the deleted module').not.toContain('Post')
  })

  it('genDir mode: orphans from a deletion made while the server was DOWN are swept on the next boot', async () => {
    const plugin = makePlugin({
      'src/models/Post.model.ts': POST_MODEL,
      'src/models/User.model.ts': USER_MODEL,
    })
    await plugin.buildStart()
    expect(existsSync(join(dir, '.gen/models/Post.model.gen.ts'))).toBe(true)

    // simulate: server stopped, file deleted, server restarted (fresh plugin)
    rmSync(join(dir, 'src/models/Post.model.ts'))
    const plugin2: any = activeDrizzle({ schema: 'db/schema.ts', models: 'src/models/*.model.ts' })
    plugin2.configResolved({ root: dir })
    await plugin2.buildStart()

    expect(existsSync(join(dir, '.gen/models/Post.model.gen.ts'))).toBe(false)
    expect(existsSync(join(dir, '.gen/models/Post.model.types.gen.d.ts'))).toBe(false)
    expect(readFileSync(join(dir, '.gen/models/_registry.gen.ts'), 'utf8')).not.toContain('Post')
  })

  it('legacy co-located mode: the pruned model\'s outputs beside its source are deleted', async () => {
    const plugin = makePlugin({
      'src/models/Post.model.ts': POST_MODEL,
      'src/models/User.model.ts': USER_MODEL,
    }, { genDir: false, outputDir: 'src/models' })
    await plugin.buildStart()
    expect(existsSync(join(dir, 'src/models/Post.model.gen.ts'))).toBe(true)
    const { unlink } = wire(plugin)

    const postPath = join(dir, 'src/models/Post.model.ts')
    rmSync(postPath)
    await unlink(postPath)

    expect(existsSync(join(dir, 'src/models/Post.model.gen.ts'))).toBe(false)
    expect(existsSync(join(dir, 'src/models/Post.model.types.gen.d.ts'))).toBe(false)
    expect(existsSync(join(dir, 'src/models/User.model.gen.ts'))).toBe(true)
  })
})
