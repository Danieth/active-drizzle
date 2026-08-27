/**
 * Watch-mode invalidation for the CROSS-IR versioned-models pass (O2/O14).
 *
 * The pass reads controller config × model statics × schema pk kind at once,
 * so its verdict can flip when EITHER side changes — and the per-model
 * diagnostic cache (keyed by model filePath) can't carry it. Two lanes:
 *
 *   • model/schema-side change, `.ctrl.ts` untouched: runCodegen's strict
 *     gate must refuse BEFORE any emit (a schema that drops the lock column
 *     under a lock-opted controller must not half-regenerate the tree);
 *   • ctrl-side change, models untouched (the early-exit lane): the gate
 *     inside runControllerCodegen must refuse before any route/hook write.
 *
 * Both must self-heal: fixing the offending side regenerates normally.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import activeDrizzle from '../../src/vite/index.js'

function tempDir(): string {
  const dir = join(tmpdir(), `ad-crossir-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true }); return dir
}
function w(dir: string, p: string, c: string) {
  mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, p), c, 'utf8')
}
function bump(p: string, secs: number) { const t = Date.now() / 1000 + secs; utimesSync(p, t, t) }

const SCHEMA = (withLock: boolean, extraCol = '') => `import { pgTable, serial, integer, text } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title'),${withLock ? `
  lockVersion: integer('lock_version').notNull().default(0),` : ''}${extraCol ? `
  ${extraCol}` : ''}
})`

const POST_MODEL = `import { ApplicationRecord, model } from 'active-drizzle'
@model('posts')
export class Post extends ApplicationRecord {}`

const CTRL = (lock: boolean, searchable = false) => `import { controller, crud } from '@active-drizzle/controller'
class Post {}
@controller('/posts')
@crud(Post, {
  index: { include: []${searchable ? `, searchable: ['title']` : ''} },
  get: { expose: ['id', 'title'], abilities: true },
  update: { permit: ['title']${lock ? `, optimisticLock: true` : ''} },
})
export class PostController {}
`

describe('watch-mode: cross-IR versioned-models invalidation', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const schemaPath = () => join(dir, 'db/schema.ts')
  const ctrlPath = () => join(dir, 'src/controllers/Post.ctrl.ts')
  const modelTypes = () => readFileSync(join(dir, '.gen/models/Post.model.types.gen.d.ts'), 'utf8')
  const hook = () => readFileSync(join(dir, '.gen/controllers/post.gen.ts'), 'utf8')

  function boot(opts: { lockColumn: boolean; ctrlLock: boolean; strict?: boolean }) {
    w(dir, 'db/schema.ts', SCHEMA(opts.lockColumn))
    w(dir, 'src/models/Post.model.ts', POST_MODEL)
    w(dir, 'src/controllers/Post.ctrl.ts', CTRL(opts.ctrlLock))
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
      controllers: 'src/controllers/*.ctrl.ts',
      reactHooks: true,
      ...(opts.strict !== undefined ? { strict: opts.strict } : {}),
    })
    plugin.configResolved({ root: dir })
    return plugin
  }
  function wire(plugin: any) {
    let change!: (f: string) => any
    plugin.configureServer({
      config: { root: dir },
      ws: { send() {} },
      watcher: { on(e: string, cb: any) { if (e === 'change') change = cb } },
    })
    return { change }
  }

  it('a SCHEMA save that drops the lock column under a lock-opted controller refuses BEFORE any emit', async () => {
    const plugin = boot({ lockColumn: true, ctrlLock: true })
    await plugin.buildStart()
    expect(modelTypes()).toContain('lockVersion')   // green boot emitted the versioned shape
    const { change } = wire(plugin)

    // Schema-only change — no .ctrl.ts touched. The cross-IR verdict flips red.
    writeFileSync(schemaPath(), SCHEMA(false), 'utf8'); bump(schemaPath(), 2)
    let rejected = false
    await change(schemaPath()).catch(() => { rejected = true })
    expect(rejected).toBe(false)                    // scheduler self-heals, never rejects the handler
    expect(
      modelTypes(),
      'refusal must land BEFORE the model emit — the tree must not half-regenerate',
    ).toContain('lockVersion')

    // Healing the schema regenerates normally (no wedge). The heal is
    // ADDITIVE — a new 'body' column that was NEVER in the boot-time output —
    // so this assertion cannot pass vacuously off stale files: it pins that
    // the watcher actually re-ran AND the gate actually cleared.
    writeFileSync(schemaPath(), SCHEMA(true, `body: text('body'),`), 'utf8'); bump(schemaPath(), 4)
    await change(schemaPath())
    expect(modelTypes()).toContain('lockVersion')
    expect(modelTypes(), 'the additive heal must land — refusal-then-wedge would keep the old file').toContain('body')
  })

  it('a CTRL-only save that opts into locking without a lock column refuses before route/hook writes', async () => {
    const plugin = boot({ lockColumn: false, ctrlLock: false })
    await plugin.buildStart()
    expect(hook()).not.toContain('searchable: true')
    const { change } = wire(plugin)

    // Ctrl-only save (models untouched — the runCodegen early-exit lane):
    // adds optimisticLock: true (RED — no lock column) plus a hook-visible
    // config change. The refusal must keep the hook at its old surface.
    writeFileSync(ctrlPath(), CTRL(true, true), 'utf8'); bump(ctrlPath(), 2)
    let rejected = false
    await change(ctrlPath()).catch(() => { rejected = true })
    expect(rejected).toBe(false)
    expect(
      hook(),
      'the ctrl-only lane must gate too — no hook regen from a red cross-IR state',
    ).not.toContain('searchable: true')

    // Dropping the opt-in heals; the config change now lands.
    writeFileSync(ctrlPath(), CTRL(false, true), 'utf8'); bump(ctrlPath(), 4)
    await change(ctrlPath())
    expect(hook()).toContain('searchable: true')
  })

  it('a red CTRL save healed from the SCHEMA side still lands the pending ctrl output (modelSideChanged invalidation)', async () => {
    // The cross-side heal: the red ctrl-only run updates ctrlCache and
    // lastRouteHash BEFORE its gate throws, so when the user then fixes the
    // SCHEMA (ctrl mtimes untouched), only the modelSideChanged=true call
    // can push the refused save's hook/route changes out — without it the
    // early return pins the stale hook for the rest of the watch session.
    const plugin = boot({ lockColumn: false, ctrlLock: false })
    await plugin.buildStart()
    expect(hook()).not.toContain('searchable: true')
    const { change } = wire(plugin)

    // Red ctrl save: opts into locking (no lock column yet) + a hook-visible
    // config change that gets refused along with it.
    writeFileSync(ctrlPath(), CTRL(true, true), 'utf8'); bump(ctrlPath(), 2)
    await change(ctrlPath()).catch(() => {})
    expect(hook()).not.toContain('searchable: true')

    // Heal the SCHEMA side only — add the lock column the ctrl asked for.
    writeFileSync(schemaPath(), SCHEMA(true), 'utf8'); bump(schemaPath(), 4)
    await change(schemaPath())
    expect(
      hook(),
      'the pending ctrl-side output must land on the cross-side heal — ctrl mtimes are unchanged, so only modelSideChanged can carry it',
    ).toContain('searchable: true')
    expect(modelTypes()).toContain('lockVersion')
  })

  it('strict: false demotes the ctrl-only gate to print-but-emit (no refusal wedge)', async () => {
    const plugin = boot({ lockColumn: false, ctrlLock: false, strict: false })
    await plugin.buildStart()
    expect(hook()).not.toContain('searchable: true')
    const { change } = wire(plugin)

    // The same red ctrl save that lane 2 refuses — under strict: false the
    // diagnostics print but the hook/route write proceeds.
    writeFileSync(ctrlPath(), CTRL(true, true), 'utf8'); bump(ctrlPath(), 2)
    await change(ctrlPath())
    expect(hook(), 'strict: false must emit anyway').toContain('searchable: true')
  })
})
