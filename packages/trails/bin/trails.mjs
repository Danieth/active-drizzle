#!/usr/bin/env node
/**
 * trails new <name> [--link <path-to-active-drizzle-monorepo>]
 *
 * Scaffolds a WORKING app: PGlite (zero-setup Postgres), one model, one
 * controller, the generated typed client + index surface, and the one
 * master trails.config.ts. `npm install && npm run dev` and you have a
 * live, searchable, faceted, permission-governed app.
 *
 * --link is for pre-release / monorepo development: the four framework
 * deps become file: paths into your local checkout.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [, , command, name, ...rest] = process.argv

if (command !== 'new' || !name) {
  console.log('Usage: trails new <app-name> [--link <path-to-active-drizzle-monorepo>]')
  process.exit(command === 'new' ? 1 : 0)
}

const linkIdx = rest.indexOf('--link')
const linkPath = linkIdx >= 0 ? resolve(rest[linkIdx + 1] ?? '') : null

const dir = resolve(process.cwd(), name)
if (existsSync(dir)) {
  console.error(`✗ ${name} already exists`)
  process.exit(1)
}

const AD_DEPS = linkPath
  ? {
      'active-drizzle': `file:${join(linkPath, 'packages/core')}`,
      '@active-drizzle/core': `file:${join(linkPath, 'packages/core')}`,
      '@active-drizzle/controller': `file:${join(linkPath, 'packages/controller')}`,
      '@active-drizzle/react': `file:${join(linkPath, 'packages/react')}`,
    }
  : {
      'active-drizzle': '^0.1.0',
      '@active-drizzle/core': '^0.1.0',
      '@active-drizzle/controller': '^0.1.0',
      '@active-drizzle/react': '^0.1.0',
    }

/** name → content. Layout mirrors the reference app (dealdesk). */
const files = {
  'package.json': JSON.stringify({
    name,
    private: true,
    type: 'module',
    scripts: {
      'dev': 'concurrently -n server,client -c blue,green "npm:dev:server" "npm:dev:client"',
      'dev:server': 'tsx watch server/main.ts',
      'dev:client': 'vite',
      'regen': 'tsx scripts/regen.mts',
      'typecheck': 'tsc --noEmit',
    },
    dependencies: {
      ...AD_DEPS,
      '@electric-sql/pglite': '^0.2.17',
      '@hono/node-server': '^1.13.0',
      '@orpc/client': '^1.13.6',
      '@orpc/server': '^1.13.6',
      '@tanstack/react-query': '^5.90.0',
      'drizzle-orm': '^0.44.0',
      'hono': '^4.6.0',
      'react': '^19.0.0',
      'react-dom': '^19.0.0',
      'zod': '^4.0.0',
    },
    devDependencies: {
      '@types/react': '^19.0.0',
      '@types/node': '^22.0.0',
      '@types/react-dom': '^19.0.0',
      '@vitejs/plugin-react': '^4.3.0',
      'concurrently': '^9.0.0',
      'tsx': '^4.19.0',
      'typescript': '^5.7.0',
      'vite': '^6.0.0',
    },
  }, null, 2) + '\n',

  'trails.config.ts': `/**
 * The one master config — base + inline environment overrides, deep-merged
 * by NODE_ENV at boot. Secrets are REFERENCED from process.env, never
 * stored here (this file commits; the values deploy).
 */
import { defineConfig } from 'active-drizzle'

export default defineConfig({
  server: { port: 8787 },
  channels: {
    // memory = single process. Set REDIS_URL and multi-process just works.
    bus: process.env.REDIS_URL ? 'redis' : 'memory',
    redisUrl: process.env.REDIS_URL,
  },
  environments: {
    production: {},
    test: {},
  },
})
`,

  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
      jsx: 'react-jsx', strict: true, skipLibCheck: true,
      experimentalDecorators: true, useDefineForClassFields: true,
      allowImportingTsExtensions: true, noEmit: true, types: ['vite/client', 'node'],
    },
    include: ['server', 'src', 'vite.config.ts', 'trails.config.ts'],
  }, null, 2) + '\n',

  'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import activeDrizzle from '@active-drizzle/core/vite'

export default defineConfig({
  plugins: [
    react(),
    // backend declarations in → typed clients, form hooks, index surfaces out
    activeDrizzle({
      schema: 'server/db/schema.ts',
      models: 'server/models/*.model.ts',
      controllers: 'server/controllers/*.ctrl.ts',
      reactHooks: true,
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/rpc': 'http://localhost:8787' },
  },
})
`,

  'index.html': `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>${name}</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

  'server/db/schema.ts': `import { pgTable, serial, text, boolean, timestamp } from 'drizzle-orm/pg-core'

// The EXPORT name (posts) is the canonical table name everywhere.
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  published: boolean('published').notNull().default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
`,

  'server/models/Post.model.ts': `import { ApplicationRecord, model, Attr, Validates, scope, beforeSave } from 'active-drizzle'

@model('posts')
export class Post extends ApplicationRecord {
  static title = Attr.string({
    label: 'Title',
    validates: [Validates.presence(), Validates.length({ min: 3, max: 120 })],
  })
  static body = Attr.string({ label: 'Body' })
  static published = Attr.boolean({ label: 'Published' })

  @beforeSave() touch() { (this as any).updatedAt = new Date() }
  @scope static live() { return this.where({ published: true }) }
}
`,

  'server/models/index.ts': `// Barrel — ESM elides unused imports; models must register through here.
export { Post } from './Post.model.ts'
`,

  'server/controllers/Application.ctrl.ts': `import { ActiveController } from '@active-drizzle/controller'

export interface AppContext { userId?: number }

// Add a @before() auth hook here when you have users — every controller
// inherits it. Until then the door is open on purpose.
export class ApplicationController extends ActiveController<AppContext> {}
`,

  'server/controllers/Post.ctrl.ts': `import { controller, crud } from '@active-drizzle/controller'
import { Post } from '../models/Post.model.ts'
import { ApplicationController } from './Application.ctrl.ts'

const EDITABLE = ['title', 'body', 'published'] as const

@controller('/posts')
@crud(Post, {
  index: {
    sortable: ['updatedAt', 'title'],
    defaultSort: { field: 'updatedAt', dir: 'desc' },
    searchable: ['title', 'body'],
    filterable: ['published'],
    facets: true,                 // ceiling — counts computed only when a view asks
  },
  get: {
    expose: ['id', 'title', 'body', 'published', 'updatedAt'],
    abilities: true,              // forms envelope: { record, abilities, can, version }
  },
  create: { permit: [...EDITABLE] },
  update: { permit: [...EDITABLE], optimisticLock: true },
})
export class PostController extends ApplicationController {}
`,

  'server/main.ts': `/**
 * PGlite (in-process Postgres, zero setup) + Hono + oRPC.
 * boot → buildRouter → RPCHandler at /rpc. Port from trails.config.ts.
 */
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { RPCHandler } from '@orpc/server/fetch'
import { boot, loadConfig } from 'active-drizzle'
import { buildRouter } from '@active-drizzle/controller'

import * as schema from './db/schema.ts'
import { Post } from './models/index.ts'
import { PostController } from './controllers/Post.ctrl.ts'

const pg = new PGlite()
const db = drizzle(pg, { schema })

await pg.exec(\`
  CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    published BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP NOT NULL DEFAULT now()
  );
\`)

// 'as any': the app's drizzle-orm instance vs the framework's — nominal
// protected-member clash across duplicate module identities (the demo
// carries the same cast; runtime is a single shared connection either way)
boot(db as any, { posts: schema.posts })

await Post.create({ title: 'Hello trails', body: 'Generated by trails new.', published: true })
await Post.create({ title: 'A draft to edit', body: 'Open it and type — it autosaves.' })

const { router } = buildRouter(PostController)
const rpc = new RPCHandler({ posts: router })

const app = new Hono()
app.use('/rpc/*', async (c) => {
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: '/rpc',
    context: { userId: Number(c.req.header('x-user-id')) || undefined },
  })
  return matched ? response : c.notFound()
})

const config = await loadConfig()
const port = config.server?.port ?? 8787
serve({ fetch: app.fetch, port })
console.log(\`\${'${name}'} API on http://localhost:\${port}  [channels bus: \${config.channels?.bus ?? 'memory'}]\`)
`,

  'src/main.tsx': `import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
`,

  'src/App.tsx': `/**
 * Everything below is DERIVED from the backend declarations — the surface,
 * the search, the facet sidebar, the form. Register your own presenters to
 * replace the labeled scaffolding (see @active-drizzle/react docs).
 */
import React, { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Posts, usePostEditForm } from '../server/controllers/post.gen'

const qc = new QueryClient()

function Editor({ id }: { id: number }) {
  const { status, form: post } = usePostEditForm(id)
  if (status !== 'ready' || !post) return <p>loading…</p>
  return (
    <post.Form autosave>
      <post.SaveStatus />
      <post.title edit />
      <post.body edit />
      <post.published edit />
      <post.Changes />
      <post.Conflict>{(resolve) => (
        <span>
          Changed elsewhere.{' '}
          <button onClick={() => resolve('reload')}>Take theirs</button>
          <button onClick={() => resolve('overwrite')}>Keep mine</button>
        </span>
      )}</post.Conflict>
      <post.BaseErrors />
    </post.Form>
  )
}

export function App() {
  const [openId, setOpenId] = useState<number | null>(null)
  return (
    <QueryClientProvider client={qc}>
      <h1>${name}</h1>
      <Posts.Index>
        <Posts.Search placeholder="Search posts…" />
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
          <Posts.Sidebar />
          <div style={{ flex: 1 }}>
            <Posts.Items empty={<Posts.Empty />}>
              {(_post: any, row: any) => (
                <p>
                  <button onClick={() => setOpenId(row.id)}>{row.title}</button>
                  {row.published ? ' ✓ published' : ' · draft'}
                </p>
              )}
            </Posts.Items>
            <Posts.Pagination />
            {openId != null && <Editor id={openId} />}
          </div>
        </div>
      </Posts.Index>
    </QueryClientProvider>
  )
}
`,

  'README.md': `# ${name}

Generated by \`trails new\`. A working ActiveDrizzle app: PGlite (zero-setup
Postgres), one model, one controller — and everything else derived.

\`\`\`sh
npm install
npm run dev        # server :8787 + client :5173
\`\`\`

- **server/db/schema.ts** — the drizzle table (export name = canonical name)
- **server/models/Post.model.ts** — attributes, validations, scopes
- **server/controllers/Post.ctrl.ts** — the door: expose/permit/search/facets
- **trails.config.ts** — the ONE config file (env overrides inline; secrets
  via process.env — set REDIS_URL when you run more than one process)
- **src/App.tsx** — generated surface + form; register presenters to
  replace the labeled scaffolding

Generated files (\`server/controllers/*.gen.ts\`) are rebuilt by the vite
plugin — never edit them.
`,

  'scripts/regen.mts': `/**
 * Clean-room codegen without starting vite — fresh process, artifacts
 * swept first so the write-if-changed guard can't preserve stale output.
 */
import activeDrizzle from '@active-drizzle/core/vite'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
function sweep(dir: string) {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) {
    if (/\\.gen\\.(ts|d\\.ts|md)$/.test(f) || f === '_registry.gen.ts' || f === '_globals.gen.d.ts') {
      rmSync(join(dir, f))
    }
  }
}
sweep(join(ROOT, 'server/models'))
sweep(join(ROOT, 'server/controllers'))

const plugin: any = activeDrizzle({
  schema: 'server/db/schema.ts',
  models: 'server/models/*.model.ts',
  controllers: 'server/controllers/*.ctrl.ts',
  reactHooks: true,
})
plugin.configResolved?.({ root: ROOT })
await plugin.buildStart()
console.log('✓ regen complete')
`,

  '.gitignore': `node_modules
dist
*.gen.ts
*.gen.d.ts
*.model.gen.ts
*.model.types.gen.d.ts
`,
}

mkdirSync(dir, { recursive: true })
for (const [rel, content] of Object.entries(files)) {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

console.log(`✓ ${name} created (${Object.keys(files).length} files)`)
console.log('')
console.log(`  cd ${name}`)
console.log('  npm install')
console.log('  npm run dev     # server :8787 + client :5173')
if (linkPath) console.log(`\n  (framework linked from ${linkPath})`)
