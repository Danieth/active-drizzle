# NICE_TO_HAVE

Non-blocking ideas — the "makes people love it, not just use it" pile. Launch blockers live in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md); the testing/task-runner design lives in [DESIGN-tasks-and-testing.md](DESIGN-tasks-and-testing.md).

---

## 1. Max out the query system — advanced SQL, ActiveRecord-ergonomic  ⭐

**Thesis:** Drizzle already gives us the full power of Postgres underneath — "maxing out" isn't adding SQL *capability*, it's **surfacing it as type-safe, chainable `Relation` methods** so users never hit the "raw SQL cliff" for common analytical/hierarchical work, and results still **hydrate into typed models / typed row shapes** (the thing raw Drizzle makes you give up). Keep `.where(sql\`…\`)` as the escape hatch for the long tail.

> ### ✅ SHIPPED (2026-07-19) — verified on real Postgres (`tests/integration/advanced-queries.test.ts`)
> `.group()` + `.having()` + grouped aggregates (Rails `group(:x).sum(:y)` → map, enum-labeled keys) · `.distinct()` / `.distinct('col')` (DISTINCT / DISTINCT ON) · `.select((t, Fn) => …)` with **window functions** (`Fn.rank/rowNumber/denseRank/sum/avg/lag/lead/ntile/…`.`over({partitionBy, orderBy})`) · `.seek()` keyset pagination · `.union/.unionAll/.intersect/.except` · `.toSQL()`.
>
> **Still TODO (the harder-to-surface-compactly ones):** CTEs / `WITH RECURSIVE`, `LATERAL` joins, association `.joins()`, JSONB/array operator helpers, full-text (in flight — `DESIGN-search-pg-first.md`).

### Tier 1 — grouped & analytical aggregation (what every dashboard needs)
- **`.group(...)` + `.having(...)`** — grouped aggregation (the two you asked for, hence top billing). `Order.group('status').sum('total')` → `{ pending: 1200, paid: 5000 }`; `.having(...)` filters the groups.
- **Filtered aggregates** — `COUNT(*) FILTER (WHERE paid)` — count paid vs pending in one pass instead of `CASE` gymnastics.
- **Window functions** *(the "whatever that is" one)* — compute a value **across a set of rows related to the current row, without collapsing them**: `OVER (PARTITION BY team ORDER BY score DESC)`. Powers leaderboards / ranking (`ROW_NUMBER`, `RANK`, `DENSE_RANK`), **running totals** & moving averages, **`LAG`/`LEAD`** (compare a row to the previous/next — month-over-month deltas), `NTILE` (percentile buckets). Single biggest analytics unlock.
- **`DISTINCT ON`** — Postgres superpower: **one row per group** ("the latest order per customer") in a single clause, no subquery.

### Tier 2 — composition & subqueries
- **CTEs / "pinning" a subquery** (`WITH … AS`) — name a subquery once and reuse it; `AS MATERIALIZED` **pins** it so PG computes it exactly once instead of re-inlining. Drizzle exposes `$with`.
- **Recursive CTEs** (`WITH RECURSIVE`) — walk trees/graphs: category trees, org charts, threaded comments, "all descendants of node X." The killer feature for hierarchical data, and miserable to hand-roll.
- **LATERAL joins** *(the other unfamiliar one)* — a join whose right side **can reference each left row** (a correlated subquery in `FROM`). Canonical use: **"top 3 posts per user"** / "most recent N per group," which is awkward any other way.
- **Correlated subqueries** — `.whereExists(sub)` / `EXISTS`/`NOT EXISTS`, scalar subquery in `SELECT`, `IN (subquery)`. You already have `.where({ id: SomeRelation })` (IN-subquery) + `toSubquery()`; this generalizes them.
- **Set operations** — `.union()` / `.unionAll()` / `.intersect()` / `.except()`.

### Tier 3 — Postgres-native types you already store
- **JSONB querying** — `->`, `->>`, `@>`, `jsonb_path_query`; and **aggregate → JSON** (`json_agg`, `jsonb_build_object`) to shape an entire API payload in the DB in one round-trip. You have `Attr.json`.
- **Array operators** — `@>` contains, `&&` overlap, `ANY`/`ALL`, `unnest`. You have Attr arrays.
- **Full-text search** — `websearch_to_tsquery` + `ts_rank`. *(Already in flight — see `DESIGN-search-pg-first.md`; `.search()` is `ILIKE`-only today.)*

### Tier 4 — pagination & row-value tricks
- **Keyset / cursor pagination** — `(created_at, id) < (?, ?)` row-value comparison → **O(1) deep pagination** that `OFFSET` can't give (OFFSET scans + discards everything it skips). The correct way to page large sets and the backbone of a real cursor API.

### The opinionated design rule
Don't reimplement SQL. Surface the **~20% of advanced features that cover 80% of real reporting / analytics / hierarchy needs** as first-class, chainable, **type-safe** methods (window/rank, group/having, `DISTINCT ON`, recursive CTE, lateral, keyset). Everything past that stays reachable via the `sql` escape hatch — but even then, **the result hydrates into a typed model or typed row shape, never `any`.** Type-safety all the way through the chain is the differentiator vs. raw Drizzle and vs. every other ORM's raw-SQL cliff.

---

## 2. Observability: N+1 detection + query instrumentation

The lazy `await post.author` N+1 is **by design** (with `.includes()` as the escape hatch), so a dev-mode detector isn't fixing a bug — it's teaching the escape hatch at the exact moment it's needed. This is Rails' **Bullet gem**, which people adore.

- **Dev-time N+1 warning.** Detect "resolved the same association N times across sibling records in one tick" → warn: *"loaded `author` 50× in a loop — add `.includes('author')`."* Off in production.
- **Query logging** (dev): each SQL + duration, tagged with the model/operation that issued it.
- **Slow-query timing**: warn past a configurable threshold.
- **OpenTelemetry spans** (optional): wrap queries + `save()`/`transaction()` in spans so app traces show ORM work. Most ORMs lack this.

**Where it plugs in:** the `reportError`/context seam already exists (`core/runtime/error-reporting.ts`) — instrumentation is the same shape (a pluggable `onQuery`/`onSlowQuery` sink) so telemetry + errors share one mental model.

---

## 3. Error-handling roadmap  (the "error stuff from above")

The spine is already good — `translateDbError` + `onError`/`reportError` (server) + `parseControllerError`/`handleControllerError` + `onClientError` (client), with a clean seam per boundary. These are the *enhancements*:

- **Stable error codes on every error** (`code: 'blank' | 'taken' | 'too_long' | …`) alongside the default message, so apps can i18n/override without string-matching English. → **Timing caveat: this one is arguably a BEFORE_LAUNCH item** (breaking to add once apps depend on the strings). Cross-listed in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md) §3 — decide deliberately.
- **Auto-retry `retryable` transactions.** `translateDbError` already classifies `40001` (serialization failure) + `40P01` (deadlock) as `kind: 'retryable'`, but nothing acts on it. Make `ApplicationRecord.transaction()` catch a `retryable` failure and retry with bounded backoff — these transient failures then never surface. **Highest-value item in this file; the seam already exists.** Small enough to spike.
- **Explicit, documented error taxonomy.** Promote the emergent `kind` field into a first-class, documented model: **user errors** (validation → shown, not reported) vs **operational** (DB down/conflict/deadlock → friendly + maybe auto-retry) vs **programmer** (bug → propagate in dev, high-severity report in prod, generic message to user). `translateDbError` returning `null` for non-DB errors is already this instinct — just make it the documented contract.
- **Type the error context bag.** `ErrorContext = Record<string, unknown>` → a typed `{ model, operation: 'insert' | 'update' | 'destroy', recordId?, sqlstate? }`. The reporter already passes these; typing makes every telemetry dashboard consistent and self-documenting.
- **Document the hook error contract.** before-hook throws / returns false → abort (via `AbortChain`); after-hook throws → reported but commit already happened; `afterCommit` errors isolated. One paragraph kills a common footgun.
- **"Constraints are truth, validations are UX."** `Validates.uniqueness()` has a TOCTOU race, correctly backstopped by the DB `23505` → "has already been taken". Just say it out loud in the docs — it's the same principle as "model allows, controller gates."

---

## 4. Query & data-layer DX  (basics — see §1 for the advanced query system)

The query builder is already deep (`sum`/`average`/`minimum`/`maximum`/`tally`, `exists`/`any`/`many`, `findOrCreateBy`, `inBatches`, `SELECT … FOR UPDATE` locking, composite keys). Two genuine gaps:

- **`.toSQL()` / `.explain()` — see the query before it runs.** Confirmed missing (only `toSubquery` exists, for composition). Drizzle already compiles the SQL, so surfacing `.toSQL()` (returns the string) and `.explain()` (EXPLAIN ANALYZE) on `Relation` is ~an afternoon and pays off every single debugging session. **Highest value-per-effort item in this file.**
- **Upsert / bulk `ON CONFLICT`.** Missing today (`findOrCreateBy` is the race-prone, row-at-a-time stand-in). Drizzle gives us `.onConflictDoUpdate` / `.onConflictDoNothing`.
  - **Difficulty: the SQL is easy; the *semantics* are the work.** Bulk upsert has to decide — and document — what it does about the ActiveRecord layer: do validations run? do `beforeSave`/`afterSave` hooks fire per row? does dirty-tracking / `updated_at` update? Rails' `upsert_all`/`insert_all` deliberately **bypass** validations + callbacks (they're raw), which surprises people. Pick a stance (likely: bypass hooks/validations like `updateAll`, document loudly, and offer a slower per-row path that runs them). That decision — not the Drizzle call — is the hard part. Also: Attr `set` transforms must apply to *both* the insert values and the conflict-update set, and the conflict target has to resolve composite/unique keys. **Net: 1 day for the happy path, the real cost is nailing + documenting the semantics.**

---

## 5. Ecosystem reach

- **More framework adapters.** We have `hono`; Express / Next route-handlers / Remix / Fastify would widen the funnel a lot (the controller layer is already framework-agnostic; adapters are thin).
- **`generate:scaffold`** end-to-end (model + Drizzle table stub + controller + factory + a React form) — the "wow, one command" demo. (Lives in the DESIGN doc's `ad generate:*`.)
- **Edge/serverless proof.** Actually run the suite on Workers/Neon-http/PGlite and publish the matrix (also a BEFORE_LAUNCH trust item).

---

## 6. Adoption & docs

- **Client bundle size with N models — measure first, it's probably fine.** The react package ships generated runtime per model, so the worry is 50–100 models bloating the client. Honest guess: **it's fine**, because generated per-model code is thin and tree-shakes. **But if a measurement ever shows growth**, the fix Daniel floated is the right one: a **shared generated base type/class that every model's generated type inherits from**. `_globals.gen.d.ts` already establishes this pattern (ambient aliases) — push the common structure into one base so each per-model file emits only its *delta*. That keeps the bundle DRY and effectively "pre-tree-shaken." Rule: measure → only build the base if the number demands it.
- **SSR / hydration story — currently UNKNOWN, needs investigation.** How do client model instances behave under Next/Remix SSR + hydration? Open questions: are proxy-wrapped records serializable across the RSC/hydration boundary? Do they survive `JSON.stringify` → rehydrate as live models or as plain objects? Does `boot()` run on the server, the client, or both? We genuinely don't know yet — this is a **find-out-and-document** item, not a feature. People *will* ask on day one, so it needs a real answer before it becomes a support fire.
- **Sharpen the comparison + a "migrating from Prisma" guide.** There's an attempt in the main docs, but it reads as a **blur**. A crisp side-by-side (active-drizzle vs Prisma vs raw Drizzle vs TypeORM — on schema ownership, type-safety, associations, migrations, testing) plus a concrete Prisma→active-drizzle walkthrough is the single best conversion tool. Rewrite the blur into an opinionated table.

---

## Nice to have — but EXPENSIVE

Real, but each is a meaningful chunk of work, not a weekend spike:

- **Read replicas *and* full multi-database (`connected_to`).** Not just read/write splitting — per-model or per-request connection routing, sharding, DB-per-tenant. High value at scale, but it reaches into `boot()`, the executor seam, transaction handling, and every query path. Design deliberately; defer until someone actually needs it.

---

## Deliberately left to apps (design stance, not a gap)

- **Full audit / change-history (who-changed-what-when, old→new).** The `trackable` concern is intentionally **general-purpose** (timestamps/blame) — it is *not* meant to grow into a specialized audit solution, because real audit requirements (retention, tamper-evidence, field-level diffs, regulatory export format) are app-specific. Ship the `afterCommit` + dirty-tracking seams that let an app build exactly the audit it needs; don't ship an opinionated audit table and pretend it fits everyone.

---

## Already done (so we don't re-list them)
- ✅ **Console/REPL** — `core/runtime/console.ts` + `docs/guide/console.md`. (This was on an earlier "needs" list; it exists.)
- ✅ Pluggable error reporting (server + client), SQLSTATE translation, layered HTTP error mapping.
- ✅ Runtime hot-path perf (WeakMap memoization, STI/​habtm de-quadratic-ed).
- ✅ Crash-proof, self-healing codegen watcher + conditional reload.
