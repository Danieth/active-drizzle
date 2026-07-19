# Getting started

ActiveDrizzle (soon: **trails**) — you declare the backend; the frontend
derives. Three files per resource in, a typed client + forms + faceted
index surfaces + permission-governed everything out.

## 1. One command

```sh
npx trails new myapp        # (--link <monorepo-path> while pre-release)
cd myapp
npm install
npm run dev                 # API :8787 + client :5173
```

That's a running app: PGlite (in-process Postgres, nothing to install),
one model, one controller, a searchable/faceted list with an autosaving,
conflict-aware form. Everything below explains what you're looking at.

## 2. The three files you write

**Schema** — a plain drizzle table. The EXPORT name is the canonical name
everywhere:

```ts
// server/db/schema.ts
export const posts = pgTable('posts', { id: serial('id').primaryKey(), … })
```

**Model** — data rules: attributes (codec + label + validation in one
declaration), associations, state machines, scopes, hooks:

```ts
// server/models/Post.model.ts
@model('posts')
export class Post extends ApplicationRecord {
  static title = Attr.string({ validates: Validates.presence() })
  static published = Attr.boolean()
  @scope static live() { return this.where({ published: true }) }
}
```

**Controller** — the DOOR: what leaves the server (`expose`), what may be
written (`permit`), what the list can do (`searchable`/`filterable`/
`facets`/`sortable`), concurrency (`optimisticLock`). Every allowlist here
is enforced server-side AND drives the generated client:

```ts
// server/controllers/Post.ctrl.ts
@controller('/posts')
@crud(Post, {
  index: { searchable: ['title'], filterable: ['published'], facets: true,
           sortable: ['updatedAt'], defaultSort: { field: 'updatedAt', dir: 'desc' } },
  get:    { expose: ['id', 'title', 'body', 'published', 'updatedAt'], abilities: true },
  create: { permit: ['title', 'body', 'published'] },
  update: { permit: ['title', 'body', 'published'], optimisticLock: true },
})
export class PostController extends ApplicationController {}
```

## 3. Everything generated lives in `.gen/` — import it from `@gen`

The vite plugin watches your three files and regenerates on save into
`.gen/` (gitignored — never edit, never commit):

```
.gen/
  models/        Post.model.gen.ts, *.types.gen.d.ts, _registry, index.ts
  controllers/   post.gen.ts, _coherence.gen.ts, _routes.gen.ts, index.ts
```

The plugin injects a vite alias and your tsconfig carries the matching
paths entry, so from ANYWHERE in the app:

```ts
import { Posts, usePostEditForm, PostController } from '@gen/controllers'
import { PostClient } from '@gen/models'
import { coherenceEdges } from '@gen/controllers'
```

No `../../server/controllers/…` paths, cmd-click jumps straight to the
generated file. `npm run regen` rebuilds clean-room without starting vite.
(tsconfig needs: `"baseUrl": ".", "paths": { "@gen/*": ["./.gen/*"] }`,
include `".gen/**/*"` — `trails new` sets all of it.)

## 4. Using what was generated

```tsx
// The index surface — zero hooks, every piece optional:
<Posts.Index>
  <Posts.Search />
  <Posts.Sidebar />                 {/* faceted panel: carets, live disjunctive counts */}
  <Posts.Items>{(post, row) => <p>{row.title}</p>}</Posts.Items>
  <Posts.Empty />  <Posts.Error />  <Posts.Pagination />
</Posts.Index>

// The form — fields ARE components; autosave, conflicts, permissions built in:
const { form: post } = usePostEditForm(id)
<post.Form autosave>
  <post.title edit />
  <post.published edit />
  <post.Changes />                  {/* "changed elsewhere → take theirs" floater */}
  <post.Conflict>{resolve => …}</post.Conflict>
</post.Form>
```

Every visible widget is either YOUR registered presenter or labeled
scaffolding (`data-ad-scaffold`) meant to be replaced — the framework
yields state, you own the pixels. See LLM-GUIDE.md for the dense
reference of everything else that's derived (boards, charts, metrics,
options pickers, @mutation buttons, `<Can>`, skeletons, contract probes).

## 5. Configuration — one file

```ts
// trails.config.ts — JS, not JSON; ONE file; envs are inline overrides
export default defineConfig({
  server:   { port: 8787 },
  channels: { bus: process.env.REDIS_URL ? 'redis' : 'memory' },
  environments: {
    production: { channels: { revalidate: 'always' } },
  },
})
```

Deep-merged by NODE_ENV at boot (objects merge, arrays/scalars replace).
Secrets are `process.env` REFERENCES — the file commits, values deploy.
Missing file = all defaults.

## 6. The loop

1. Edit schema/model/controller → save → codegen runs → typed client is
   current. (`npm run regen` if you ever suspect staleness.)
2. `npm run typecheck` — generated code is tsc-clean by contract; if YOUR
   code disagrees with a door, it fails here, not in production.
3. Security is metadata: `buildContractProbes(PostController)` derives the
   forge-every-field suite from the same config that enforces it — wire it
   into any test file and an empty failures array is a passing contract.
