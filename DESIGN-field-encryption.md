# Field encryption — `Attr.encrypted`
### Design doc · 2026-07-19 · status: PROPOSED (nothing implemented yet)
### Goal: "encrypt any field" without losing the ability to find rows by it.

> **Current state: there is ZERO encryption in the codebase.** Scanned 2026-07-19 — no `encrypt`/`decrypt`/`cipher`/`pgcrypto`/KMS code, no crypto dependencies, no `Attr.encrypted`, and the S3 storage layer does **not** set `ServerSideEncryption` on upload. This doc is the plan, not a description of something that exists.

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

```ts
@model('people')
export class Person extends ApplicationRecord {
  // randomized — maximum safety, NOT queryable
  static notes = Attr.encrypted()

  // deterministic — `where({ ssn })` works
  static ssn = Attr.encrypted({ deterministic: true })

  // randomized value + queryable blind-index sidecar column
  static email = Attr.encrypted({ blindIndex: 'emailBidx' })
}
```

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
1. `Attr.encrypted({ deterministic?, blindIndex? })` built on Node `crypto` AES-256-GCM (authenticated — tampering is detected, not silently decrypted).
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

## 3. What this breaks (be honest in the docs)

- **Existing data must be backfilled** — read, encrypt, write, in a migration with a key ceremony. This is why the *format* decision belongs before 1.0, not after.
- **Unique constraints** only work deterministically or via a unique index on the blind-index column.
- **Indexes on the real column are useless** (they index ciphertext).
- **Losing the key loses the data.** Key backup/escrow is a product decision, not a library one.
- Encrypted columns can't be filtered/sorted by the controller's `filterable`/`sortable` — the allowlists must reject them, or you'll generate queries that silently return nothing.

---

## 4. Decisions needed (Daniel)

1. **Default mode** — randomized (safest) or deterministic (convenient)? Recommend **randomized by default**, opt into `deterministic`/`blindIndex` per field, so the safe thing is the default.
2. **Key provider for v1** — env-var key to ship, KMS interface designed from day one? Recommend yes: ship `envKeyProvider`, define the `KeyProvider` interface so KMS drops in later.
3. **Which fields actually need search?** Encrypt-everything is easy; the cost is per-field query loss. Worth listing the real PII columns and marking which need lookup — that alone decides most of the design.
4. **Do file *contents* need encryption**, or is SSE-KMS at rest enough? SSE is a one-line change; client-side envelope is a project.

---

## 5. Do this first, regardless
Set `ServerSideEncryption: 'aws:kms'` (or `'AES256'`) on the S3 `PutObjectCommand` in `packages/core/src/storage/`. It's a few lines, needs no key management on our side, and gets every upload encrypted at rest today. Cross-referenced in [BEFORE_LAUNCH.md](BEFORE_LAUNCH.md) §4.
