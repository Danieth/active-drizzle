/**
 * Launch codegen fixes — the extractor/generator half of the REMAINS-FOR-LAUNCH
 * "Codegen soundness" cluster. Each test encodes a scenario the extractor
 * previously got WRONG on legal input, and asserts the corrected behavior.
 */
import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { createTestProject } from '../helpers/index.js'
import { extractSchema, extractModel, extractModels } from '../../src/codegen/extractor.js'
import { columnToTsType, jsString, generate } from '../../src/codegen/generator.js'
import { generateReactHooks } from '../../src/codegen/react-generator.js'
import type { CtrlMeta, CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

function schemaProject(schema: string) {
  const p = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: false } })
  p.createSourceFile('/db/schema.ts', schema)
  return p
}

// ── Spread columns (…timestamps) ───────────────────────────────────────────
describe('extractSchema — spread properties in pgTable()', () => {
  it('inlines columns spread from a shared object (the Drizzle-recommended pattern)', () => {
    const p = schemaProject(`
      import { pgTable, integer, text, timestamp } from 'drizzle-orm/pg-core'
      const timestamps = {
        createdAt: timestamp('created_at').notNull(),
        updatedAt: timestamp('updated_at').notNull(),
      }
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey().notNull(),
        title: text('title'),
        ...timestamps,
      })
    `)
    const cols = extractSchema(p, '/db/schema.ts').tables['posts']!.columns
    const names = cols.map(c => c.name)
    // Previously createdAt/updatedAt were dropped SILENTLY.
    expect(names).toEqual(expect.arrayContaining(['id', 'title', 'createdAt', 'updatedAt']))
    expect(cols.find(c => c.name === 'createdAt')?.type).toBe('timestamp')
    expect(cols.find(c => c.name === 'createdAt')?.nullable).toBe(false)
  })

  it('teaches (does not silently drop) when a spread cannot be resolved to a literal', () => {
    const p = schemaProject(`
      import { pgTable, integer } from 'drizzle-orm/pg-core'
      function makeCols() { return { x: integer('x') } }
      export const posts = pgTable('posts', {
        id: integer('id').primaryKey().notNull(),
        ...makeCols(),
      })
    `)
    expect(() => extractSchema(p, '/db/schema.ts')).toThrow(/spread/i)
  })
})

// ── pgEnum nullability + Drizzle runtime defaults ──────────────────────────
describe('extractColumn — pgEnum nullability & $default recognition', () => {
  const p = () => schemaProject(`
    import { pgTable, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core'
    export const roleEnum = pgEnum('role', ['admin', 'user'])
    export const users = pgTable('users', {
      id: integer('id').primaryKey().notNull(),
      role: roleEnum('role'),
      requiredRole: roleEnum('required_role').notNull(),
      slug: integer('slug').$defaultFn(() => 1),
      touchedAt: timestamp('touched_at').$onUpdate(() => new Date()),
    })
  `)

  it('a pgEnum column WITHOUT .notNull() is nullable (was forced NOT NULL)', () => {
    const cols = extractSchema(p(), '/db/schema.ts').tables['users']!.columns
    expect(cols.find(c => c.name === 'role')?.nullable).toBe(true)
    expect(cols.find(c => c.name === 'requiredRole')?.nullable).toBe(false)
  })

  it('recognizes $defaultFn / $onUpdate as supplying a default (not required on Create)', () => {
    const cols = extractSchema(p(), '/db/schema.ts').tables['users']!.columns
    expect(cols.find(c => c.name === 'slug')?.hasDefault).toBe(true)
    expect(cols.find(c => c.name === 'touchedAt')?.hasDefault).toBe(true)
  })
})

// ── Chained Attr modifiers keep client validations ─────────────────────────
describe('extractPropertyValidations — unwraps the modifier chain', () => {
  it('a chained Attr (.encrypt()) still surfaces its validate(s)', () => {
    const project = createTestProject({
      schema: `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
        export const users = pgTable('users', { id: integer('id').primaryKey().notNull(), email: text('email') })`,
      models: {
        'User.model.ts': `import { ApplicationRecord, model, Attr, Validates } from 'active-drizzle'
          @model('users')
          export class User extends ApplicationRecord {
            static email = Attr.string({ validate: Validates.email() }).encrypt()
          }`,
      },
    })
    const meta = project.extractModel('User.model.ts')
    // Previously the outer .encrypt() call hid the config object → validation dropped.
    expect(meta.propertyValidations.email).toBeDefined()
    expect(meta.propertyValidations.email).toContain('Validates.email')
  })
})

// ── Co-located STI subclass is visible ─────────────────────────────────────
describe('extractModels — co-located STI subclass', () => {
  it('extracts EVERY @model class in the file, not just the first', () => {
    const project = createTestProject({
      schema: `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
        export const posts = pgTable('posts', { id: integer('id').primaryKey().notNull(), type: text('type') })`,
      models: {
        'Post.model.ts': `import { ApplicationRecord, model } from 'active-drizzle'
          @model('posts')
          export class Post extends ApplicationRecord { static stiType = 'Post' }
          @model('posts')
          export class Article extends Post { static stiType = 'Article' }`,
      },
    })
    const metas = extractModels(project.tsProject, '/project/models/Post.model.ts')
    expect(metas.map(m => m.className)).toEqual(['Post', 'Article'])
    const article = metas.find(m => m.className === 'Article')!
    expect(article.isSti).toBe(true)
    expect(article.stiParent).toBe('Post')
    // Both point at the same source file → the generator must not clobber one.
    expect(article.filePath).toBe('/project/models/Post.model.ts')
  })

  it('generates BOTH co-located models into one file without clobbering', () => {
    const project = createTestProject({
      schema: `import { pgTable, integer, text } from 'drizzle-orm/pg-core'
        export const posts = pgTable('posts', { id: integer('id').primaryKey().notNull(), type: text('type') })`,
      models: {
        'Post.model.ts': `import { ApplicationRecord, model } from 'active-drizzle'
          @model('posts')
          export class Post extends ApplicationRecord { static stiType = 'Post' }
          @model('posts')
          export class Article extends Post { static stiType = 'Article' }`,
      },
    })
    const metas = extractModels(project.tsProject, '/project/models/Post.model.ts')
    const files = generate({ schema: project.extractSchema(), models: metas })

    // Exactly ONE runtime file for the shared source (not two colliding writes).
    const runtime = files.filter(f => f.path.endsWith('.model.gen.ts'))
    expect(runtime).toHaveLength(1)
    expect(runtime[0]!.content).toContain('class PostClient')
    expect(runtime[0]!.content).toContain('class ArticleClient')
    // The combined header appears once; imports from the shared source are deduped.
    expect(runtime[0]!.content.match(/\/\/ AUTO-GENERATED/g) ?? []).toHaveLength(1)
    // Both import from the SHARED source module, not a per-class file.
    expect(runtime[0]!.content).toContain("from './Post.model.js'")
    expect(runtime[0]!.content).not.toContain("from './Article.model.js'")

    // The registry lists both classes and side-effect-imports the file once.
    const reg = files.find(f => f.path === '_registry.gen.ts')!.content
    expect(reg).toContain('Post,')
    expect(reg).toContain('Article,')
    expect(reg.match(/import '\.\/Post\.model\.gen\.js'/g) ?? []).toHaveLength(1)
  })
})

// ── App strings escape into generated source ───────────────────────────────
describe('string escaping — app strings become valid literals', () => {
  it('jsString escapes apostrophes/backslashes into a parseable literal', () => {
    expect(jsString("it's")).toBe("'it\\'s'")
    // eslint-disable-next-line no-eval
    expect(eval(jsString("it's"))).toBe("it's")
    // eslint-disable-next-line no-eval
    expect(eval(jsString('a\\b'))).toBe('a\\b')
  })

  it('a pgEnum value with an apostrophe produces a VALID union (was injection-shaped)', () => {
    const p = schemaProject(`
      import { pgTable, integer, pgEnum } from 'drizzle-orm/pg-core'
      export const kindEnum = pgEnum('kind', ["it's", 'plain'])
      export const things = pgTable('things', {
        id: integer('id').primaryKey().notNull(),
        kind: kindEnum('kind').notNull(),
      })
    `)
    const col = extractSchema(p, '/db/schema.ts').tables['things']!.columns.find(c => c.name === 'kind')!
    const ts = columnToTsType(col)
    expect(ts).toContain("'it\\'s'")
    expect(ts).not.toContain("'it's'") // the broken, unescaped form
  })
})

// ── One type map: bigint agrees server-side and client-side ────────────────
describe('columnToClientType folds into COLUMN_TS_TYPE', () => {
  it('types bigint as string client-side (was number — a type lie)', () => {
    const schema = `import { pgTable, integer, bigint } from 'drizzle-orm/pg-core'
      export const ledgers = pgTable('ledgers', {
        id: integer('id').primaryKey().notNull(),
        balance: bigint('balance', { mode: 'bigint' }).notNull(),
      })`
    const project = createTestProject({ schema, models: {
      'Ledger.model.ts': `import { ApplicationRecord, model } from 'active-drizzle'
        @model('ledgers') export class Ledger extends ApplicationRecord {}`,
    } })
    const projectMeta: ProjectMeta = {
      schema: project.extractSchema(),
      models: [project.extractModel('Ledger.model.ts')],
    }
    // Server-side map already says string:
    const balanceCol = projectMeta.schema.tables['ledgers']!.columns.find(c => c.name === 'balance')!
    expect(columnToTsType(balanceCol)).toBe('string')

    const ctrl: CtrlMeta = {
      filePath: '/src/Ledger.ctrl.ts', className: 'LedgerController', basePath: '/ledgers',
      scopes: [], kind: 'crud', modelClass: 'Ledger', mutations: [], actions: [],
      crudConfig: { get: { expose: ['id', 'balance'], abilities: true } },
    } as CtrlMeta
    const files = generateReactHooks({ controllers: [ctrl] } as CtrlProjectMeta, projectMeta, '/out')
    const content = files.find(f => f.filePath.includes('ledger.gen'))!.content
    // The client Attrs shape must type balance as string, matching the wire.
    expect(content).toMatch(/balance\s*:\s*string/)
    expect(content).not.toMatch(/balance\s*:\s*number/)
  })
})
