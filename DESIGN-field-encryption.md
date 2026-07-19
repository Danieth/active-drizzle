# Field encryption — chainable `.encrypt()`
### Design doc · 2026-07-19 · status: CORE BUILT — propagation layers TODO
### Goal: "encrypt any field" without losing the ability to find rows by it.

> **Built (69 tests):** the cipher (`runtime/encryption.ts` — AES-256-GCM, versioned format, `KeyProvider` seam, deterministic mode, blind-index helper), the chainable `.encrypt()` on every Attr, the fail-loudly query guards in `Relation`, and pg-value redaction in `reportError`.
>
> **Not built:** blind-index query rewrite, codegen/controller/React propagation (§3.7), S3 `ServerSideEncryption` (§5), KMS `KeyProvider`.

---

## 0. Encryption 101 (the parts that matter here)

Three different things get called "encryption" — you need the third:

| Layer | What it protects against | Do you have it? |
|---|---|---|
| **In transit** (TLS) | Network snooping | Yes — your DB/S3 connections |
| **At rest, whole-disk** (RDS/S3 encryption) | Someone stealing the physical disk | Usually on by default at the infra layer |
| **Application-level / per-field** | A **DB dump, a backup, a read-replica, a curious DBA, a leaked query log** — anyone who can `SELECT` | **No — this is what's missing** |

Only the third protects a column's contents from someone who legitimately reaches the database. That's what a finance app usually needs for PII.

### The one hard tradeoff: encrypted vs. searchable

This is the thing to internalize, because it drives every decision below.

Good encryption is **randomized** — encrypting `"12345"` twice gives two *different* ciphertexts (a random IV each time). That's what makes it secure. It also means the database can no longer match, sort, or range-scan the column: `WHERE ssn = '12345'` can never hit, because the stored bytes differ every time.

So you get to pick, **per field**:

| Mode | How | Query support | Leaks |
|---|---|---|---|
| **Randomized** (default, safest) | Random IV per write | ❌ none | nothing |
| **Deterministic** | IV derived from the plaintext, so equal input → equal ciphertext | ✅ **equality** (`where({ ssn })`) | which rows share a value (frequency analysis) |
| **Randomized + blind index** | Real value randomized; a *separate* HMAC column is indexed | ✅ **equality** (and prefix, if you index prefixes) | only that two rows share a value, via an opaque hash |

**What you can never do on an encrypted column:** `ILIKE`/substring search, range queries (`>`, `<`), `ORDER BY` by real value. If a field needs fuzzy search *and* encryption, you can't have both — decide which matters more.

### Key management is the actual hard part

The cipher is the easy bit (Node's built-in `crypto`, AES-256-GCM). The real work:

- **Envelope encryption** — don't encrypt data directly with your master key. Generate a data key (DEK), encrypt the data with it, then encrypt the DEK with a master key (KEK) held in a KMS. Store the wrapped DEK next to the data. Rotating the master key then only means re-wrapping DEKs, not re-encrypting every row.
- **Key versioning** — stamp a key id into the stored value so you can rotate without a big-bang re-encrypt.
- **Never in the repo** — KEK lives in AWS KMS / GCP KMS / Vault. A key in an env var is a *starting* point, not the destination.

---

## 1. Proposed API

Encryption is a **transform on write, reverse on read** — which is exactly what `Attr` already is (`set` / `get`). That makes this a remarkably natural fit.

The API is a **chainable `.encrypt()` on any existing Attr**, not a separate Attr kind — so it composes with every type for free (see [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md) §4 for the full build spec):

```ts
@model('people')
export class Person extends ApplicationRecord {
  static notes  = Attr.string().encrypt()                          // randomized — safest, NOT queryable
  static ssn    = Attr.string().encrypt({ deterministic: true })   // `where({ ssn })` works
  static email  = Attr.string().encrypt({ blindIndex: 'emailBidx' })
  static salary = Attr.money('salaryCents').encrypt()              // still does dollars↔cents
}
```

`.encrypt()` wraps whatever codec is underneath — `set: v => encrypt(innerSet(v))`, `get: raw => innerGet(decrypt(raw))` — so the type concern and the at-rest concern stay orthogonal.

### The nice consequence

`where()` already runs values through `Attr.set` (see `_applyHashWhere` in `relation.ts`). So for a **deterministic** field, equality queries work through the *existing* pipeline with no extra plumbing:

```ts
await Person.where({ ssn: '123-45-6789' }).first()
// Attr.set encrypts the search term → matches the stored ciphertext
```

For a **blind-index** field, `where({ email })` needs to rewrite the predicate onto the sidecar column — the one genuinely new piece of query plumbing.

### Storage format
Self-describing, so rotation and algorithm changes are possible later:

```
v1:<keyId>:<iv_b64>:<authTag_b64>:<ciphertext_b64>
```
Column type: `text` (or `bytea`). **Ciphertext is meaningfully larger than plaintext** — size the column accordingly.

---

## 2. Scope

**MVP**
1. Chainable `.encrypt({ deterministic?, blindIndex? })` on every Attr, built on Node `crypto` AES-256-GCM (authenticated — tampering is detected, not silently decrypted).
2. Envelope encryption with a pluggable key provider: `envKeyProvider` (dev) and `kmsKeyProvider` (prod). Key id embedded in the value.
3. Blind index: `hmac_sha256(indexKey, normalize(plaintext))` written to a declared sidecar column; `where()` rewrites onto it.
4. **S3: set `ServerSideEncryption` on `PutObjectCommand`.** Currently unset — this is a small, high-value fix independent of everything above.

**Later**
- Client-side envelope encryption for file *contents* (true end-to-end; breaks range reads + presigned direct download, so opt-in).
- Key rotation command (rewrap DEKs; optional re-encrypt).
- `pgcrypto` as an alternative backend.

**Explicitly out of scope**
- Searchable encryption beyond equality/prefix. No substring, no ranges, no ordering. Don't promise it.

---

## 3. What this breaks — the full implication matrix

> **The headline danger: most of these fail _silently wrong_, not loudly.** A randomized column doesn't error on `GROUP BY` — it returns one group per row. A unique index on it doesn't reject duplicates — it accepts them forever. Those are worse than an exception, which is why §3.3 ("fail loudly") is the single most important item in this doc.

### 3.1 Capability matrix

What each mode can still do at the database level:

| Operation | Randomized | Deterministic | Randomized + blind index |
|---|---|---|---|
| `IS NULL` / `IS NOT NULL` | ✅ | ✅ | ✅ |
| Equality `= x`, `IN (…)` | ❌ | ✅ | ✅ *(via sidecar)* |
| Range `>` `<` `BETWEEN` | ❌ | ❌ | ❌ |
| `ORDER BY` | ❌ | ❌ | ❌ |
| `ILIKE` / substring / full-text | ❌ | ❌ | ❌ *(prefix only, see §3.4)* |
| `GROUP BY` | 🟥 **silently wrong** (1 group per row) | ✅ *(keys are ciphertext)* | ✅ *(keys are opaque hashes)* |
| `COUNT(DISTINCT …)` | 🟥 **silently wrong** (= row count) | ✅ | ✅ |
| `UNIQUE` constraint | 🟥 **silently wrong** (never fires) | ✅ | ✅ *(index the sidecar)* |
| B-tree index usable | ❌ | ✅ | ✅ *(on the sidecar)* |
| `SUM`/`AVG`/`MIN`/`MAX` | ❌ | ❌ | ❌ |
| Read the value in app code | ✅ | ✅ | ✅ |

**Why ordering can never work:** encryption (and HMAC) deliberately destroy the relationship between input and output ordering. `ORDER BY ssn` on an encrypted column sorts by ciphertext bytes — a stable but *meaningless* order. Order-preserving encryption exists and leaks so much it's generally considered not worth it. Treat "encrypted **and** sortable" as impossible.

### 3.2 What it means for each surface in *this* library

| Surface | Randomized | Deterministic | Blind index | Action needed |
|---|---|---|---|---|
| `where({ col: v })` | throw | ✅ free (via `Attr.set`) | rewrite onto sidecar | new plumbing for blind only |
| `where({ col: { gte, lte } })` | throw | throw | throw | operator-hash guard |
| `order('col')` | throw | throw | throw | guard in `order()` |
| `seek(['col'])` | throw | throw | throw | keyset needs ordering |
| `search()` / `ftsSearch()` | throw | throw | throw | guard |
| `group('col')` | throw | ✅ *(decrypt group keys!)* | ✅ *(keys opaque)* | see below |
| `sum/average/min/max` | throw | throw | throw | guard |
| `pluck` / `select` / reads | ✅ | ✅ | ✅ | works via `Attr.get` |
| `distinct()` | throw | ✅ | ✅ | guard |
| `Validates.uniqueness()` | throw | ✅ | ✅ *(query sidecar)* | guard + rewrite |
| Controller `filterable` | reject | allow **equality only** | allow **equality only** | allowlist validation |
| Controller `sortable` / `searchable` | reject | reject | reject | allowlist validation |

**A nice touch we can afford:** for **deterministic** fields, `group()` already has the `Attr.get` codec, so the library can **decrypt the group keys** before returning the map — the caller gets `{ 'alice@x.com': 3 }` instead of `{ 'v1:k1:…': 3 }`. For a **blind index** that's impossible (an HMAC is one-way); those keys stay opaque unless the caller supplies the candidate values to hash and match back.

### 3.3 The rule: fail loudly, never silently

Every ❌ and 🟥 above must become an **error with a message that names the fix**, at the earliest possible moment:

- **Build time (preferred)** — the codegen validator already reads models + schema. It should reject: an encrypted attr on a non-`text`/`bytea` column; a `blindIndex` naming a column that doesn't exist; an encrypted field listed in a controller's `sortable`/`searchable`; a range/`gte` filter declared against an encrypted field.
- **Runtime** — `order()`, `seek()`, `search()`, the aggregates, and operator-hash `where()` throw when handed an encrypted field:
  ```
  Cannot ORDER BY encrypted field 'ssn' — ciphertext ordering is meaningless.
  Sort on a plaintext column, or store a separate sortable projection.
  ```
- **Never** let a query compile against an encrypted column and return zero/garbage rows.

The three silent-wrongness traps (`GROUP BY`, `COUNT(DISTINCT)`, `UNIQUE` on randomized) deserve explicit guards, because nothing else will ever tell you.

### 3.4 Blind index — the knobs and their costs

A blind index is `hmac_sha256(indexKey, normalize(plaintext))` stored in a sidecar column and indexed.

- **Normalization is part of the contract.** Lowercase/trim before hashing, or `A@B.co` and `a@b.co` won't match. Whatever you choose must be frozen — changing it later invalidates every stored hash and forces a rebuild.
- **Truncation trades privacy for precision.** A full 256-bit hash is an exact-match index — and therefore leaks equality just like deterministic mode (frequency analysis applies to the *sidecar*). Truncating to, say, 16–32 bits makes distinct plaintexts **collide on purpose**: the index becomes a cheap *filter*, not an answer. You fetch the candidate rows, decrypt, and compare in app code. Fewer bits = better privacy, more false positives, more decryption work.
- **Prefix search costs another index.** Want `starts_with('smi')`? Store a second blind index over the first N normalized characters. Every extra index is another equality oracle — more query power, more leakage.
- **One sidecar per queryable field.** They're not free: extra column, extra index, extra write cost, and they must be backfilled and rotated alongside the real value.

### 3.5 Choosing a mode (the guidance that actually matters)

- **Default to randomized.** If a field is never looked up, it should never be queryable.
- **Never deterministically encrypt a low-cardinality column.** `status`, `gender`, `state`, `tier` — with a handful of distinct values, equal ciphertexts plus public distributions make frequency analysis trivial. Deterministic mode is for high-cardinality identifiers (email, SSN, account number) where knowing "these two rows match" reveals much less.
- **Prefer a blind index over deterministic** when you need lookup on something sensitive — it keeps the stored value randomized and lets you dial leakage down via truncation.
- **If a field needs fuzzy search, ranges, or sorting, it cannot be encrypted.** Decide which matters more; there is no third option. A common compromise: encrypt the sensitive field and keep a separate non-sensitive projection (e.g. `lastFour`, `domain`, a coarse bucket) for filtering and display.

### 3.6 Operational consequences

- **Backfill.** Encrypting an existing column = widen it to `text`, then read → encrypt → write every row, under a key ceremony. Adding a blind index later = a second backfill to populate the sidecar. Plan a **dual-read transition** (try decrypt, fall back to plaintext) so the app keeps working mid-migration.
- **Rotation.** Envelope encryption means rotating the master key only rewraps DEKs. Rotating a *data* key means re-encrypting rows; rotating the *index* key means rebuilding every sidecar.
- **Performance.** Every read decrypts — a `pluck` of 10k rows × 3 encrypted fields is 30k decrypt calls. Randomized columns can't use an index at all, so any accidental filter on one degrades to a full scan (another reason to reject it at build time).
- **Losing the key loses the data.** Key backup/escrow is a product decision, not a library one — but the docs must say it out loud.

---

## 3.7 Propagation — the rules must reach the frontend

Encryption is decided in the model but *enforced* in five places. If the rule stops at the ORM, the UI happily renders a sort header that returns garbage.

```
Attr.encrypt()  →  _encrypted marker
      │
      ├─ Relation guards ...................... ✅ BUILT (throws on order/range/search/aggregate)
      ├─ codegen: carry _encrypted into meta ... ⬜ TODO
      ├─ controller allowlists (filter/sort/search) ⬜ TODO
      ├─ envelope: per-field capability ........ ⬜ TODO
      └─ React: filter/sort/table UI ........... ⬜ TODO
```

### The distinction that drives the UI: server-side vs client-side

**The wire carries plaintext.** The server decrypts on read (`Attr.get`) and serializes through `expose`, so an API response contains real values — encryption here is *at rest*, not end-to-end. That means:

- **Client-side operations on an already-fetched page work fine.** Sorting or filtering the 25 rows in the browser operates on plaintext. Nothing to block.
- **Server-side operations across the whole table do not.** Sorting a paginated list, filtering before pagination, or a `?q=` search all happen in SQL — impossible.

So the UI rule isn't "encrypted fields are inert," it's **"encrypted fields can't participate in *server-driven* list operations."** That's exactly the set the controller allowlists govern.

### What each layer must do

| Layer | Rule |
|---|---|
| **codegen** | Emit `_encrypted: { mode, blindIndex? }` into the model meta and the generated client types, so downstream layers can see it without importing the model. |
| **controller `filterable`** | Reject randomized fields outright. Allow deterministic/blind for **equality only** — reject `gte`/`lte`/`contains` operators at config-validation time, not request time. |
| **controller `sortable` / `searchable`** | Reject every encrypted field at build time. |
| **envelope** | Add a per-field capability alongside the existing `abilities` map, e.g. `{ email: { encrypted: 'deterministic', ops: ['eq'] } }`. The client already consumes the envelope, so this is the natural carrier. |
| **React** | Filter builder offers only the permitted operators (an equality input, never a range or "contains"); table headers for encrypted fields are not sortable; the global search box doesn't claim to cover them. |

The build-time half matters most: **a wrong allowlist is a silently-empty result set**, and the validator already reads both models and controller config, so it can catch every case before the app runs.

---

## 3.8 Derived copies — where encryption actually leaks (incl. Elasticsearch)

> **Encryption is only as strong as the leakiest copy of the data.**

This is the part people miss. The database column is ciphertext, but plaintext still flows to every *derived* store, and each one is a full bypass:

| Derived copy | Exposure |
|---|---|
| **Elasticsearch / OpenSearch index** | 🔴 holds plaintext, fully searchable, usually weaker auth than the DB |
| Redis / query cache | 🔴 plaintext values |
| Materialized views, analytics warehouse, CDC/replication streams | 🔴 plaintext |
| CSV / PDF exports, audit logs, `console.log` | 🔴 plaintext |
| Error trackers | ✅ handled — see the redaction work |

### The Elasticsearch decision

If you index an encrypted field into ES, **you have not protected it — you have moved the exposure** from a hardened database to a search cluster. Three honest options:

1. **Don't index encrypted fields (recommended default).** The indexer skips any field carrying `_encrypted`. Search covers plaintext fields only. Simple, and it holds automatically as new fields get encrypted.
2. **Index blind-index tokens only.** Exact-match lookup without plaintext — but you lose analyzers, stemming, fuzziness, and relevance ranking, i.e. the entire reason to run ES.
3. **Treat ES as a second trusted store** — its own at-rest encryption, network isolation, and access control — and accept the duplicated exposure as a documented, deliberate risk.

**This should be enforced, not remembered.** Option 1 becomes real only if the indexer reads `_encrypted` and skips those fields by construction; a convention in a README will be violated the first time someone adds a field. Same enforcement argument applies to exports and cache-key builders.

The general rule worth putting in the user docs: **the moment you `.encrypt()` a field, audit every place that value gets copied.** The ORM can guard SQL; it cannot guard your indexer.

---

## 4. Decisions needed (Daniel)

1. **Default mode** — randomized (safest) or deterministic (convenient)? Recommend **randomized by default**, opt into `deterministic`/`blindIndex` per field, so the safe thing is the default.
2. **Key provider for v1** — env-var key to ship, KMS interface designed from day one? Recommend yes: ship `envKeyProvider`, define the `KeyProvider` interface so KMS drops in later.
3. **Which fields actually need search?** Encrypt-everything is easy; the cost is per-field query loss. Worth listing the real PII columns and marking which need lookup — that alone decides most of the design.
4. **Do file *contents* need encryption**, or is SSE-KMS at rest enough? SSE is a one-line change; client-side envelope is a project.

---

## 5. Do this first, regardless
Set `ServerSideEncryption: 'aws:kms'` (or `'AES256'`) on the S3 `PutObjectCommand` in `packages/core/src/storage/`. It's a few lines, needs no key management on our side, and gets every upload encrypted at rest today. Cross-referenced in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md) §4.
