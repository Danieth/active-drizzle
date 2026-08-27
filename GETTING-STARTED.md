# Getting started

ActiveDrizzle (soon: **trails**) — you declare the backend; the frontend
derives. Three files per resource in, a typed client + forms + faceted
index surfaces + permission-governed everything out.

## 1. One command

```sh
npx @active-drizzle/trails new myapp   # (--link <monorepo-path> while pre-release)
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
  channels: { bus: 'memory' },   // multi-process: 'redis' (set REDIS_URL)
  environments: {
    production: { channels: { revalidate: 'always' } },
  },
})
```

Deep-merged by NODE_ENV at boot (objects merge, arrays/scalars replace).
Secrets are `process.env` REFERENCES — the file commits, values deploy.
Missing file = all defaults.

Advanced, per-door: `wire: 'columnar'` on a `@crud` config flips that one
door (server + its generated hooks together) onto the normalized columnar
envelope — entity-store-backed live rows, per-row version tokens, smaller
raw payloads (compressed sizes are ~parity), same hook API.
Default is `'nested'`; migrate door by door. Details: LLM-GUIDE §3.5.

## 6. Live channels (WebSocket)

Doors with `wire: 'columnar'` also push live updates: the scaffold
attaches a WebSocket gateway to the **same** HTTP server at `/cable`
(configurable via `channels.path`) and mounts `POST /cable/token` — a
one-time, ~10s upgrade token minted through your own auth (the same
`contextFor` the `/rpc` handler uses; there is no second auth system).
You enable nothing: `trails new` boots with channels live on the
in-memory bus.

What operators must know, compressed (full manual: `docs/guide/channels.md`):

- **Push is latency, pull is correctness.** Delivery is best-effort, no
  outbox — a lost frame heals on the client's next revalidation pull.
  Killing the socket layer loses liveness, never data.
- **`bus: 'memory'` (default) is single-process.** Two API processes on
  it means a write on one is not pushed to sockets on the other (they
  stay eventually-fresh via pull). Multi-process: set `REDIS_URL` and the
  scaffold config selects `bus: 'redis'` — ids-only commit events over
  Redis pub/sub, at-most-once **by design** (pull is the replay; nothing
  to drain or reconcile), reconnects self-heal with the gap healed by
  pull. That env-keyed selection is a convenience with a sharp edge —
  boot logs the resolved tier, and once production depends on redis, pin
  `bus: 'redis'` explicitly so a vanished `REDIS_URL` refuses to boot
  instead of silently degrading to single-process `memory`. No Redis?
  `bus: 'pg-notify'` is the fallback — Postgres NOTIFY,
  needs a session-mode connection (PgBouncer transaction pooling breaks
  LISTEN; a boot probe refuses loudly); `class 1262 … database 0` lock
  waits are its saturation signal to move to redis. `'nats'` is a
  teaching stub that throws; implement `ChannelBus` and pass it to
  `attachChannels({ bus })`.
- **Production refuses to boot without `channels.originAllowlist`** —
  the Origin check is what stops cross-site WebSocket hijacking.
- Frames are door-projected with a silence rule (a change outside
  `expose` publishes nothing); permission changes take effect within
  `revalidate` seconds (default 30, `'always'` = paranoid) via a RESET
  frame, never a silent drop.
- 25s heartbeats sit under proxy idle timeouts (Cloudflare 100s,
  ALB/nginx 60s); deploys drain with close 1001 → clients fast-reconnect
  and revalidate. Behind a load balancer, token mint + upgrade must hit
  the same process (sticky sessions) for now.

## 7. The loop

1. Edit schema/model/controller → save → codegen runs → typed client is
   current. (`npm run regen` if you ever suspect staleness.)
2. `npm run typecheck` — generated code is tsc-clean by contract; if YOUR
   code disagrees with a door, it fails here, not in production.
3. Security is metadata: `buildContractProbes(PostController)` derives the
   forge-every-field suite from the same config that enforces it — wire it
   into any test file and an empty failures array is a passing contract.
