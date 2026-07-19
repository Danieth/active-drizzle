# BEFORE_LAUNCH

Hard blockers to clear before a public/1.0 launch. These are things that are **either impossible to change later without breaking users, or that destroy first-impression trust.** Feature ideas live in [NICE_TO_HAVE.md](NICE_TO_HAVE.md); workflow/testing design lives in [DESIGN-tasks-and-testing.md](DESIGN-tasks-and-testing.md).

---

## 🔴 1. Generated code must `tsc --noEmit` clean  (CRITICAL)

**Why it's a blocker:** we are a *TypeScript-first* library. The first thing a skeptical adopter does is run `tsc`. A red typecheck reads as "not ready" even though the app runs fine — it torpedoes trust before anyone evaluates the actual DX. Right now `npm run typecheck` is **not** clean (documented in `README-BUGS-FOUND.md`).

Known failures to fix (from `README-BUGS-FOUND.md`, verify the list is still current):

- **Dangling `import type` for controller-less nested children.** `deal.gen.ts` does `import type { NoteAttrs } from './note.gen'` for every nested child model that has **no** controller (Note, Task, Brief), but `note.gen.ts` is only emitted for models that *have* a controller — so the module is missing. Fix: emit a lightweight `{child}.gen.ts` (just the `{Child}Attrs` interface) for controller-less nested children, or inline the nested attrs into the parent's `.gen.ts`.
- **`{Model}Client` "incorrectly extends ClientModel."** Generated `id` is `id?: number` (optional) while the base wants it required. Fix: generate `id: number | null` on the client to match `ClientModel`.
- **`@model(...)` + `static name = Attr.string(...)` trips `TS1238`/`TS1270`** — the `name` static collides with `Function.name`. Fix: handle the `name` attribute specially in codegen (already partially addressed by `f2a7c77 fix: class-name lookups survive static name = Attr shadowing` — confirm the *generated* side is clean too).

**Definition of done:** `npm run typecheck` is green across all packages **including generated output**, and there's a test/CI gate that regenerates fixtures and typechecks them so it can't regress.

> Note: core typecheck was observed erroring on `react-generator.ts` (TS2345, template-literal type) during a live edit — confirm that's resolved and not a generated-code leak.

---

## 🟠 2. Don't leak internal errors across the trust boundary  (SECURITY — launch blocker)

Confirm the controller adapter turns **any** non-`HttpError` into a generic 500 that does **not** echo `err.message`. Raw DB errors can leak schema/SQL/table names to the client. This is the error-side of the "model allows, controller gates" rule. Cheap to get wrong, expensive to discover in the wild. (The rest of the error-handling roadmap is in NICE_TO_HAVE — but this one item is a security blocker, not a nicety.)

---

## 🟠 3. Commit to a stable error-code contract  (breaking to add later)

Today DB/validation errors surface as English strings (`"has already been taken"`). If apps depend on those strings, adding machine-readable codes later is a **breaking change**. Decide *now* whether every error carries a stable `code` (`blank`/`taken`/`too_long`/…) alongside its default message, so apps can i18n/override without string-matching. Full rationale in NICE_TO_HAVE §"error handling" — but the *timing* is a launch decision, which is why it's flagged here.

---

## 🟠 4. Encryption at rest — field + file  (finance domain → do it before release)

> **Status: nothing implemented.** Scanned 2026-07-19 — no encrypt/decrypt/cipher/KMS code, no crypto deps, no `Attr.encrypted`, and the S3 layer doesn't set `ServerSideEncryption`. Crypto background + the tradeoffs live in [DESIGN-field-encryption.md](DESIGN-field-encryption.md); this section is the **build spec**.

For a financial app this is usually a compliance line, not a feature. And the storage *format* is a launch decision: adding encryption to columns that already hold plaintext later means a backfill + key ceremony — painful post-launch.

### 4A. The API — a chainable `.encrypt()` on any Attr

Encryption should be **one chainable modifier**, not a separate Attr kind:

```ts
@model('people')
export class Person extends ApplicationRecord {
  static ssn     = Attr.string().encrypt()                          // randomized — safest, NOT queryable
  static email   = Attr.string().encrypt({ deterministic: true })   // where({ email }) works
  static phone   = Attr.string().encrypt({ blindIndex: 'phoneBidx' })
  static salary  = Attr.money('salaryCents').encrypt()              // composes with the money codec
  static profile = Attr.json().encrypt()                            // composes with JSON too
}
```

**Why this shape:** an `Attr` is already a `get`/`set` transform pair. `.encrypt()` is just a **decorator that wraps whatever codec is underneath** — so it composes with *every* Attr type for free, and the type/codec concern stays orthogonal to the at-rest concern. `Attr.money(...).encrypt()` still does dollars↔cents; it just stores ciphertext.

```ts
set: (v) => encrypt(innerSet(v))      // model value → codec → ciphertext
get: (raw) => innerGet(decrypt(raw))  // ciphertext → codec → model value
```

### 4B. Why deterministic mode is nearly free

`where()` already runs hash values through `Attr.set` (see `_applyHashWhere` in `relation.ts`). So for a deterministic field, the search term gets encrypted by the *same* codec and matches the stored ciphertext — **equality queries work through the existing pipeline with zero new query plumbing**:

```ts
await Person.where({ email: 'a@b.co' }).first()   // just works
```

`blindIndex` is the only mode needing new plumbing: `where()` must rewrite the predicate onto the sidecar HMAC column.

### 4C. Implementation notes (one change point, not twenty)

- Attach the chainable in **one** helper that every `Attr.*` factory returns through — don't edit 20 factories:
  ```ts
  function chainable(config) {
    Object.defineProperty(config, 'encrypt', { enumerable: false, value: (opts = {}) => ({
      ...config,
      _encrypted: { mode: opts.deterministic ? 'deterministic' : 'randomized', blindIndex: opts.blindIndex },
      set: (v) => encrypt((config.set ?? (x => x))(v), opts),
      get: (raw) => (config.get ?? (x => x))(decrypt(raw)),
    })})
    return config
  }
  ```
  Non-enumerable so it never leaks into `Object.keys`/serialization (same trick `installHelpers()` uses).
- **Ciphertext is text.** An encrypted `Attr.integer()` must map to a `text`/`bytea` column. The codegen validator already checks columns — teach it to **fail the build** when an `_encrypted` attr points at a non-text column, and when `blindIndex` names a column that doesn't exist.
- **Controller allowlists must reject randomized fields** in `filterable`/`sortable`, or you'll generate queries that silently return nothing.
- AES-256-GCM (authenticated), versioned value format `v1:<keyId>:<iv>:<tag>:<ct>` so keys can rotate. Envelope encryption with a pluggable `KeyProvider` (`envKeyProvider` to ship, `kmsKeyProvider` designed in from day one).

### 4D. ⚡ Quick win — do this one first, it's independent

**Set `ServerSideEncryption` on the S3 `PutObjectCommand`** in `packages/core/src/storage/`. It's a few lines, requires **no key management on our side**, and gets every upload encrypted at rest today:

```ts
new sdk.PutObjectCommand({ ...existing, ServerSideEncryption: 'aws:kms' })  // or 'AES256'
```

Make it the storage layer's default (configurable). Cheap, immediate compliance win, zero coupling to 4A–4C.

### 4E. Query-surface guards — the part that will bite you

Encrypting a column removes most of the query surface, and **the failures are silent, not loud**. Full matrix in [DESIGN-field-encryption.md](DESIGN-field-encryption.md) §3; the must-dos:

- **Three silent-wrongness traps on randomized fields** — nothing will ever tell you these are broken:
  - `GROUP BY` returns **one group per row** (every ciphertext is unique).
  - `COUNT(DISTINCT …)` returns the **row count**.
  - A `UNIQUE` index **never fires** — duplicates are accepted forever.
- **Reject at build time** (codegen validator): encrypted attr on a non-`text` column; `blindIndex` naming a missing column; an encrypted field appearing in a controller's `sortable`/`searchable`; a range filter (`gte`/`lte`) declared on an encrypted field.
- **Throw at runtime** from `order()`, `seek()`, `search()`/`ftsSearch()`, `distinct()`, the aggregates, and operator-hash `where()` when handed an encrypted field — with a message naming the fix, e.g. *"Cannot ORDER BY encrypted field 'ssn' — ciphertext ordering is meaningless. Sort on a plaintext column, or store a sortable projection."*
- **Controller allowlists**: `filterable` may allow **equality only** on deterministic/blind fields; `sortable` and `searchable` must reject every encrypted field outright.
- **Free win while you're there:** for *deterministic* fields, `group()` has the `Attr.get` codec — decrypt the group keys before returning, so callers get `{ 'alice@x.com': 3 }` instead of `{ 'v1:k1:…': 3 }`. (Impossible for blind indexes — an HMAC is one-way.)

**MVP for launch:** `.encrypt()` with randomized + deterministic modes and an env-var `KeyProvider`, validator enforcement of the text-column rule, the §4E guards, and SSE on by default for attachments. Blind index and client-side file envelope encryption can be fast-follows.

---

## 🟡 5. Trust-signal minimums for a public release

- **`CHANGELOG.md` + a stated semver/deprecation policy.** "We won't break you" is what makes someone build on a `0.x`. (Currently absent.)
- **`LICENSE` + `CONTRIBUTING.md`** present and correct (MIT is declared in `package.json` — ensure a `LICENSE` file exists).
- **A runnable example app** (see DESIGN doc / NICE_TO_HAVE) — not strictly a *blocker*, but the single biggest adoption lever and the best pre-launch dogfood. Strongly consider gating launch on it.
- **Supported-runtime matrix** — say explicitly which Drizzle drivers/runtimes are supported (node-postgres, postgres-js, Neon-http, PGlite, Workers/edge). We're driver-agnostic (`boot()` takes any Drizzle instance) — that's a strength worth stating, and a claim worth testing.

---

### Triage summary
| # | Item | Class | Why it can't wait |
|---|---|---|---|
| 1 | Generated code typechecks clean | Correctness/trust | First thing evaluators run |
| 2 | No internal-error leakage | Security | Data exposure across boundary |
| 3 | Stable error codes | API contract | Breaking to add post-launch |
| 4 | Encryption at rest (field + S3 file) | Compliance/format | Backfill + key ceremony painful post-launch |
| 5 | CHANGELOG / semver / example / runtime matrix | Trust | Adoption + "safe to build on" |
