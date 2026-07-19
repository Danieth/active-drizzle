/**
 * Regression: the dev-server watcher must be crash-proof and self-healing.
 *
 * Symptom being guarded against: "codegen stops auto-running after the dev
 * server has been up a while." Root cause class: a transient codegen error
 * (saving a model mid-edit in an invalid state) throws out of the async
 * watcher handler as an unhandled rejection, and/or leaves state wedged so
 * later valid saves never regenerate. Also: every save fires a full page
 * reload even when nothing (or only a .d.ts) changed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, readdirSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import activeDrizzle from '../../src/vite/index.js'

function tempDir(): string {
  const dir = join(tmpdir(), `ad-robust-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true }); return dir
}
function w(dir: string, p: string, c: string) {
  const full = join(dir, p)
  mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(full, c, 'utf8')
}
const SCHEMA = `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const assets = pgTable('assets', { id: integer('id').primaryKey().notNull(), title: text('title') })`
// `marker` is embedded in an instance-method body, which the generator copies
// verbatim into the runtime .gen.ts — a format-independent regeneration probe.
const model = (marker: string) => `import { ApplicationRecord, model, scope } from 'active-drizzle'
@model('assets')
export class Asset extends ApplicationRecord {
  @scope static recent() { return this.where({}) }
  greeting(): string { return '${marker}' }
}`
const BROKEN = `export const notAModelAtAll = 42  // no class — extractor throws`

function bump(p: string, secs: number) { const t = Date.now() / 1000 + secs; utimesSync(p, t, t) }

describe('watcher robustness', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // Concatenate every generated artifact (runtime .gen.ts + types .*.gen.d.ts)
  // so assertions don't couple to the exact generated filename.
  const genContent = () => {
    const md = join(dir, 'src/models')
    return readdirSync(md)
      .filter(f => f.includes('.gen.'))
      .map(f => readFileSync(join(md, f), 'utf8'))
      .join('\n')
  }
  const modelPath = () => join(dir, 'src/models/Asset.model.ts')

  function boot() {
    w(dir, 'db/schema.ts', SCHEMA)
    w(dir, 'src/models/Asset.model.ts', model('BASELINE'))
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({ genDir: false, schema: 'db/schema.ts', models: 'src/models/*.model.ts', outputDir: 'src/models' })
    plugin.configResolved({ root: dir })
    return plugin
  }
  function wire(plugin: any) {
    const reloads: number[] = []
    let change!: (f: string) => any
    plugin.configureServer({
      config: { root: dir },
      ws: { send(msg: any) { if (msg?.type === 'full-reload') reloads.push(1) } },
      watcher: { on(e: string, cb: any) { if (e === 'change') change = cb } },
    })
    return { change, reloads }
  }

  it('a transient codegen error does not throw out of the handler, and the NEXT valid save still regenerates (self-heal)', async () => {
    const plugin = boot()
    await plugin.buildStart()
    const baseline = genContent()          // format-independent snapshot
    const { change } = wire(plugin)

    // 1) Save the model in a broken state (as if mid-edit). Handler must NOT reject.
    writeFileSync(modelPath(), BROKEN, 'utf8'); bump(modelPath(), 2)
    let rejected = false
    await change(modelPath()).catch(() => { rejected = true })
    expect(rejected, 'handler must swallow codegen errors, not reject').toBe(false)

    // 2) Fix it — the watcher must recover and regenerate (output differs from baseline).
    writeFileSync(modelPath(), model('HEALED_MARKER'), 'utf8'); bump(modelPath(), 4)
    await change(modelPath())
    expect(genContent(), 'watcher must self-heal after a transient error').toContain('HEALED_MARKER')
  })

  it('a no-op save (nothing changed) does not trigger a full page reload', async () => {
    const plugin = boot()
    await plugin.buildStart()
    const { change, reloads } = wire(plugin)

    // Fire change with NO edit to the file → codegen is a no-op → must not reload.
    await change(modelPath())
    expect(reloads.length, 'no-op save should not reload the page').toBe(0)
  })

  it('a real edit still reloads and regenerates', async () => {
    const plugin = boot()
    await plugin.buildStart()
    const { change, reloads } = wire(plugin)

    const baseline = genContent()
    writeFileSync(modelPath(), model('EDITED_MARKER'), 'utf8'); bump(modelPath(), 2)
    await change(modelPath())
    expect(genContent(), 'a real edit must regenerate').toContain('EDITED_MARKER')
    expect(reloads.length, 'a real runtime change should reload once').toBeGreaterThanOrEqual(1)
  })

  it('schema edits regenerate even when the watcher emits a symlink-differing path', async () => {
    // Real project dir + a symlink to it. Configure the plugin via the SYMLINK
    // root, but fire the watcher with the REAL path (as chokidar may emit) —
    // exact string equality would miss it; realpath comparison must not.
    const real = join(dir, 'real')
    const linkRoot = join(dir, 'linked')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, linkRoot)

    w(real, 'db/schema.ts', SCHEMA)
    w(real, 'src/models/Asset.model.ts', model('BASELINE'))
    w(real, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')

    const genAll = () => {
      const md = join(real, 'src/models')
      return readdirSync(md).filter(f => f.includes('.gen.')).map(f => readFileSync(join(md, f), 'utf8')).join('\n')
    }

    const plugin: any = activeDrizzle({ genDir: false, schema: 'db/schema.ts', models: 'src/models/*.model.ts', outputDir: 'src/models' })
    plugin.configResolved({ root: linkRoot })   // configured via the symlink
    await plugin.buildStart()
    let change!: (f: string) => any
    plugin.configureServer({ config: { root: linkRoot }, ws: { send() {} }, watcher: { on(e: string, cb: any) { if (e === 'change') change = cb } } })

    // sanity: the linked path and its realpath genuinely differ as strings
    expect(realpathSync(linkRoot)).not.toBe(linkRoot)

    const before = genAll()
    const SCHEMA2 = SCHEMA.replace("title: text('title')", "title: text('title'), subtitle: text('subtitle')")
    const realSchemaPath = join(real, 'db/schema.ts')     // NOT the linked path
    writeFileSync(realSchemaPath, SCHEMA2, 'utf8'); bump(realSchemaPath, 2)

    await change(realSchemaPath)
    expect(genAll(), 'schema edit via realpath-differing path must still regenerate').not.toBe(before)
  })
})
