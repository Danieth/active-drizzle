/**
 * Regression: a `.ctrl.ts` save must NOT bypass the strict failure channel.
 *
 * The refuse-to-emit-on-red gate lives in the model pipeline (runCodegen);
 * the watcher used to route `.ctrl.ts` saves straight to controller codegen,
 * which cold-re-extracted models WITHOUT validate() or resolveAssociations().
 * Sequence that escaped: (1) a model save with a validation ERROR throws per
 * the strict channel and self-heals by resetting every cache; (2) the next
 * `.ctrl.ts` save then regenerated React hooks / _coherence.gen.ts from the
 * exact invalid, association-unresolved meta the channel just refused —
 * inferred coherence edges silently vanished from the emitted files
 * (generate-on-red / silent bad output).
 *
 * The fix routes `.ctrl.ts` saves through runCodegen too, so controller
 * codegen only ever runs behind the same validate()+strict gate (with
 * resolved associations), and still regenerates normally once the model
 * error is fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import activeDrizzle from '../../src/vite/index.js'

function tempDir(): string {
  const dir = join(tmpdir(), `ad-redgate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true }); return dir
}
function w(dir: string, p: string, c: string) {
  mkdirSync(join(dir, p.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(join(dir, p), c, 'utf8')
}
function bump(p: string, secs: number) { const t = Date.now() / 1000 + secs; utimesSync(p, t, t) }

const SCHEMA = `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', {
  id: integer('id').primaryKey().notNull(),
  title: text('title'),
  userId: integer('user_id').notNull(),
})
export const users = pgTable('users', {
  id: integer('id').primaryKey().notNull(),
  name: text('name'),
})`

// NOTE: bare belongsTo() — the table is INFERRED by resolveAssociations()
// (runCodegen-only). The bypass regenerated from meta where resolvedTable
// was still null, which silently dropped this association's coherence edge.
const POST_MODEL = `import { ApplicationRecord, model, belongsTo } from 'active-drizzle'
@model('posts')
export class Post extends ApplicationRecord {
  static user = belongsTo()
}`

const USER_MODEL_GOOD = `import { ApplicationRecord, model, hasMany } from 'active-drizzle'
@model('users')
export class User extends ApplicationRecord {
  static posts = hasMany('posts')
}`

// association to a table that does not exist → validate() ERROR → strict throw
const USER_MODEL_RED = `import { ApplicationRecord, model, hasMany, belongsTo } from 'active-drizzle'
@model('users')
export class User extends ApplicationRecord {
  static posts = hasMany('posts')
  static gizmo = belongsTo('gizmos', { foreignKey: 'id' })
}`

const CTRL = (searchable: boolean) => `import { controller, crud } from '@active-drizzle/controller'
class Post {}
@controller('/posts')
@crud(Post, {
  index: { include: ['user']${searchable ? `, searchable: ['title']` : ''} },
  get: { expose: ['id', 'title', 'userId'], abilities: true },
  create: { permit: ['title', 'userId'] },
  update: { permit: ['title', 'userId'] },
})
export class PostController {}
`

describe('watcher: .ctrl.ts saves go through the strict failure channel', () => {
  let dir: string
  beforeEach(() => { dir = tempDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const coherence = () => readFileSync(join(dir, '.gen/controllers/_coherence.gen.ts'), 'utf8')
  const userPath = () => join(dir, 'src/models/User.model.ts')
  const ctrlPath = () => join(dir, 'src/controllers/Post.ctrl.ts')

  function boot() {
    w(dir, 'db/schema.ts', SCHEMA)
    w(dir, 'src/models/Post.model.ts', POST_MODEL)
    w(dir, 'src/models/User.model.ts', USER_MODEL_GOOD)
    w(dir, 'src/controllers/Post.ctrl.ts', CTRL(false))
    w(dir, 'tsconfig.json', '{"compilerOptions":{"strict":true,"experimentalDecorators":true}}')
    const plugin: any = activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/*.model.ts',
      controllers: 'src/controllers/*.ctrl.ts',
      reactHooks: true,
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

  it('a .ctrl.ts save after a RED model save refuses to regenerate from unvalidated meta', async () => {
    const plugin = boot()
    await plugin.buildStart()
    // sanity: the green boot resolved Post→users and emitted the inferred edge
    expect(coherence()).toContain('users: [')
    const { change } = wire(plugin)

    // (1) RED model save — the strict channel throws; the scheduler catches
    // and resets every cache. The handler itself must not reject.
    writeFileSync(userPath(), USER_MODEL_RED, 'utf8'); bump(userPath(), 2)
    let rejected = false
    await change(userPath()).catch(() => { rejected = true })
    expect(rejected).toBe(false)

    // (2) .ctrl.ts save while the model state is still red. Before the fix
    // this cold-extracted models (no validate, no resolveAssociations) and
    // REWROTE _coherence.gen.ts without the users edge — silent bad output.
    writeFileSync(ctrlPath(), CTRL(false) + '// touched\n', 'utf8'); bump(ctrlPath(), 4)
    await change(ctrlPath())
    expect(
      coherence(),
      'controller codegen must refuse while the model state is red — the inferred users edge must survive',
    ).toContain('users: [')
  })

  it('after the model error is FIXED, controller saves regenerate normally (no wedge)', async () => {
    const plugin = boot()
    await plugin.buildStart()
    const { change } = wire(plugin)

    // red → ctrl save (refused) → heal → ctrl save again must regenerate
    writeFileSync(userPath(), USER_MODEL_RED, 'utf8'); bump(userPath(), 2)
    await change(userPath())
    writeFileSync(ctrlPath(), CTRL(false) + '// touched\n', 'utf8'); bump(ctrlPath(), 4)
    await change(ctrlPath())

    writeFileSync(userPath(), USER_MODEL_GOOD, 'utf8'); bump(userPath(), 6)
    await change(userPath())

    // a hook-visible config change: searchable flips the generated surface meta
    writeFileSync(ctrlPath(), CTRL(true), 'utf8'); bump(ctrlPath(), 8)
    await change(ctrlPath())
    const hook = readFileSync(join(dir, '.gen/controllers/post.gen.ts'), 'utf8')
    expect(hook).toContain('searchable: true')
    expect(coherence()).toContain('users: [')
  })
})
