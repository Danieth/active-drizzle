# REMAINS FOR LAUNCH

The single source of truth for shipping ActiveDrizzle/trails. Ordered by
blocking tier. Every item traces to a verified finding (mega-scan 2026-08-26,
reviewer launch list, DX field reports, query-algebra audit). Check items off
here as they land; don't spawn parallel trackers.

Legend: 🔴 blocks launch · 🟠 should-fix pre-launch · 🟢 post-launch, non-breaking
Suites baseline at time of writing: core 1098 / controller 299 / react 251.

---


## STATUS (2026-08-26 evening — through commit 11ec88e)

Two burn-down waves + an adversarial merged-tree review, all suites green.
Checked boxes below are VERIFIED landed (regression-test-first, adversarially
reviewed, full-suite gated). Wave-2 core-tx + codegen clusters are merging
(phantom-create restore, real savepoints, db-aware tx gates, inBatches
composite-PK, react-generator escaping twins, watcher red-gate, unlink
sweep, STI self-import).

STILL OPEN — tracked residuals (source in parens):
- [x] TAXONOMY THREADING in application-record.ts: switch validate to
      runValidatorsDetailed; code the implicit not-null ('blank'),
      state-machine ('invalid_event'/'invalid_transition'), nested
      ('nested_invalid'), and translateDbError.errorCode sites. Foundation +
      wire + controller lane landed (b684e83, 11ec88e). (mine, post-merge)
- [x] GENERATOR BARE-NAME EMISSIONS: generator.ts:99,399 emit
      `from 'active-drizzle'` into generated code — masked in the demo by a
      legacy dual-alias dep; a FRESH scaffolded app breaks on first regen.
      (SSR/RSC pass, post-codegen-merge)
- [ ] IDENTIFIER-POSITION ESCAPING (both generators): a label/event with
      non-identifier chars breaks generated METHOD NAMES
      (`statusIsWon'tFix()`); string-literal positions are now escaped, but
      identifier positions need sanitize-or-refuse. (wave-2 codegen fixer)
- [x] _KEY SERVER ECHO: the client matches nested new-row ids by `_key`, but
      no server component echoes it — adoption is inert; wrong-id graft
      reachable when echo order diverges. Needs core `_processNestedAttributes`
      to surface created id↔_key pairs + envelope threading. (merged-tree review)
- [ ] PER-FIELD commitField ENGINE × submit(): unserialized in both
      directions (submit awaits only autoFlushPromise) — the remaining
      self-409 path. (wave-2 react reviewer, pre-existing)
- [ ] TRANSIENT DOUBLE-ROW on echo-raced instant create (server copy +
      optimistic pending child until POST settles) — cosmetic, no
      double-persist. (wave-2 react reviewer)
- [ ] OFFLINE pendingFlush leak: a queued offline flush mooted by a manual
      submit leaves hasPending() reporting 'offline'. (wave-2 react fixer)
- [ ] CODEC READ-SIDE COHERENCE: write boundary is genuine; toJSON/get-trap/
      defaults still inline `attr._column ?? key` — behavior correct+tested,
      DRY cleanup only. Delete dead toDisplayValue/attrConfigFor if unused
      after. (wave-1 review)
- [ ] SCALAR AGGREGATE UNITS: sum/avg return raw DB units for codec fields —
      pinned tests + documented intent say raw is BY DESIGN; needs Daniel's
      cross-cutting call, not a unilateral flip. (wave-1, unchanged)
- [ ] BLIND-INDEX WIRING: format is DECIDED IN CODE (versioned envelope,
      keyId rotation, HMAC-SHA256 over trim/lowercase, truncation knob) and
      the carve-out is ENFORCED at buildRouter; remaining: the
      `blindIndex: 'colBidx'` digest-column write path + where() equality
      rewrite + codegen schema validation. (DESIGN-field-encryption §2)
- [ ] SSR PACKAGING (S): 'use client' banners on react dist + generated
      hooks; SSR-safe `_client.ts` reference; the Next recipe doc. (M):
      split codegen exports off core's root (edge unlock);
      `trails regen --watch`. See DESIGN-ssr-rsc.md. (SSR/RSC pass)
- [ ] SINGLETON READ CEILING (SingletonConfig.get.expose) — now load-bearing:
      encrypted models REFUSE singleton doors until it exists. (Tier 2 item,
      promoted by the carve-out)
- [ ] @transactional DECORATOR still db-blind: calls transaction() with no
      { database }, so a bound-model method under it gets a default-db wrap —
      no atomicity regression (each save opens its own wrap), but no
      cross-statement atomicity on the bound db either. (core-tx reviewer)
- [ ] COVERAGE GAPS from the core-tx review: destroy()-in-ambient-same-db-tx
      restore leg; NULL lock-value teaching error; inner-commit afterCommit
      fires exactly once at outermost commit on the REAL driver. (core-tx
      reviewer)
- [ ] STI DISCRIMINATOR condition now in 4 places (validation mirrors
      save/insertAll/_buildFinalWhere by comment, not helper) — extract one
      `stiDiscriminatorColumn(ctor)`. (core-tx reviewer DRY nit)
- [ ] `helpers` package: publish or stop documenting. (Daniel's call)
- [ ] Mismatched-lock-column teaching error and confirm-route save gate:
      LANDED 11ec88e (wave-2 controller reviewer follow-ups).

## TIER 0 — 🔴 CANNOT SHIP WITHOUT (correctness + installability)

### The codec chokepoint (ONE refactor kills 8 confirmed bugs)
The property↔column name and display↔raw value mapping is re-implemented per
path instead of at one boundary. `save()` does it right; every other path forks.
- [x] Define ONE mapping boundary (property→`_column`, value→codec, dirty-track)
      that every write/read path crosses.
- [x] `updateAll` — keeps property name, drops `Attr.money('priceCents')` writes
      (relation.ts:1054). Route through the boundary.
- [x] `insertAll` — drops `_column` mapping, skips Attr defaults, omits STI
      discriminator stamp (application-record.ts:293).
- [x] INSERT defaults loop — writes default under property name → dropped by
      drizzle; implicit not-null validation then vouches for the unfilled column
      (application-record.ts:598). **Data-integrity: NULL into NOT NULL.**
- [x] `find()` — forks the read pipeline: no STI type scoping (a subclass can
      `find()` a sibling's row), no default scopes, no subclass resolution
      (application-record.ts:250). Route through Relation.
- [~] `aggregates`/`tally()` return raw DB units (cents, enum ints) while every
      other read lane returns model units — AND `tally()` bypasses the encryption
      guard (decrypted plaintext labels). [tally guard FIXED; raw units are
      DOCUMENTED DESIGN per Attr.percent + pinned tests — flip needs Daniel]
- [x] `toJSON`/`attributes` serialize dirty fields in raw space (cents leak).
- [x] `restoreAttributes()` writes display-space `_was` values back into raw
      `_attributes` — corrupts the codec on the record.

### Atomicity
- [x] Wrap `save()` in a transaction (application-record.ts:640). Today: parent
      INSERT commits, then nested/habtm/counters/autosave run un-wrapped; a forged
      child id commits the parent + earlier children then returns a lying 422 →
      **duplicate rows on resubmit.** This is also the realtime foundation.
- [x] `destroy()` cascade is not transactional — children destroyed, then a
      failing parent DELETE strands them.
- [x] Nested child `update()` results are discarded (application-record.ts:1538) —
      invalid child edits return 200 and vanish. Check the boolean.

### Error taxonomy (root cause of the 500-not-422 family; reviewer blocker #4)
- [x] `ApplicationRecord.create` throws stringly `Error('Validation failed: '+JSON)`
      (application-record.ts:285) → `defaultCreate`'s 422 branch is DEAD CODE and
      its covering test is theater (crud-handlers.ts:778). CREATE validation
      failures surface as **HTTP 500**.
- [x] Same root cause kills `singletonFindOrCreate`'s 23505 race recovery
      (crud-handlers.ts:1209) — the catch matches a message that never arrives.
- [x] Ship stable machine-readable codes on every error (`code: 'blank' | 'taken'
      | 'too_long' | ...`). Breaking to add later; layered auth gates get
      structured rejections for free. Design the taxonomy once.

### Concurrency
- [x] `withLock` acquires NO lock: `_clone()` copies 9 flags but not `_forUpdate`,
      and `first()/take()/exists()` all clone (relation.ts:1315). The documented
      `locked.first()` emits a plain SELECT. Add `_forUpdate` to `_clone`.
- [x] Same `_clone` gap silently reverts `unscoped()` (`_skipAllDefaultScopes` /
      `_excludedDefaultScopes` not copied) — `unscoped().first()` re-applies
      scopes while `unscoped().count()` doesn't. Contradictory answers.
- [x] Optimistic lock is check-then-act, not CAS: `save()`'s UPDATE WHERE has only
      the pk, no version predicate (application-record.ts:628). Two stale writers
      both pass. **The coherence proofs rest on this.** Add version to the WHERE.
- [x] `afterCommit` callbacks in nested transactions are silently discarded
      (boot.ts:200) — inner queue never merged into outer. Merge on nested commit.

### Installability (the framework cannot be installed today)
- [x] npm identity: apps depend on bare `active-drizzle` (unpublished); package is
      `@active-drizzle/core`. Every scaffold, all generated code, LLM-GUIDE imports
      the wrong name (trails.mjs:135). Pick ONE published name, thread it
      everywhere.
- [x] `npx trails new` resolves to a STRANGER'S `trails` package on npm. Publish
      under a real bin name or document `npx @scope/trails`.
- [ ] `helpers` package documented as installable, never published; release script
      excludes it. Publish or stop documenting.
- [x] Controller-concern system (`defineControllerConcern`, `@includeInController`,
      `Searchable`) documented but NOT exported from the package entry — unreachable
      (controller/src/index.ts). Export or delete the docs.

---

## TIER 1 — 🟠 SHOULD-FIX BEFORE LAUNCH (breaking, security, or first-impression)

### Codegen soundness (the extractor lies on legal input)
- [x] Watch-mode serves STALE ASTs forever: ts-morph returns cached SourceFile
      without re-reading disk; `.ctrl.ts`/`.model.ts` edits silently ignored
      (controller-extractor.ts:27, extractor.ts). `refreshFromFileSystemSync()` per
      changed file.
- [x] Model-file deletion never regenerates: only `change`/`add` watcher events
      registered, no `unlink` (vite/index.ts:561).
- [x] Spread properties in `pgTable()` dropped silently — the Drizzle-recommended
      shared-columns pattern (`...timestamps`) loses columns (extractor.ts:73).
- [x] App strings interpolate into generated source with naive quoting: an enum
      value/key with an apostrophe/hyphen produces invalid generated code
      (generator.ts:815, react-generator.ts:1741). **Code-injection-shaped.** Escape.
- [x] Nested model dirs (the documented glob `**/*.model.ts`) generate wrong
      back-imports + silent same-basename collisions (vite/index.ts:310).
- [x] `extractModel` reads only `getClasses()[0]` — a co-located STI subclass (the
      layout the bug-#6 guard endorses) is invisible (extractor.ts:257).
- [x] Chained Attr modifiers drop client-side VALIDATIONS:
      `extractPropertyValidations` never unwraps the chain (extractor.ts:1004) —
      `resolveAttrCall` fixed fieldMeta/defaults but not this.
- [x] **Codegen has no failure channel** (Q2 design violation): diagnostics
      `console.log`, then generation proceeds ON RED and writes files from invalid
      meta (vite/index.ts:293). "Errors that teach" must apply to the framework's
      OWN build — a hard error mode that refuses to emit.
- [ ] Generated output `tsc --noEmit` clean + a CI gate that regenerates fixtures
      and typechecks them (BEFORE_LAUNCH §1: dangling-import, `id?`, `Function.name`).

### Boundary correctness
- [x] Controller reads `model.name` in ~10 places (router.ts:528) — the framework's
      own #1 rule. 404s say "[object Object] not found"; attach presign breaks on
      any model with a `name` Attr. Use `modelClassName()`.
- [x] Bulk mutation with `ids: []` operates on the ENTIRE door scope (router.ts:313,
      zod accepts empty array). `.min(1)` or treat empty as no-op per `records`.
- [x] `nestedAutoSet` read from create-config on create, update-config on update
      with no fallback (crud-handlers.ts:835) — LLM-GUIDE's canonical example
      declares it only under `create`, reopening the forged-fk gap on every edit.
- [x] Per-field autosave success clobbers concurrent edits via full `applyEnvelope`
      (form-session.ts commitField) — use the applyFlushSuccess narrow path.
- [x] Conflict bookkeeping survives resolution: `adoptIncoming` after settle rolls
      the version token BACKWARD (form-session.ts:890). Clear on submit success.
- [x] Nested new-row ids adopted POSITIONALLY (nested.ts:398) — wrong-record writes
      when echo order diverges. `_key` is sent but never used to match. Match by `_key`.
      [CLOSED end-to-end 16d3fb7: core records id↔_key, envelope stitches, client matches]
- [x] Parked nested edits dropped: `restoreParked` runs before lazy nested-manager
      registration (generated-form.ts:92).
- [x] `last()` after explicit `.order()` emits invalid SQL `col asc desc`
      (relation.ts:564) — the reversal test on stringified drizzle objects can never
      fire. Reverse via the order-spec list, not string matching.
- [x] `inBatches` skips half the rows under a mutating callback (its own docstring
      example) + no ORDER BY (relation.ts:1117). Use keyset (`seek`) not limit/offset.

### The encryption × permissive-default hole (doctrine carve-out)
- [x] An ungoverned door (no `get.expose`) serializes EVERY column, and `Attr.get`
      has already DECRYPTED encrypted fields → ships plaintext PII, and the
      permissive-by-default doctrine forbids the warning. **Carve-out**: permissive
      is fine UNTIL a column is `.encrypt()`'d; then absence of a ceiling is a
      teaching error, not a default.
- [ ] Encryption storage format + blind indexes: `.encrypt({ blindIndex: true })`
      generating a digest column so encrypted tokens stay queryable by equality.
      Format is FOREVER — decide pre-launch (reviewer #6).

### Onboarding truth
- [x] SSR/RSC find-out-and-document pass: proxy records across the hydration
      boundary, `boot()` placement, headless codegen outside Vite (reviewer #8).
- [x] Verify + close BEFORE_LAUNCH §2 (no-error-leak) — the hono 500 path already
      satisfies it (tested); confirm and check the box.

---

## TIER 2 — 🟢 POST-LAUNCH, NON-BREAKING (the DX epoch + query algebra + exceed moves)

### The proxy → generated-real migration (Rails' method_missing → defined-methods move)
- [ ] Generate real accessors/predicates/transition methods onto each prototype at
      boot (from a `.gen` module), delete the Proxy. Kills the type-lie drift class,
      IS the clean delivery of the codec chokepoint, restores stack traces /
      breakpoints / `console.log` / spread / DevTools, removes trap-deopt perf work.
      Migrate the 3 dynamic trap behaviors (`<assoc>Attributes`, habtm `<x>Ids`,
      unknown-column passthrough) to explicit installed handlers. Whole suite is the net.

### Query algebra (breadth ~90%, algebra ~60% — finish the composition layer)
- [ ] `whereNot({...})` — negate a whole condition group (today: per-field ops only).
- [ ] `or(relation)` — OR two independently-built relations (`whereAny` only does
      hash-OR).
- [ ] `merge()` / `rewhere` / `reorder` / `except` — relation combinators.
- [ ] `upsert` / ON CONFLICT on `insertAll` — the first import pipeline hits this.
- [ ] A WRITTEN VERDICT on joins: subquery-first is defensible, but
      "aggregate-across-association by a target column" is currently inexpressible
      without `toSQL`. Either declare the doctrine loudly + document the subquery
      pattern, or add a deliberate join surface. Right now it's neither.
- [ ] Custom primary keys: work in the model layer + docs but impossible through
      `@crud` (routes hardcode numeric `id`). Thread the opaque-token PK design.

### The DX epoch (field-report list — "same taste, one layer out")
- [ ] `createTestApp()` — booted routers + typed impersonating door-caller
      (`t.as(ada).deals.index()`) + seed helpers + envelope unwrap. The route-level
      `call()` pattern is already the core. Hand-rolled suites caught 2 shipped
      security bugs — make that style nearly free.
- [ ] The "why" panel / field inspector (DESIGN-presenter-tree §10, already spec'd):
      hover a field → which presenter, which kind, which layouts, which permit line.
      Click a greyed button → the guard that said no. All data already computed.
- [ ] `trails dev` — one verb owning both processes + auto-port + persistent dev DB
      (PGlite file-backed: one config option; server edits stop erasing state).
      TRIM the vite module-graph-wedge overlay (fighting someone else's toolchain);
      keep the doctor-in-watch "dist changed under a running app — restart" notice.
- [ ] Dev-DDL derivation: emit `CREATE TABLE` from schema meta for the PGlite dev
      lane (kills the demo's hand-written DDL). Governed migrations STAY delegated
      to drizzle-kit (defer-to-drizzle doctrine).
- [ ] `trails check` — one CI verb: laws + typecheck + doctor + probes composed.
- [ ] Clickable `file:line` in every teaching error (most already name files).
- [ ] A minimal MCP server in the trails package: read layer over USING.gen.md /
      _routes.gen.md / manifest / registry + capability queries + structured report
      intake. Projection, not new truth — passes the golden rule. Capstone, last.

### The three "exceed" moves (uniquely positioned)
- [ ] Compile doors INTO Postgres: derive RLS policies + per-door views + column
      grants from `expose`/`permit`/`scopeBy`. The DB enforces the door even if the
      app is bypassed. No framework does this because none owns a validated door model.
- [ ] Content-addressed protocol manifest: hash `ProjectMeta` into every artifact +
      the envelope. ONE hash closes gen-staleness, deploy skew, and router↔codegen
      conformance. `generate()` is already pure. Also fixes: boot never verifies the
      live DB against the booted schema; deploy skew has no reload handshake.
- [ ] Event-sourcing-lite on the unified write path: `previousChanges` alive at
      `afterCommit` is a complete CDC point — generate history/audit surfaces +
      point-in-time envelopes. Same consumer feeds webhooks AND realtime frames.

### Realtime / webhooks (blocked on Tier 0 atomicity + CAS + afterCommit — build after)
- [ ] Wire entity-store slice 1: responses normalize into the store (`mergeRows`),
      row handles read through `useEntity` + `composeEntity`. Makes the app
      realtime-SHAPED with zero sockets.
- [ ] WS channels build (DESIGN-ws-channels): afterCommit consumer computing
      `changedFields ∩ each door's projection`, emitting `store.merge()` frames;
      Redis bus for multi-process (`bus` config already exists); silence rule.
- [ ] Webhooks: the SAME afterCommit consumer over HTTP instead of a socket.

### Smaller confirmed bugs (medium tier — batch when touching the area)
- [ ] Cached `ModelMeta` mutated in place — association resolution frozen at first
      computation.
- [x] `columnToClientType` is a forked weaker copy of `COLUMN_TS_TYPE` (bigint typed
      `number` client-side vs `string` server-side) — fold into the one map.
- [ ] pgEnum columns extracted as NOT NULL unconditionally — nullable enums get
      lying types.
- [ ] Drizzle `$defaultFn`/`$default`/`$onUpdate` not recognized as defaults —
      DB/client-defaulted columns become required in generated Create types.
- [ ] `@validate`/`@serverValidate`/`beforeValidate` ignore their `if:`/`on:` options.
- [x] `PresenterContextProvider` rebuilds bag + layout-stack identity every render —
      app-wide field re-render storm. Memoize.
- [ ] Instant nested patch/create `resetBaseline()` wipes unrelated staged edits on
      the same row.
- [x] Index context memo omits `isFetching` — the keepPreviousData "refreshing"
      signal doesn't propagate to the compound surface.
- [x] `useUploadFactory` has no run-generation guard — a superseded upload corrupts
      the replacement's state.
- [x] `submit()` races an in-flight `autoFlush` — self-inflicted 409.
- [ ] `commitField` failure rollback erases keystrokes typed during the flight.
- [ ] Cross-database transactions: misrouted afterCommit / AbortController contaminate
      saves on other databases.
- [ ] Singleton doors cannot declare a read ceiling — `SingletonConfig.get` has no
      `expose`/`abilities`.
- [ ] Presenter registry emits duplicate import bindings when two kind folders export
      the same component name.

---

## DOCS + HOUSEKEEPING CLEANUP

### Doc-vs-code lies (each is a crash-for-the-next-LLM)
- [x] LLM-GUIDE documents `registerPresenterLayout` — DELETED in the tree phase.
      Replace with layouts-are-context.
- [x] LLM-GUIDE documents a `@query()` decorator that has NEVER existed. Remove.
- [x] LLM-GUIDE §1 import name + `npx trails new` — fix once the npm identity lands.
- [ ] Sweep every DESIGN-*.md / GETTING-STARTED / README for API names against the
      current export surface (the presenter-tree + entity-store phases moved a lot).

### Doc consolidation (20 root .md files — "one fact, one place" losing in the docs)
- [ ] Decide the fate of the two rival specs (`active-drizzle-spec.md`,
      `active-drizzle-complete-spec.md`) — both are pre-build blueprints the DESIGN
      docs superseded. Archive or delete (Daniel's call — they're founding docs).
- [x] `STALE.md`, `REMAINING.md`, `NICE_TO_HAVE.md` — fold live items into this
      file or BEFORE_LAUNCH, delete the trackers (this file is the tracker now).
- [ ] Regenerate `USING.gen.md` / `_routes.gen.md` mention in LLM-GUIDE once stable.
- [ ] Update BEFORE_LAUNCH encryption status (core built; propagation TODO) — partly
      done, re-verify against current code.

### Repo hygiene
- [x] Stale merged branch `claude/wizardly-haibt-cdead2` — delete.
- [x] Confirm no committed build artifacts survive (`a.out` was removed; sweep).
- [ ] Demo git remote / orphan root configs (standing "needs Daniel" items).
- [ ] Add `npm run test:types` + `tsc --noEmit` (framework src) to CI (both green
      now; gate them so they stay green).

---

## FOLDED IN — post-launch backlog (from NICE_TO_HAVE.md + STALE.md, 2026-08-26)

The `NICE_TO_HAVE.md` and `STALE.md` trackers are DELETED; their still-live
items land here (one fact, one place). Cross-refs mark what an earlier tier
already owns — do not double-track.

### Query algebra — advanced SQL still to surface (extends Tier 2 "Query algebra")
Shipped + verified on real PG (2026-07-19): group/having, grouped aggregates,
DISTINCT ON, window functions (`Fn.*`), keyset `seek`, set ops, `toSQL`.
Still to surface as typed, chainable `Relation` methods (results hydrate to
typed models/rows, never `any`; `.where(sql\`…\`)` stays the escape hatch):
- [ ] 🟢 CTEs / `WITH … AS` (+ `AS MATERIALIZED` pinning; Drizzle `$with`).
- [ ] 🟢 Recursive CTEs (`WITH RECURSIVE`) — trees/graphs (category trees, org
      charts, threaded comments, descendants-of-X). Miserable to hand-roll.
- [ ] 🟢 `LATERAL` joins — "top N per group" / "most recent N per group".
- [ ] 🟢 Filtered aggregates — `COUNT(*) FILTER (WHERE …)` in one pass.
- [ ] 🟢 JSONB querying (`->`,`->>`,`@>`, `jsonb_path_query`, `json_agg`,
      `jsonb_build_object`) + array operators (`@>`,`&&`,`ANY`/`ALL`,`unnest`).
- [ ] 🟢 `.explain()` (EXPLAIN ANALYZE) beside the shipped `.toSQL()`.
- [ ] 🟢 `upsert` semantics decision (SQL is easy; the ActiveRecord stance is the
      work — bypass hooks/validations like `updateAll`, document loudly, offer a
      slower per-row path; `Attr set` transforms must apply to BOTH insert values
      and the conflict-update set). Cross-ref: Tier 2 already lists `upsert`/ON CONFLICT.

### Observability (new — the Rails "Bullet gem" shape; a pluggable sink)
Plugs into the existing `reportError`/context seam (`core/runtime/error-reporting.ts`)
as a matching `onQuery`/`onSlowQuery` sink — telemetry + errors share one model.
- [ ] 🟢 Dev-time N+1 detector: "resolved `author` 50× across siblings in one
      tick → add `.includes('author')`." The lazy N+1 is BY DESIGN — this teaches
      the escape hatch at the moment it's needed. Off in production.
- [ ] 🟢 Dev query logging (SQL + duration, tagged with model/operation).
- [ ] 🟢 Slow-query warning past a configurable threshold.
- [ ] 🟢 Optional OpenTelemetry spans around queries + `save()`/`transaction()`.

### Error-handling enhancements (extends Tier 0 "Error taxonomy")
- [ ] 🟢 Auto-retry `retryable` transactions — `translateDbError` already
      classifies `40001`/`40P01` as `kind:'retryable'` but nothing acts on it;
      `transaction()` should catch + retry with bounded backoff. Seam exists;
      highest value-per-effort here.
- [ ] 🟢 Promote the emergent `kind` into a documented taxonomy: user
      (validation → shown, not reported) vs operational (DB down/conflict/
      deadlock → friendly, maybe retry) vs programmer (bug → propagate in dev,
      report in prod, generic message to user).
- [ ] 🟢 Type the error context bag: `Record<string,unknown>` → `{ model,
      operation:'insert'|'update'|'destroy', recordId?, sqlstate? }`.
- [ ] 🟢 Document the hook error contract (before throws/returns false → abort;
      after throws → reported, commit already happened; `afterCommit` isolated)
      and "constraints are truth, validations are UX" (uniqueness TOCTOU → 23505).
- Cross-ref: stable machine-readable `code:` on every error is Tier 0.

### Ecosystem reach (new, post-launch)
- [ ] 🟢 More framework adapters (Express / Next route-handlers / Remix /
      Fastify) — the controller layer is already framework-agnostic; adapters
      are thin. `hono` ships today.
- [ ] 🟢 `generate:scaffold` end-to-end (model + Drizzle table stub + controller
      + factory + a React form) — the one-command "wow" demo.
- [ ] 🟢 Edge/serverless proof: run the suite on Workers/Neon-http/PGlite and
      publish the matrix (also a trust item).

### Adoption & docs (new, post-launch)
- [ ] 🟢 Measure client bundle size with 50–100 models FIRST (likely fine, per-
      model generated code is thin + tree-shakes); only if a measurement shows
      growth, push common structure into one shared generated base type each
      per-model file inherits from (`_globals.gen.d.ts` already sets the pattern).
- [ ] 🟢 Rewrite the Prisma comparison "blur" into a crisp side-by-side table
      (active-drizzle vs Prisma vs raw Drizzle vs TypeORM) + a concrete
      Prisma→active-drizzle migration walkthrough. Best conversion tool there is.
- Cross-ref: SSR/RSC find-out-and-document is Tier 1 "Onboarding truth".

### Deferred / expensive (design deliberately; defer until needed)
- [ ] 🟢 Read replicas AND full multi-database (`connected_to`): per-model/
      per-request routing, sharding, DB-per-tenant. Reaches into `boot()`, the
      executor seam, transactions, and every query path.

### Doctrine (design stance, NOT a gap — record so it isn't re-opened)
- Full audit / change-history is an APP concern: ship the `afterCommit` +
  dirty-tracking seams that let an app build exactly the audit it needs
  (retention, tamper-evidence, field-level diffs, regulatory export are all
  app-specific); the `trackable` concern stays general-purpose (timestamps/
  blame) and is NOT meant to grow into an opinionated audit table.

### Housekeeping folded from STALE.md (live items only)
- [ ] 🟢 `packages/react/src/hooks.ts` (DORMANT): Phase-4 hook factories
      (`createModelHook`/`createSearchHook`) with ZERO references anywhere —
      hand-wiring via them would BYPASS the coherence invalidation graph
      (strictly worse). Drop the `index.ts` re-exports at the next minor bump,
      then delete. Awaiting Daniel's call.
- [x] 🟢 `readme-to-add-to-repo.md` (PENDING, not stale): ~25 feature sections
      written as features landed, not yet folded into `README.md` (e.g. the
      hasOne nested-forms section is absent from README). Fold in, then delete
      the staging file.
- [ ] 🟢 LLM-GUIDE §5 signal-only SSE lane ("NEVER payloads") is a WATCH item:
      accurate for shipped code today; when `DESIGN-ws-channels.md` payload
      channels ship it must be rewritten THE SAME DAY or it misleads.
- STALE.md items already RESOLVED (verified 2026-08-26, not carried): `a.out`
  removed; `REMAINING.md` deleted (its stale test-count moot); `WEEKEND-2026-07-18.md`
  gone; the accidental empty `packages/controller/packages/controller/tests/concerns/`
  nested dir gone.

---

## SEQUENCING (the burn-down)

1. **Codec chokepoint** (Tier 0) — one boundary, then generated-real accessors
   (proxy migration rides here). Extinguishes 8 bugs + the biggest first-principle.
2. **npm identity** — nothing ships until `active-drizzle` resolves.
3. **Atomic save + CAS lock + afterCommit merge** — correctness AND the realtime
   foundation pour.
4. **Error taxonomy** — fixes the 500-not-422 family + reviewer #4 + unblocks
   structured auth rejections.
5. **`_clone` completeness + query-seam fixes** (`last`, `inBatches`, `unscoped`,
   `withLock`).
6. **Codegen failure channel + watch-staleness + string escaping.**
7. **Encryption carve-out + format + blind indexes.**
8. Doc sweep + CI gates (do continuously, not last).
9. Then the epoch: `createTestApp`, why-panel, `trails dev`, algebra slice, realtime
   wiring, exceed moves.

Tier 0 + Tier 1 is the launch. Everything in Tier 2 makes it the framework the
skin already promises.
