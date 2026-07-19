# Integrated task environment + user testing story
### Design doc · 2026-07-19 · status: PROPOSED
### Thesis: what made Rails / Phoenix / Laravel *sticky* was never the ORM — it was `rake`/`mix`/`artisan` **plus** a first-class testing story. active-drizzle has the ORM. This is the missing "product" layer.

> Planning only. API sketches, not implementation. Nothing here is built yet.

---

## 0. Why this is the highest-leverage thing left

An ORM gets adopted through the **workflow around it**, not the query builder. Two workflows decide it:

1. **"How do I run stuff against my app?"** — migrations, seeds, backfills, one-off scripts, a console. The `rake`/`mix`/`artisan` slot.
2. **"How do I test my models without pain?"** — factories + fast, isolated tests. The factory_bot / Ecto.Sandbox / Laravel-factory slot.

active-drizzle has neither as a *user-facing* surface yet (the console — `core/src/runtime/console.ts` — is the one exception, and it's already done). Everything below is greenfield.

---

## 1. Who won, and what they got right

| Framework | Task runner | Testing isolation | Factories | The lesson |
|---|---|---|---|---|
| **Rails** | `rake` / `rails` — tasks depend on `:environment`, boot the whole app | `use_transactional_tests` — each test in a transaction, rolled back | factory_bot (`create(:user)`) + fixtures | The gold standard; the `:environment` dependency (task gets the booted app free) is the magic |
| **Phoenix (Elixir)** | `mix` — build tool *and* task runner in one; `mix ecto.migrate`, custom `mix my.task` | **`Ecto.Adapters.SQL.Sandbox`** — per-test transaction, even for **concurrent** tests | ExMachina | Best-in-class isolation: concurrent tests each in their own sandboxed transaction |
| **Laravel** | `artisan` — `make:*`, `migrate`, `tinker` (REPL) | `RefreshDatabase` / `DatabaseTransactions` traits | `User::factory()->create()` — fluent, states, sequences | The **factory DSL** is the most-loved part; fluent + typed states |
| **Django** | `manage.py` + custom management commands | `TestCase` wraps each test in a transaction | factory_boy | Custom commands boot the app the same way built-ins do |
| **AdonisJS** | **`node ace`** — `make:*`, `migration:run`, `repl` | Japa + DB transaction / global-truncate hooks | typed model factories | **The Node/TS north star** — proves this whole pattern works in our runtime |
| **Prisma** | CLI for schema/migrate/seed/studio — but **no app-context task runner** | (none blessed → people bolt on testcontainers + manual truncation) | (none — 3rd-party) | **The cautionary tale.** Great schema CLI, weak workflow + testing. This is exactly the gap we can beat. |

**The synthesized winning pattern:**
1. **One entrypoint that boots the full "environment"** (dev/test/prod) so every task — built-in or user-written — runs with all models registered + DB connected.
2. **Built-in lifecycle tasks** (db, console, routes, generate, test).
3. **User-defined tasks with the app loaded for free** — the `rake` superpower. This is what turns a CLI into an *environment*.
4. **Transactional per-test isolation** — the thing that makes a test suite fast *and* trustworthy.
5. **Typed factories** — and we can go further than any of them here, because codegen already knows every attr's type.

---

## 2. Pillar A — the `ad` task environment (our `rake`/`mix`/`ace`)

### 2.1 One entrypoint, one boot
```
ad <namespace:task> [args]           # e.g. ad db:migrate, ad routes, ad backfill:slugs
```
- Config lives in `active-drizzle.config.ts` (schema path, models glob, db factory per env, tasks dir).
- Each invocation resolves `NODE_ENV` (`development` | `test` | `production`), calls the app's `boot()` **once**, then runs the task with models registered + DB connected. Same contract as Rails' `:environment` dependency.

### 2.2 Built-in namespaces
- `ad db:migrate` / `db:rollback` / `db:seed` / `db:reset` / `db:version` — thin, honest wrappers over **drizzle-kit** (we don't own migrations — Drizzle does; see the schema-ownership note in §6). `db:prepare` sets up the **test** database.
- `ad console` — ✅ **already built.** Just needs to become env-aware and mount under the CLI.
- `ad routes` — list controller → route mappings (we already generate `_routes.gen.ts`; this is a formatter over it). Rails `rails routes`.
- `ad generate:model` / `generate:controller` / `generate:scaffold` — blueprints that scaffold a `.model.ts` (+ matching Drizzle table stub + controller + a factory). Laravel `make:*`.
- `ad test` — see Pillar B.

### 2.3 User tasks — the killer feature
Any file under `tasks/` can register a task that gets the booted app for free:
```ts
// tasks/backfill.ts
import { task } from 'active-drizzle/tasks'
import { User } from '../app/models/User.model'

task('backfill:slugs', 'Populate slug for legacy users', async () => {
  for await (const user of User.where({ slug: null }).inBatches()) {
    user.slug = slugify(user.name)
    await user.save()
  }
})
```
```
ad backfill:slugs
```
This is the whole ballgame — one-off data fixes, cron entrypoints, imports, report generation, all running inside the real app context. It's the difference between "a codegen tool" and "a framework."

### 2.4 Discoverability
- `ad` with no args → grouped list of every task (built-in + user) with its one-line description.
- `ad --help <task>` → args + description.

---

## 3. Pillar B — the user testing story (the part that made you say "fuck")

### 3.1 Factories (typed, fluent — we can out-do everyone here)
Because codegen knows every attr's type, factories are **fully type-checked** against the model — something factory_bot/factory_boy can't do:
```ts
// tests/factories.ts
import { defineFactory, seq, assoc } from 'active-drizzle/testing'
import { User, Post } from '../app/models'

export const userFactory = defineFactory(User, () => ({
  name:  'Test User',
  email: seq(n => `user${n}@example.com`),   // sequences
}), {
  traits: {
    admin:     { role: 'admin' },            // fluent states/traits
    suspended: { suspendedAt: new Date() },
  },
})

export const postFactory = defineFactory(Post, () => ({
  title:  'Hello',
  author: assoc(userFactory),                // association factories
}))
```
```ts
const u  = await userFactory.create()                 // inserted
const a  = await userFactory.create('admin')          // trait
const p  = userFactory.build({ name: 'X' })           // in-memory, unsaved
const us = await userFactory.createList(3)            // batch
```
Runs validations by default (build valid records), with an escape hatch to skip. `create` respects hooks; `build` doesn't touch the DB.

### 3.2 Transactional isolation — **the #1 piece** (Ecto.Sandbox / Rails transactional tests)
```ts
// tests/setup.ts
import { useTransactionalTests } from 'active-drizzle/testing'
useTransactionalTests()   // wraps every test in a SAVEPOINT, rolls back after
```
- Each test runs inside a transaction (via savepoint) that's **rolled back** in `afterEach` → no truncation, no cross-test bleed, fast.
- **The one honest caveat** (decision in §6): `afterCommit` hooks and code that opens its *own* transaction need a real commit. Provide a second mode, `useTruncationTests()` (TRUNCATE-between, slower but real commits), and let a test opt in per-file. Phoenix solves the concurrent case with a shared connection pool owner; we can start single-connection and revisit.

### 3.3 Test DB lifecycle
- `ad db:prepare` creates + migrates the **test** DB.
- Two backends, one API:
  - **PGlite** (in-process) as the fast default for model/unit tests — ties to the earlier perf finding that integration time is DB round-trips, not container boot. Sub-second.
  - **Testcontainers** (real Postgres) for fidelity-sensitive suites.
- The `_helpers/pg-setup.ts` you already have is 80% of the Testcontainers backend.

### 3.4 Model-aware matchers (small, delightful)
```ts
expect(user).toBeValid()
expect(user).toHaveError('email', 'taken')     // pairs with the error-code work (see NICE_TO_HAVE)
expect(() => post.save()).toChange(() => Post.count(), { by: 1 })
```

### 3.5 Fixtures (secondary)
Declarative seed sets for integration/e2e. Factories are the primary path; fixtures are for "here's a known world" scenarios.

---

## 4. How the two pillars compose

`ad test` = boot the **test** env → `db:prepare` → run vitest with the sandbox hooks auto-installed. **But do not fight vitest**: the factories, `useTransactionalTests`, and matchers are all plain importable helpers, so a user can keep running raw `vitest` and just `import` them. The CLI is a convenience wrapper, never a requirement.

---

## 5. Phased rollout (value-first)

- **Phase 1 — testing helpers as a library (no CLI needed).** `defineFactory` + `useTransactionalTests` + matchers, importable into vitest. This is the highest-value slice and ships without any CLI. **Do this first.**
- **Phase 2 — the `ad` shell.** Config + env boot + `console` (mount the existing one) + `routes` + `db:*` (drizzle-kit wrappers) + `generate:*`.
- **Phase 3 — user tasks + `ad test`.** The `task()` registry and the vitest wrapper.

---

## 6. Open decisions (for Daniel)

1. **CLI vs npm-scripts-first.** Recommend: ship the **importable helpers first** (Phase 1), add the `ad` binary second. Users get the win before we own a CLI surface.
2. **Sandbox mode.** Savepoint-rollback (fast) vs truncation (real commits, supports `afterCommit`). Recommend: **default savepoint, opt-in truncation per file.** Concurrent-sandbox (Phoenix-style) is a later revision.
3. **PGlite as the default test backend?** Big speed win for model tests; keep Testcontainers for fidelity suites. (Cross-ref the earlier PGlite spike idea.)
4. **Runner coupling.** vitest-first (matches the repo) but keep helpers runner-agnostic so a Jest/node:test user isn't locked out.
5. **Schema ownership (the "migrations boundary").** *Not a gap — a stance.* Drizzle owns tables + drizzle-kit owns migrations; active-drizzle owns behavior and makes **some** of the schema explicit at the model layer (which Rails leaves fully implicit). `ad db:*` are honest wrappers, not a reimplementation. Document this as a deliberate design decision, not a TODO.

---

## 7. The one-liner for the README, once this exists
> "`ad` gives you Rails' `rake`, Phoenix's `mix`, and Laravel's factories — with types Rails never had, because the generator already knows your schema."
