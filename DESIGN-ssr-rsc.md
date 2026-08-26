# DESIGN — SSR/RSC: What Actually Happens (find-out-and-document pass)

### Status: FINDINGS · 2026-08-26 · closes REMAINS-FOR-LAUNCH "Onboarding truth"
### SSR/RSC pass (reviewer #8). This is a report of what the code DOES today,
### not a proposal. Evidence read from packages/* and the demo app.

## 0. The verdict in one table

| Surface | In Next.js/Remix/RR SSR today | Why |
|---|---|---|
| Server runtime (models, boot, transactions) | **Works** (Node runtime only; not edge) | plain Node modules; ALS; no Vite coupling |
| Hono adapter / oRPC handlers | **Works** — already runs Vite-free in the demo | `server/main.ts` is a standalone Node process |
| Codegen without Vite | **Works** — headless entry exists and is scaffolded | plugin's `buildStart()` imports zero Vite |
| Envelope over the wire | **Works** — it IS the designed wire shape | JSON-plain by construction |
| Passing a live record across the RSC boundary | **Breaks loudly** | Proxy-wrapped class instance; RSC rejects it |
| `@active-drizzle/react` imported from RSC | Imports cleanly, unusable there; no `'use client'` anywhere | hooks/factories, guarded browser access |
| Generated hooks (`.gen/controllers/*.gen.ts`) in RSC | **Breaks** in practice | imports app `_client` (demo touches `window` at module scope) |
| Edge runtime | **Out** | core's root import drags `ts-morph`/`fs` |
| `next dev` HMR | Safe IF core is externalized; silent trap if bundled | module-global db binding, no cross-copy guard |

The honest one-liner: **the server half and the wire were never Vite-coupled —
what's missing is packaging hygiene and a written recipe, not architecture.**

---

## 1. Proxy records across the hydration boundary

Every record instance is a Proxy from birth — the constructor returns
`_wrapRecord(this)` (packages/core/src/runtime/application-record.ts:359; the
Proxy construction is application-record.ts:1885, get trap :1886–2021, set trap
:2023–2063). Dirty tracking lives in a `Map` (`_changes`, set trap
:2044–2061); associations, state-machine events (`canSubmit()`/`submit()`,
:1937–1953), enum predicates (:1956–1977), and `<f>Changed/Was/Change` helpers
(:1996–2011) are all synthesized by the get trap — none exist as own
properties.

**RSC payload**: a record is a class instance behind a Proxy with a `Map`
field and bound methods. React's flight serializer rejects non-plain objects —
passing one from a server component to a client component throws Next's "Only
plain objects can be passed to Client Components." It does not silently
degrade; it refuses.

**JSON.stringify / SSR-serialized JSON**: survives via `toJSON()`
(application-record.ts:915–945) → a plain object of attributes in DISPLAY
space (Attr codecs applied — money as dollars, enums as labels; `attributes`
getter :885–902 runs dirty values through the same codec :897–900).
Eager-loaded associations embed via `toJSON({ include })` (:928–943). What
does NOT survive revival: every method, lazy association access, `can()`,
dirty-tracking provenance (`was`/`is`), `errors`, `isNewRecord`. The revived
value is data, not a record.

**Is this moot? Largely yes — the envelope is the intended wire shape.**
Controllers never ship records; they ship
`{ record, abilities, can, why?, issues?, version?, ctx? }`
(`RecordEnvelope`, packages/controller/src/crud-handlers.ts:23–38), where
`record` is `toJSON()` through the `expose` ceiling
(crud-handlers.ts:293–298) and everything else is JSON-plain by construction.
The client side (`FormSession`, `ClientModel`, generated hooks) consumes
envelopes, never live records. The rule to document: **records live and die
server-side; the envelope crosses the boundary.** A raw record handed to a
client component is the anti-pattern, and RSC enforces that for us.

Cross-ref: Tier 2 "proxy → generated-real migration"
(REMAINS-FOR-LAUNCH.md:189–195) would replace the Proxy with generated
prototype methods — it changes none of the above (still a class instance),
so the envelope rule stands either way.

## 2. boot() placement in a Next.js server runtime

State is module-global: `_activeDb`/`_schema`
(packages/core/src/runtime/boot.ts:19–20), `_databases`/`_tableDb` (:28–29),
`MODEL_REGISTRY` (:56). `boot()` itself (:86–94) is plain reassignment — **no
double-boot guard, and none needed**: calling it twice with the same args is
idempotent. Queries without boot fail with a teaching error
("call boot(db, schema) before querying", :102–107).

**AsyncLocalStorage**: imported from `node:async_hooks` (boot.ts:1) for
transaction context (:11,17,34,197). Fine in the Next Node runtime.
Irrelevant on edge because core can't load there anyway (§ below).

**The real hazard is module duplication, not re-boot.** Whichever copy of
`boot.ts` runs `boot()` is the only copy that can query. Three ways to get two
copies:
1. **Bundled-into-RSC copies across recompiles**: `next dev` re-evaluates the
   bundled module graph per compile; a fresh graph has `_activeDb = null`. If
   core is bundled (Next's default for server components), boot() must be a
   side effect of a module every querying route imports (the db module
   pattern), or dev shows phantom "call boot() first" after edits.
   **Mitigation that makes it a non-issue**: `serverExternalPackages:
   ['@active-drizzle/core']` — externalized packages come from Node's module
   cache, which survives recompiles.
2. **Dual-package hazard**: core ships both `import` and `require` builds
   (packages/core/package.json exports: `dist/index.js` + `dist/index.cjs`).
   One ESM consumer + one CJS consumer in the same process = two `_activeDb`s.
3. **Two package names**: generated model code hard-imports
   `from 'active-drizzle'` (packages/core/src/codegen/generator.ts:99,399;
   visible throughout the demo's `.gen/models/`), while apps also import
   `@active-drizzle/core`. The demo maps both names to the same folder via
   `file:` deps (active-drizzle-demo/package.json) so they dedupe by realpath.
   An npm consumer needs the same alias
   (`"active-drizzle": "npm:@active-drizzle/core@x"`) or gets a resolution
   error — not two instances, but a confusing first-run failure.

**Model registration**: `@model` registers the class at decoration time —
i.e., at import (packages/core/src/runtime/decorators.ts:49–57). The generated
`_registry.gen.ts` barrel imports every model (demo:
`.gen/models/_registry.gen.ts`) — the Next recipe must import it (or all
models) alongside boot, exactly like the demo's `server/main.ts` (boot at
:216 after importing models). Also note boot()'s attachment-registry wiring is
a fire-and-forget dynamic import (boot.ts:91–93) — a theoretical race if the
first query needs attachments in the same tick; never observed, worth a line
in code review someday, not a launch item.

**Edge runtime: out, and not because of ALS.** Importing
`@active-drizzle/core` at all executes `ts-morph`, `fs`, `path`, `crypto`,
`async_hooks` (verified in the shipped `dist/index.js` import list). The root
index re-exports the presenter pipeline
(packages/core/src/index.ts:18 → codegen/presenter-pipeline.ts, which value-
imports ts-morph via presenter-context-generator.ts:23 etc.). So the runtime
story is: **Node runtime routes only**, and mark core external so the server
bundle doesn't swallow a TypeScript compiler.

## 3. Headless codegen outside Vite

**Exists and is the blessed path already.** The "Vite plugin" is a plain
object factory that never imports `vite` (packages/core/src/vite/index.ts:22–41
— ts-morph, fs, path, glob, codegen modules only). Its hooks: `config` (:560 —
injects the `@gen` alias, :564), `configResolved` (:567), `buildStart` (:571 —
the entire pipeline), `configureServer` (:581 — only the watcher/HMR part is
Vite-bound). The demo's `scripts/regen.mts` calls
`plugin.configResolved({ root }); await plugin.buildStart()` in plain Node
(active-drizzle-demo/scripts/regen.mts:35–42), and `trails new` scaffolds
exactly that script plus the `"regen": "tsx scripts/regen.mts"` npm script
(packages/trails/bin/trails.mjs:152, 559–589). A Next app runs `npm run regen`
(watch mode: rerun on save, or chokidar — the watcher is the only piece Vite
currently provides).

**Do generated files need the `@gen` alias?** The generated files themselves —
no. Verified across the demo's `.gen/`: every import is either relative
(`./deal.gen`, `../../server/models/X.model.js`, `../../server/controllers/_client`)
or a bare package (`@active-drizzle/react`, `@tanstack/react-query`, `react`,
`active-drizzle`). `@gen/*` is app-facing sugar, injected as a Vite alias
(vite/index.ts:564) and mirrored in tsconfig paths (documented at
vite/index.ts:66–69; demo tsconfig has `"@gen/*": ["./.gen/*"]`). **Next.js
resolves tsconfig `paths` natively**, so `@gen/*` works there with zero extra
config beyond the tsconfig entry the docs already require. The two genuine
setup requirements for compiling model files in a Next app: tsconfig
`experimentalDecorators: true` + `useDefineForClassFields: true` (demo
tsconfig:9–10) — Next's SWC honors both from tsconfig — and the
`'active-drizzle'` name alias from §2.3.

## 4. @active-drizzle/react server-safety

**No `'use client'` anywhere** — not in `packages/react/src/*`, not in the
built `dist/index.js` (verified by grep), not in generated
`.gen/controllers/*.gen.ts` files.

**Module scope is clean.** The only `window` access is inside a `useEffect`
behind `typeof window === 'undefined'` (packages/react/src/form-handle.tsx:824–831);
`EventSource` is feature-guarded (packages/react/src/coherence.ts:106); no
`localStorage`, `document`, or `import.meta.env` anywhere in
react/controller/core-runtime src. So **importing `@active-drizzle/react` from
an RSC file does not crash** — it just gives you hooks and factories that are
useless there (every meaningful export needs React state/TanStack Query
context). Two module-scope singletons are worth naming for the SSR-with-
hydration case: `entityStore` (packages/react/src/entity-store.ts:211) and
`defaultDraftStore` (packages/react/src/draft-store.ts:64) — per-process on a
server, i.e., cross-request identity bleed IF client hooks ever executed
during SSR. Today nothing server-side touches them; the documented rule
("hooks are client components") keeps it that way.

**The practical breakage is the app's `_client.ts`.** Generated hooks import
it at module scope (react-generator.ts:407; demo:
`.gen/controllers/deal.gen.ts` imports `../../server/controllers/_client`).
The codegen-scaffolded stub is inert (`export const client: any = null`,
react-generator.ts:1102–1124, user-owned via `skipIfExists`,
:162–166) — but the demo's real one does
`window.location.origin` and `localStorage.getItem` **at module scope**
(active-drizzle-demo/server/controllers/_client.ts:9–10). Any server-side
import of a generated hooks file in that pattern dies with
`window is not defined` before React is even involved. Since the demo is the
copy-from reference, this is effectively the default failure mode.

## 5. The Hono adapter outside Vite

Nothing Vite-coupled — confirmed line by line
(packages/controller/src/adapters/hono.ts:27–101): it returns plain
`{ method, path, handler }` descriptors; handlers use only the Hono context
(`c.req.param/query/text`) and WHATWG `Response.json` (Node ≥18); Hono itself
is deliberately not a dependency (:18–25); the one dynamic import is
`@orpc/server` (:119). It runs identically under `@hono/node-server`,
`hono/vercel` inside a Next route handler, or Bun. **The demo's API server is
already a standalone Node process** — Hono + `RPCHandler` + `serve()`
(active-drizzle-demo/server/main.ts:13–14, 463, 497); Vite only dev-proxies
`/rpc`, `/api`, `/live` (vite.config.ts `server.proxy`). The framework's
server half has never actually run inside Vite.

---

## 6. The supported story to document (honest guidance, today's code)

1. **Architecture**: ActiveDrizzle is backend + wire + client hooks. The
   backend (boot, models, controllers, Hono/oRPC) is plain Node — run it as a
   standalone server (demo pattern) or inside Next Node-runtime route
   handlers. The client packages are client-component-only. The envelope is
   the only thing that crosses.
2. **Records never cross the RSC/hydration boundary.** Serialize with
   `toJSON()` / ship envelopes. RSC enforces this with a hard error; that
   error is correct behavior, document it as such.
3. **Next.js recipe**: Node runtime (`export const runtime = 'nodejs'`);
   `serverExternalPackages: ['@active-drizzle/core']`; boot as a side effect
   of a `db.ts` imported by every querying entry, plus the `_registry.gen`
   model barrel; tsconfig `paths` for `@gen/*`, `experimentalDecorators`,
   `useDefineForClassFields`; alias `active-drizzle` → `@active-drizzle/core`;
   codegen via `npm run regen` (no Vite needed); mount the API via Hono in a
   route handler or keep the standalone server.
4. **Edge runtime: unsupported.** Say so plainly (core's root import includes
   ts-morph/fs).
5. **What you give up vs the Vite SPA path**: the file-watcher regen loop and
   the injected `@gen` alias — both one-liners to replace.

## 7. What SSR support would actually need (sized)

- **S — the recipe doc itself** (§6 as a README/docs page; it is wiring, not
  code). The launch tracker item is satisfied by this file + that page.
- **S — SSR-safe `_client` reference pattern**: guard `window`/`localStorage`
  in the demo's `_client.ts` (:9–10) and note it in the stub's comment
  (react-generator.ts:1103–1120). Removes the #1 real crash.
- **S — `'use client'` banners**: build-banner on `@active-drizzle/react` dist
  and a header line in generated `*.gen.ts` hook files (react-generator.ts
  emits the header at the top of `generateControllerFile`). Makes Next place
  the boundary correctly and fail teachably instead of at `_client`.
- **M — split codegen off core's root export**: move
  `runPresenterPipeline`/presenter-* re-exports (packages/core/src/index.ts:12–20)
  to a `@active-drizzle/core/codegen` subpath so importing `boot` stops
  dragging ts-morph/fs into server bundles. Prereq for any edge story;
  independently good for cold-start.
- **M — first-class headless regen command** (`trails regen [--watch]`
  wrapping what scripts/regen.mts does, chokidar for watch): removes the
  scaffolded-script dependency for non-Vite apps.
- **L — RSC-native data path** (server loaders producing envelopes consumed
  in-process, TanStack hydration): NOT needed for "works in Next" and not
  designed here — recorded only so nobody mistakes its absence for a blocker.
