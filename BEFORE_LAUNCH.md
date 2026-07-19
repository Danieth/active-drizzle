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

For a financial app, encrypting PII/secrets is often a compliance line, not a feature. And the *format* is a launch decision: adding encryption to columns/files that already hold plaintext later means a data-backfill + key ceremony — painful and risky post-launch. Scope it now, ship at least the MVP before release.

**A. Field-level encryption — `Attr.encrypted(...)`.** Three modes, because "encrypted but still searchable" is the real requirement:
- **Non-deterministic (default, most secure):** random IV per value → same plaintext yields different ciphertext → **not** queryable. For fields you never search (tokens, secrets).
- **Deterministic (`{ deterministic: true }`):** same plaintext → same ciphertext → supports **equality** queries (`where({ ssn })` matches on ciphertext). Leaks equality; use for fields you must look up exactly.
- **Blind index (the advanced "we can still search" answer):** keep the real value non-deterministically encrypted, and emit a **separate keyed-HMAC column** that *is* queryable (CipherSweet-style). Gives exact-match (and, with tricks, prefix) search without deterministic leakage. This is the one worth showing off.
- **Key management is the hard part, not the cipher:** per-attribute keys via **envelope encryption** (a data key encrypted by a KMS master key), plus a **rotation** story. Get the on-disk format right up front (versioned so keys can rotate).

**B. File encryption on the S3/attachments layer — automatic.**
- **Easy default (ship this): SSE-KMS.** One header on `PutObject` → server-side encryption with an auditable KMS key. Make it the storage layer's default so every upload is encrypted at rest with zero app code. Cheap, big compliance win.
- **Stretch: client-side envelope encryption.** Encrypt bytes *before* upload with a data key (itself KMS-wrapped); store the wrapped key alongside. True end-to-end — S3 never sees plaintext — but it breaks range reads / direct presigned downloads (needs a decrypt proxy), so it's an opt-in advanced mode, not the default.

**MVP for launch:** deterministic + blind-index `Attr.encrypted` with KMS envelope keys, and **SSE-KMS on by default** for attachments. Client-side file envelope encryption can be a fast-follow.

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
| 4 | CHANGELOG / semver / example / runtime matrix | Trust | Adoption + "safe to build on" |
