/**
 * BEFORE_LAUNCH #1 — the regression gate: generated code must `tsc --noEmit`
 * clean. Runs the REAL codegen pipeline (the vite plugin's buildStart) over a
 * representative on-disk fixture app, then typechecks everything it emitted
 * with the TypeScript compiler API under the repo's strictness flags.
 *
 * The fixture deliberately exercises the three historically-broken shapes
 * (README-BUGS-FOUND.md / BEFORE_LAUNCH §1):
 *   (a) a controller-less nested child model (Note) included by a controller
 *       (DealController) — previously emitted a dangling
 *       `import type { NoteAttrs } from './note.gen'` for a module that was
 *       never generated;
 *   (b) any `{Model}Client` — previously generated `id?: number` and failed
 *       "incorrectly extends ClientModel";
 *   (c) `static name = Attr.string(...)` (Gadget) — previously tripped
 *       TS1238/TS1270 via the Function.name collision;
 * plus a `wire: 'columnar'` door (transport WS2) so the columnar hook bodies,
 * wire spec, and _entities.gen registration are typechecked too.
 *
 * Workspace packages are resolved to their SOURCE (paths mapping), not dist —
 * the gate must always check generated output against the current framework
 * code, never a stale build.
 *
 * The fixture lives under <repo>/node_modules/ (not os.tmpdir()) so that
 * every bare import in the fixture — drizzle-orm, react, @tanstack/* —
 * resolves naturally against the repo's installed dependencies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import ts from 'typescript'
import activeDrizzle from '../../src/vite/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))          // packages/core/tests/codegen
const REPO_ROOT = resolve(HERE, '../../../..')

let fixtureDir: string

function w(rel: string, content: string): void {
  const abs = join(fixtureDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

const SCHEMA = `import { pgTable, serial, integer, bigint, smallint, text, timestamp } from 'drizzle-orm/pg-core'

export const deals = pgTable('deals', {
  id: serial('id').primaryKey(),
  title: text('title'),
  stage: integer('stage'),
})

export const notes = pgTable('notes', {
  id: serial('id').primaryKey(),
  dealId: integer('deal_id'),
  body: text('body'),
})

export const gadgets = pgTable('gadgets', {
  id: serial('id').primaryKey(),
  name: text('name'),
  kind: text('kind'),
  lockVersion: integer('lock_version').notNull().default(0),
})

// Transport tables (WRITE_LOG_SCHEMA_SQL) — required because the columnar
// door's model is lock-tokened, which makes it write-logged.
export const recordWriteLog = pgTable('record_write_log', {
  model: text('model').notNull(),
  pk: text('pk').notNull(),
  token: bigint('token', { mode: 'number' }).notNull(),
  lifecycle: smallint('lifecycle').notNull().default(0),
  committedAt: timestamp('committed_at').notNull().defaultNow(),
})

export const recordWriteLogMeta = pgTable('record_write_log_meta', {
  model: text('model').primaryKey(),
  fieldsHash: text('fields_hash').notNull(),
})

export const membershipTags = pgTable('membership_tags', {
  door: text('door').primaryKey(),
  tag: bigint('tag', { mode: 'number' }).notNull().default(0),
})
`

const DEAL_MODEL = `import { ApplicationRecord, model, Attr, hasMany, Validates } from '@active-drizzle/core'

@model('deals')
export class Deal extends ApplicationRecord {
  static title = Attr.string({ validate: Validates.presence() })
  // (a) nested child WITHOUT a controller of its own
  static notes = hasMany('notes', { acceptsNested: true })
}
`

const NOTE_MODEL = `import { ApplicationRecord, model, belongsTo } from '@active-drizzle/core'

@model('notes')
export class Note extends ApplicationRecord {
  static deal = belongsTo('deals')
}
`

// (c) static `name` Attr — collides with Function.name unless codegen
// handles it specially on the generated side.
const GADGET_MODEL = `import { ApplicationRecord, model, Attr, Validates } from '@active-drizzle/core'

@model('gadgets')
export class Gadget extends ApplicationRecord {
  static name = Attr.string({ validate: Validates.presence() })
}
`

const DEAL_CTRL = `import { controller, crud } from '@active-drizzle/controller'
import { Deal } from '../models/Deal.model.js'

@controller('/deals')
@crud(Deal, {
  get: { expose: ['id', 'title', 'stage'], include: ['notes'] },
  index: { sortable: ['title'], filterable: ['stage'] },
  create: { permit: ['title', 'stage', 'notesAttributes'] },
  update: { permit: ['title', 'stage', 'notesAttributes'] },
})
export class DealController {}
`

// The columnar door (transport WS2/WS3): expose + abilities are the W1/W5
// build-time requirements; the lock column + optimisticLock engage the
// TRACKED lane (validation 304s, membership tags — the write-log registry),
// which is why the fixture schema declares the transport tables.
const GADGET_CTRL = `import { controller, crud } from '@active-drizzle/controller'
import { Gadget } from '../models/Gadget.model.js'

@controller('/gadgets')
@crud(Gadget, {
  wire: 'columnar',
  get: { expose: ['id', 'name', 'kind'], abilities: true },
  update: { permit: ['name', 'kind'], optimisticLock: true },
})
export class GadgetController {}
`

/** App-shaped tsconfig, at the repo's strictness, resolving workspace packages to source. */
function fixtureTsconfig(): string {
  // @types/react is not hoisted to the repo root (version pinned inside
  // packages/react), so map the react modules an app would get from its own
  // installed @types/react.
  const reactTypes = join(REPO_ROOT, 'packages/react/node_modules/@types/react')
  const paths = {
    '@active-drizzle/core/validators': [join(REPO_ROOT, 'packages/core/src/runtime/validators.ts')],
    '@active-drizzle/core': [join(REPO_ROOT, 'packages/core/src/index.ts')],
    '@active-drizzle/controller': [join(REPO_ROOT, 'packages/controller/src/index.ts')],
    '@active-drizzle/react': [join(REPO_ROOT, 'packages/react/src/index.ts')],
    react: [join(reactTypes, 'index.d.ts')],
    'react/jsx-runtime': [join(reactTypes, 'jsx-runtime.d.ts')],
  }
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM'],
        jsx: 'react-jsx',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        experimentalDecorators: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        noEmit: true,
        paths,
      },
      include: ['db/**/*', 'src/**/*', '.gen/**/*'],
    },
    null,
    2,
  )
}

function read(rel: string): string {
  return readFileSync(join(fixtureDir, rel), 'utf8')
}

beforeAll(async () => {
  fixtureDir = join(
    REPO_ROOT,
    'node_modules',
    `.ad-typecheck-fixture-${process.pid}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(fixtureDir, { recursive: true })

  w('db/schema.ts', SCHEMA)
  w('src/models/Deal.model.ts', DEAL_MODEL)
  w('src/models/Note.model.ts', NOTE_MODEL)
  w('src/models/Gadget.model.ts', GADGET_MODEL)
  w('src/controllers/Deal.ctrl.ts', DEAL_CTRL)
  w('src/controllers/Gadget.ctrl.ts', GADGET_CTRL)
  w('tsconfig.json', fixtureTsconfig())

  // The REAL pipeline — exactly what a `vite build` runs.
  const plugin: any = activeDrizzle({
    schema: 'db/schema.ts',
    models: 'src/models/*.model.ts',
    controllers: 'src/controllers/*.ctrl.ts',
    reactHooks: true,
  })
  plugin.configResolved({ root: fixtureDir })
  await plugin.buildStart()
}, 120_000)

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
})

describe('generated output — the three historical shapes are present', () => {
  it('(a) the controller-less nested child does NOT leave a dangling import', () => {
    const dealHooks = read('.gen/controllers/deal.gen.ts')
    // The child's Attrs shape must exist for the include — either inlined or
    // imported from a module that codegen ACTUALLY EMITTED.
    expect(dealHooks).toContain('NoteAttrs')
    if (dealHooks.includes("from './note.gen'")) {
      expect(
        existsSync(join(fixtureDir, '.gen/controllers/note.gen.ts')),
        "deal.gen.ts imports './note.gen' but codegen never emitted it (the dangling-import bug)",
      ).toBe(true)
    }
  })

  it('(b) the generated {Model}Client exists (id-optionality is proven by the typecheck below)', () => {
    expect(read('.gen/models/Deal.model.gen.ts')).toContain('class DealClient')
  })

  it("(c) `static name = Attr.string(...)` survives into generated output", () => {
    expect(read('.gen/models/Gadget.model.gen.ts')).toContain('name')
  })

  it("the wire: 'columnar' door emitted its entity registration", () => {
    expect(existsSync(join(fixtureDir, '.gen/controllers/_entities.gen.ts'))).toBe(true)
    expect(read('.gen/controllers/gadget.gen.ts')).toContain("./_entities.gen")
  })
})

describe('generated output typechecks clean (the BEFORE_LAUNCH #1 gate)', () => {
  it('tsc --noEmit reports ZERO errors across the fixture app + all generated files', () => {
    const configPath = join(fixtureDir, 'tsconfig.json')
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: d => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      },
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host)!
    expect(parsed.fileNames.length).toBeGreaterThan(5) // schema + models + ctrls + .gen output

    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
    const diags = ts.getPreEmitDiagnostics(program)

    // The gate is scoped to the FIXTURE (sources + generated output). Errors
    // inside packages/*/src belong to `npm run typecheck`, not this test —
    // scoping keeps the gate honest about what it guards and immune to
    // unrelated in-flight package edits.
    const fixtureDiags = diags.filter(d => d.file && resolve(d.file.fileName).startsWith(fixtureDir))

    const rendered = fixtureDiags.map(d => {
      const { line, character } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0)
      const file = resolve(d.file!.fileName).slice(fixtureDir.length + 1)
      return `${file}:${line + 1}:${character + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n  ')}`
    })

    expect(
      rendered,
      `Generated output must typecheck clean — an adopter's first \`tsc\` run is the launch trust gate.\n` +
        `Generated tree:\n  ${listGen().join('\n  ')}`,
    ).toEqual([])
  }, 180_000)
})

function listGen(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join(fixtureDir, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name)
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  if (existsSync(join(fixtureDir, '.gen'))) walk('.gen')
  return out
}
