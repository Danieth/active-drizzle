# REMAINS FOR LAUNCH

The single source of truth for shipping ActiveDrizzle/trails. Ordered by
blocking tier. Every item traces to a verified finding (mega-scan 2026-08-26,
reviewer launch list, DX field reports, query-algebra audit). Check items off
here as they land; don't spawn parallel trackers.

Legend: 🔴 blocks launch · 🟠 should-fix pre-launch · 🟢 post-launch, non-breaking
Suites baseline at time of writing: core 1098 / controller 299 / react 251.

---


## BURN-DOWN STATUS (2026-08-26, commit 0d23c7f + follow-up)

Most of TIER 0 + TIER 1 landed via the 5-cluster parallel burn-down (core
1137 / controller 318 / react 266, all green; demo regen clean). DONE:
codec chokepoint (write side), atomic save/destroy, create()→422 contract,
_clone flags, CAS lock, afterCommit nested-tx merge, last()/inBatches,
find() STI, codegen watch-staleness/unlink/spread/escaping/failure-channel,
model.name→modelClassName, bulk ids:[], nestedAutoSet (CRUD + singleton),
concern exports, npm identity in scaffolder+docs, doc-lies, and the react
state-machine cluster.

STILL OPEN (explicit follow-ups, tracked here so nothing silently drops):
- [ ] CODEC READ-SIDE COHERENCE: the WRITE boundary (mapWriteAttributes) is
      genuine, but toJSON/get-trap/defaults READ paths still inline
      `attr._column ?? key` + `.get` rather than routing through one helper.
      Behavior is CORRECT + tested — this is a DRY/coherence cleanup, NOT a
      bug. Deferred deliberately (serialization is delicate; not worth a
      regression under the burn-down). Wire reads through the boundary +
      delete the now-dead toDisplayValue/attrConfigFor exports.
- [ ] SCALAR AGGREGATE UNITS: sum/avg/min/max return RAW db units (cents) for
      property-named codec fields. The core agent correctly REFUSED to flip
      this — pinned integration tests + a documented design decision (Attr
      aggregation is intentionally raw-unit). Needs a cross-cutting owner
      decision, not a unilateral change.
- [ ] STABLE ERROR-CODE TAXONOMY (reviewer #4): the create() throw→return
      contract that unblocked 422 landed, but machine-readable codes
      (code:'blank'|'taken'|…) on every validation/DB error are still TODO —
      breaking to add later, so pre-launch.
- [ ] ENCRYPTION carve-out + blind indexes; SSR/RSC doc pass; generated-
      output CI gate — Tier 1 items not in this burn-down's scope.

## TIER 0 — 🔴 CANNOT SHIP WITHOUT (correctness + installability)

### The codec chokepoint (ONE refactor kills 8 confirmed bugs)
The property↔column name and display↔raw value mapping is re-implemented per
path instead of at one boundary. `save()` does it right; every other path forks.
- [ ] Define ONE mapping boundary (property→`_column`, value→codec, dirty-track)
      that every write/read path crosses.
- [ ] `updateAll` — keeps property name, drops `Attr.money('priceCents')` writes
      (relation.ts:1054). Route through the boundary.
- [ ] `insertAll` — drops `_column` mapping, skips Attr defaults, omits STI
      discriminator stamp (application-record.ts:293).
- [ ] INSERT defaults loop — writes default under property name → dropped by
      drizzle; implicit not-null validation then vouches for the unfilled column
      (application-record.ts:598). **Data-integrity: NULL into NOT NULL.**
- [ ] `find()` — forks the read pipeline: no STI type scoping (a subclass can
      `find()` a sibling's row), no default scopes, no subclass resolution
      (application-record.ts:250). Route through Relation.
- [ ] `aggregates`/`tally()` return raw DB units (cents, enum ints) while every
      other read lane returns model units — AND `tally()` bypasses the encryption
      guard (decrypted plaintext labels).
- [ ] `toJSON`/`attributes` serialize dirty fields in raw space (cents leak).
- [ ] `restoreAttributes()` writes display-space `_was` values back into raw
      `_attributes` — corrupts the codec on the record.

### Atomicity
- [ ] Wrap `save()` in a transaction (application-record.ts:640). Today: parent
      INSERT commits, then nested/habtm/counters/autosave run un-wrapped; a forged
      child id commits the parent + earlier children then returns a lying 422 →
      **duplicate rows on resubmit.** This is also the realtime foundation.
- [ ] `destroy()` cascade is not transactional — children destroyed, then a
      failing parent DELETE strands them.
- [ ] Nested child `update()` results are discarded (application-record.ts:1538) —
      invalid child edits return 200 and vanish. Check the boolean.

### Error taxonomy (root cause of the 500-not-422 family; reviewer blocker #4)
- [ ] `ApplicationRecord.create` throws stringly `Error('Validation failed: '+JSON)`
      (application-record.ts:285) → `defaultCreate`'s 422 branch is DEAD CODE and
      its covering test is theater (crud-handlers.ts:778). CREATE validation
      failures surface as **HTTP 500**.
- [ ] Same root cause kills `singletonFindOrCreate`'s 23505 race recovery
      (crud-handlers.ts:1209) — the catch matches a message that never arrives.
- [ ] Ship stable machine-readable codes on every error (`code: 'blank' | 'taken'
      | 'too_long' | ...`). Breaking to add later; layered auth gates get
      structured rejections for free. Design the taxonomy once.

### Concurrency
- [ ] `withLock` acquires NO lock: `_clone()` copies 9 flags but not `_forUpdate`,
      and `first()/take()/exists()` all clone (relation.ts:1315). The documented
      `locked.first()` emits a plain SELECT. Add `_forUpdate` to `_clone`.
- [ ] Same `_clone` gap silently reverts `unscoped()` (`_skipAllDefaultScopes` /
      `_excludedDefaultScopes` not copied) — `unscoped().first()` re-applies
      scopes while `unscoped().count()` doesn't. Contradictory answers.
- [ ] Optimistic lock is check-then-act, not CAS: `save()`'s UPDATE WHERE has only
      the pk, no version predicate (application-record.ts:628). Two stale writers
      both pass. **The coherence proofs rest on this.** Add version to the WHERE.
- [ ] `afterCommit` callbacks in nested transactions are silently discarded
      (boot.ts:200) — inner queue never merged into outer. Merge on nested commit.

### Installability (the framework cannot be installed today)
- [ ] npm identity: apps depend on bare `active-drizzle` (unpublished); package is
      `@active-drizzle/core`. Every scaffold, all generated code, LLM-GUIDE imports
      the wrong name (trails.mjs:135). Pick ONE published name, thread it
      everywhere.
- [ ] `npx trails new` resolves to a STRANGER'S `trails` package on npm. Publish
      under a real bin name or document `npx @scope/trails`.
- [ ] `helpers` package documented as installable, never published; release script
      excludes it. Publish or stop documenting.
- [ ] Controller-concern system (`defineControllerConcern`, `@includeInController`,
      `Searchable`) documented but NOT exported from the package entry — unreachable
      (controller/src/index.ts). Export or delete the docs.

---

## TIER 1 — 🟠 SHOULD-FIX BEFORE LAUNCH (breaking, security, or first-impression)

### Codegen soundness (the extractor lies on legal input)
- [ ] Watch-mode serves STALE ASTs forever: ts-morph returns cached SourceFile
      without re-reading disk; `.ctrl.ts`/`.model.ts` edits silently ignored
      (controller-extractor.ts:27, extractor.ts). `refreshFromFileSystemSync()` per
      changed file.
- [ ] Model-file deletion never regenerates: only `change`/`add` watcher events
      registered, no `unlink` (vite/index.ts:561).
- [ ] Spread properties in `pgTable()` dropped silently — the Drizzle-recommended
      shared-columns pattern (`...timestamps`) loses columns (extractor.ts:73).
- [ ] App strings interpolate into generated source with naive quoting: an enum
      value/key with an apostrophe/hyphen produces invalid generated code
      (generator.ts:815, react-generator.ts:1741). **Code-injection-shaped.** Escape.
- [ ] Nested model dirs (the documented glob `**/*.model.ts`) generate wrong
      back-imports + silent same-basename collisions (vite/index.ts:310).
- [ ] `extractModel` reads only `getClasses()[0]` — a co-located STI subclass (the
      layout the bug-#6 guard endorses) is invisible (extractor.ts:257).
- [ ] Chained Attr modifiers drop client-side VALIDATIONS:
      `extractPropertyValidations` never unwraps the chain (extractor.ts:1004) —
      `resolveAttrCall` fixed fieldMeta/defaults but not this.
- [ ] **Codegen has no failure channel** (Q2 design violation): diagnostics
      `console.log`, then generation proceeds ON RED and writes files from invalid
      meta (vite/index.ts:293). "Errors that teach" must apply to the framework's
      OWN build — a hard error mode that refuses to emit.
- [ ] Generated output `tsc --noEmit` clean + a CI gate that regenerates fixtures
      and typechecks them (BEFORE_LAUNCH §1: dangling-import, `id?`, `Function.name`).

### Boundary correctness
- [ ] Controller reads `model.name` in ~10 places (router.ts:528) — the framework's
      own #1 rule. 404s say "[object Object] not found"; attach presign breaks on
      any model with a `name` Attr. Use `modelClassName()`.
- [ ] Bulk mutation with `ids: []` operates on the ENTIRE door scope (router.ts:313,
      zod accepts empty array). `.min(1)` or treat empty as no-op per `records`.
- [ ] `nestedAutoSet` read from create-config on create, update-config on update
      with no fallback (crud-handlers.ts:835) — LLM-GUIDE's canonical example
      declares it only under `create`, reopening the forged-fk gap on every edit.
- [ ] Per-field autosave success clobbers concurrent edits via full `applyEnvelope`
      (form-session.ts commitField) — use the applyFlushSuccess narrow path.
- [ ] Conflict bookkeeping survives resolution: `adoptIncoming` after settle rolls
      the version token BACKWARD (form-session.ts:890). Clear on submit success.
- [ ] Nested new-row ids adopted POSITIONALLY (nested.ts:398) — wrong-record writes
      when echo order diverges. `_key` is sent but never used to match. Match by `_key`.
- [ ] Parked nested edits dropped: `restoreParked` runs before lazy nested-manager
      registration (generated-form.ts:92).
- [ ] `last()` after explicit `.order()` emits invalid SQL `col asc desc`
      (relation.ts:564) — the reversal test on stringified drizzle objects can never
      fire. Reverse via the order-spec list, not string matching.
- [ ] `inBatches` skips half the rows under a mutating callback (its own docstring
      example) + no ORDER BY (relation.ts:1117). Use keyset (`seek`) not limit/offset.

### The encryption × permissive-default hole (doctrine carve-out)
- [ ] An ungoverned door (no `get.expose`) serializes EVERY column, and `Attr.get`
      has already DECRYPTED encrypted fields → ships plaintext PII, and the
      permissive-by-default doctrine forbids the warning. **Carve-out**: permissive
      is fine UNTIL a column is `.encrypt()`'d; then absence of a ceiling is a
      teaching error, not a default.
- [ ] Encryption storage format + blind indexes: `.encrypt({ blindIndex: true })`
      generating a digest column so encrypted tokens stay queryable by equality.
      Format is FOREVER — decide pre-launch (reviewer #6).

### Onboarding truth
- [ ] SSR/RSC find-out-and-document pass: proxy records across the hydration
      boundary, `boot()` placement, headless codegen outside Vite (reviewer #8).
- [ ] Verify + close BEFORE_LAUNCH §2 (no-error-leak) — the hono 500 path already
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
- [ ] `columnToClientType` is a forked weaker copy of `COLUMN_TS_TYPE` (bigint typed
      `number` client-side vs `string` server-side) — fold into the one map.
- [ ] pgEnum columns extracted as NOT NULL unconditionally — nullable enums get
      lying types.
- [ ] Drizzle `$defaultFn`/`$default`/`$onUpdate` not recognized as defaults —
      DB/client-defaulted columns become required in generated Create types.
- [ ] `@validate`/`@serverValidate`/`beforeValidate` ignore their `if:`/`on:` options.
- [ ] `PresenterContextProvider` rebuilds bag + layout-stack identity every render —
      app-wide field re-render storm. Memoize.
- [ ] Instant nested patch/create `resetBaseline()` wipes unrelated staged edits on
      the same row.
- [ ] Index context memo omits `isFetching` — the keepPreviousData "refreshing"
      signal doesn't propagate to the compound surface.
- [ ] `useUploadFactory` has no run-generation guard — a superseded upload corrupts
      the replacement's state.
- [ ] `submit()` races an in-flight `autoFlush` — self-inflicted 409.
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
- [ ] LLM-GUIDE documents `registerPresenterLayout` — DELETED in the tree phase.
      Replace with layouts-are-context.
- [ ] LLM-GUIDE documents a `@query()` decorator that has NEVER existed. Remove.
- [ ] LLM-GUIDE §1 import name + `npx trails new` — fix once the npm identity lands.
- [ ] Sweep every DESIGN-*.md / GETTING-STARTED / README for API names against the
      current export surface (the presenter-tree + entity-store phases moved a lot).

### Doc consolidation (20 root .md files — "one fact, one place" losing in the docs)
- [ ] Decide the fate of the two rival specs (`active-drizzle-spec.md`,
      `active-drizzle-complete-spec.md`) — both are pre-build blueprints the DESIGN
      docs superseded. Archive or delete (Daniel's call — they're founding docs).
- [ ] `STALE.md`, `REMAINING.md`, `NICE_TO_HAVE.md` — fold live items into this
      file or BEFORE_LAUNCH, delete the trackers (this file is the tracker now).
- [ ] Regenerate `USING.gen.md` / `_routes.gen.md` mention in LLM-GUIDE once stable.
- [ ] Update BEFORE_LAUNCH encryption status (core built; propagation TODO) — partly
      done, re-verify against current code.

### Repo hygiene
- [ ] Stale merged branch `claude/wizardly-haibt-cdead2` — delete.
- [ ] Confirm no committed build artifacts survive (`a.out` was removed; sweep).
- [ ] Demo git remote / orphan root configs (standing "needs Daniel" items).
- [ ] Add `npm run test:types` + `tsc --noEmit` (framework src) to CI (both green
      now; gate them so they stay green).

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
