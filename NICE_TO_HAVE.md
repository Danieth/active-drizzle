# NICE_TO_HAVE

Non-blocking ideas — the "makes people love it, not just use it" pile. Launch blockers live in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md); the testing/task-runner design lives in [DESIGN-tasks-and-testing.md](DESIGN-tasks-and-testing.md).

---

## 1. Observability: N+1 detection + query instrumentation

The lazy `await post.author` N+1 is **by design** (with `.includes()` as the escape hatch), so a dev-mode detector isn't fixing a bug — it's teaching the escape hatch at the exact moment it's needed. This is Rails' **Bullet gem**, which people adore.

- **Dev-time N+1 warning.** Detect "resolved the same association N times across sibling records in one tick" → warn: *"loaded `author` 50× in a loop — add `.includes('author')`."* Off in production.
- **Query logging** (dev): each SQL + duration, tagged with the model/operation that issued it.
- **Slow-query timing**: warn past a configurable threshold.
- **OpenTelemetry spans** (optional): wrap queries + `save()`/`transaction()` in spans so app traces show ORM work. Most ORMs lack this.

**Where it plugs in:** the `reportError`/context seam already exists (`core/runtime/error-reporting.ts`) — instrumentation is the same shape (a pluggable `onQuery`/`onSlowQuery` sink) so telemetry + errors share one mental model.

---

## 2. Error-handling roadmap  (the "error stuff from above")

The spine is already good — `translateDbError` + `onError`/`reportError` (server) + `parseControllerError`/`handleControllerError` + `onClientError` (client), with a clean seam per boundary. These are the *enhancements*:

- **Stable error codes on every error** (`code: 'blank' | 'taken' | 'too_long' | …`) alongside the default message, so apps can i18n/override without string-matching English. → **Timing caveat: this one is arguably a BEFORE_LAUNCH item** (breaking to add once apps depend on the strings). Cross-listed in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md) §3 — decide deliberately.
- **Auto-retry `retryable` transactions.** `translateDbError` already classifies `40001` (serialization failure) + `40P01` (deadlock) as `kind: 'retryable'`, but nothing acts on it. Make `ApplicationRecord.transaction()` catch a `retryable` failure and retry with bounded backoff — these transient failures then never surface. **Highest-value item in this file; the seam already exists.** Small enough to spike.
- **Explicit, documented error taxonomy.** Promote the emergent `kind` field into a first-class, documented model: **user errors** (validation → shown, not reported) vs **operational** (DB down/conflict/deadlock → friendly + maybe auto-retry) vs **programmer** (bug → propagate in dev, high-severity report in prod, generic message to user). `translateDbError` returning `null` for non-DB errors is already this instinct — just make it the documented contract.
- **Type the error context bag.** `ErrorContext = Record<string, unknown>` → a typed `{ model, operation: 'insert' | 'update' | 'destroy', recordId?, sqlstate? }`. The reporter already passes these; typing makes every telemetry dashboard consistent and self-documenting.
- **Document the hook error contract.** before-hook throws / returns false → abort (via `AbortChain`); after-hook throws → reported but commit already happened; `afterCommit` errors isolated. One paragraph kills a common footgun.
- **"Constraints are truth, validations are UX."** `Validates.uniqueness()` has a TOCTOU race, correctly backstopped by the DB `23505` → "has already been taken". Just say it out loud in the docs — it's the same principle as "model allows, controller gates."

---

## 3. Ecosystem reach

- **More framework adapters.** We have `hono`; Express / Next route-handlers / Remix / Fastify would widen the funnel a lot (the controller layer is already framework-agnostic; adapters are thin).
- **`generate:scaffold`** end-to-end (model + Drizzle table stub + controller + factory + a React form) — the "wow, one command" demo. (Lives in the DESIGN doc's `ad generate:*`.)
- **Edge/serverless proof.** Actually run the suite on Workers/Neon-http/PGlite and publish the matrix (also a BEFORE_LAUNCH trust item).

---

## Already done (so we don't re-list them)
- ✅ **Console/REPL** — `core/runtime/console.ts` + `docs/guide/console.md`. (This was on an earlier "needs" list; it exists.)
- ✅ Pluggable error reporting (server + client), SQLSTATE translation, layered HTTP error mapping.
- ✅ Runtime hot-path perf (WeakMap memoization, STI/​habtm de-quadratic-ed).
- ✅ Crash-proof, self-healing codegen watcher + conditional reload.
