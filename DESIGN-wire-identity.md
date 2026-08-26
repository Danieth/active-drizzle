# DESIGN — The Wire/Identity Upgrade (comms layer, solved once)

### Status: PROPOSED · 2026-08-26 · supersedes cache-coherence REV 2's per-door
### slice tier; completes DESIGN-entity-store's wiring plan; absorbs the
### comms-layer benchmarks (scratchpad: wire-shootout / e2e-shootout).

## 0. First principles

Everything below falls out of five statements. Each is already a law,
an invariant, or a measured fact in this repo — the upgrade is not new
ideas, it is the existing ideas applied to every layer at once.

- **P1 — One representation per field, everywhere.** The serialization-
  fidelity LAW: model-owned Attr codecs are THE representation; doors
  mask fields, never transform them. Consequence: any two payloads
  mentioning the same record agree on shared fields, so merging by
  `[model, pk]` is sound at every layer — client store, wire, DB loader.
  (This is what Apollo/Relay never had; it is why they guess and we
  compile.)

- **P2 — Identity and membership are different data.** A record's VALUES
  (identity) change often, merge by version, and are the same through
  every door. WHICH records a surface shows (membership: pk-sets, order,
  pagination, aggregates, facets) is server-only truth (A2) that cannot
  be merged, only re-asked. Consequence: separate them in the cache
  (EntityStore vs React Query — BUILT), on the wire (entities section vs
  membership section — THIS DOC), in invalidation (values patch,
  structure invalidates — REV 3), and in the DB loader (per-table loads
  vs the pk/aggregate query).

- **P3 — Versions order everything; freshness certifies per-slice.** One
  monotonic numeric token per record (lock int preferred — updatedAt
  millis is a display field cosplaying as a Lamport clock and ties within
  a millisecond; ONE kind per model, enforced by codegen). Every apply
  path — store merge, form rehydrate, WS signal, IndexedDB restore — is
  the same compare: `incoming < known → drop`. But a token certifies
  ONLY the fields present in the payload (the partial-merge law, §3a):
  record-level "is it current?" is not a well-formed question when doors
  are projections; the question is always asked per door-slice.
  Consequence: staleness is impossible to APPLY and impossible to
  MISREPORT, so caching/persisting/patching aggressively is SAFE by
  construction, not by discipline.

- **P4 — The server never makes the client guess.** The unified write
  path knows the true write-set of every request (`touched`, write-effect
  graph, afterCommit). Consequence: mutation echoes carry what changed;
  signals carry `{resource, id, op, version}`; the client's only guessing
  game — "did anything I show change?" — is answered, not inferred.

- **P5 — The cheapest byte is the one not sent.** In order of leverage
  (measured): don't resend entities the client holds (normalization +
  versions), don't resend keys per row (columnar), don't refetch values
  at all (echo patching), don't refetch unchanged membership (ETag/304),
  don't pay per-request overhead (batch link). Codec choice (JSON vs
  msgpack vs protobuf) is the LAST and smallest lever: post-brotli it is
  worth ~0–18%, and only the columnar/normalized envelope makes even
  that reachable.

- **P6 — App code sees none of this.** Every mechanism lives in codegen
  output and framework runtime. The app-visible API (doors, hooks,
  presenters, FormSession) is byte-for-byte unchanged. A mechanism that
  requires app participation is rejected on that ground alone.

Why this "universally makes sense": P1 makes merging sound, P2 makes
merging *sufficient* (what can't merge is exactly what refetches), P3
makes it safe under any concurrency, P4 makes it precise, P5 makes it
fast, P6 makes it free. Remove any one and the design degrades to a
known failure mode: no P1 → Apollo's corruption; no P2 → sync-engine
research; no P3 → clobbered writes; no P4 → over-invalidation; no P5 →
today's bytes; no P6 → a framework nobody should have to learn.

## 1. The wire envelope (the missing half of the EntityStore)

Every read door's response becomes:

```
{
  membership: { pks: [7,3,9], pagination: {...}, facets?: {...} },
  entities: {
    proposals: { k: ['id','title','status','amount','loanId','updatedAt'],
                 r: [[7,'…','open','12.00',2,1756…], …] },
    loans:     { k: [...], r: [...] },          // included entities, ONCE each
  },
  version?: token,          // detail doors: the envelope record's token
  touched?: [{resource,id,op,version}]          // mutation echoes only
}
```

- **Normalized:** every record appears exactly once, in its own model's
  table, FLAT — associations are FK fields (`loanId`), never embedded
  objects. hasMany membership rides the OWNER as an ordered pk-array
  field (`noteIds`) versioned with the owner (membership of an
  association is a property of the parent — A2, P2) — but ONLY for
  bounded collections: codegen emits the pk-array form iff the
  association's cardinality is declared/known small (the UI treats it as
  a field); unbounded collections stay membership queries (paged pk
  lists). Reorder of an ordered pk-array is a STRUCTURAL op and bumps
  the parent token; concurrent membership edits ride the parent's
  optimistic lock (CAS), or they are last-write-wins and that door must
  not use the array form.
- **Columnar with a self-describing `k` header:** keys once per table,
  not once per row. Text JSON. Measured (V8, brotli-4, 20×40×8 nested
  graph w/ shared lookups; scratchpad e2e-shootout.mjs): nested JSON
  55.2K compressed / 5.4ms client decompress+decode-to-graph → norm+col
  JSON 19.6K / 1.5ms (proto over the same tables: 15.9K / 1.8ms — the
  deferred last ~18%). End-to-end at 5KB/s+300ms RTT: 11.6s → 4.3s.
  Zero bundle cost, network tab stays readable. The `k` header is also the
  stale-bundle safety: unknown columns ignored, absent columns absent —
  protobuf field-number evolution semantics without protobuf.
- **Projection-sliced per table:** `sliceByProjection`'s recursive walk
  is replaced by per-table column picking (the ceiling tree maps 1:1
  onto the tables). Same ceilings, simpler enforcement.
- **Codec-negotiable (later, P5-last):** the envelope is a VALUE; the
  oRPC link is the ONE seam that encodes it. JSON now; a packed codec
  (protobuf/msgpack over the same table structure) can be negotiated
  per-request later without touching anything above the link.

## 2. The server side: load flat, serve flat

Include-loading for doors switches from drizzle RQB's single nested
query to per-table batched loads (`WHERE fk IN (parent pks)`) — the
Rails strategy. This is not a compromise for the wire's sake; it is
better on its own:

- The DB returns flat uniform rows per table — the envelope's tables,
  with no nested graph ever materialized, walked, or re-flattened
  (today: PG json → drizzle parse → model wrap → toJSON → slice →
  stringify; after: PG rows → cast → columns).
- Attr casts (and field decryption) run per-COLUMN over homogeneous
  arrays instead of per-row over heterogeneous objects.
- Model hooks and encrypted fields still pass through the model layer —
  the LAW's codecs are per-field and vectorize; nothing bypasses them.
- **Parity checklist for the flag flip** (what the nested query gave us
  that per-table loads must re-prove, test-enforced per door): same row
  set, same ordering (association order clauses), same door ceilings
  applied, encrypted attrs through codecs, association `where`/`limit`
  conditions honored.

## 3a. THE PARTIAL-MERGE LAW (the one new invariant the envelope requires)

Doors are projections — 3 fields on one door, 20 on another — and that
is inherent (ceilings are AUTHORIZATION, so "just send one canonical
projection per model" is rejected: a 3-field door must not transmit the
other 17). Therefore a record-level version cannot certify a merge:
door B's 3-field slice at v11 must not make the store claim door A's
absent 17 fields are v11-fresh (the Apollo partial-entity bug).

The law, in four clauses. Identity is `(model, pk, field)`; door and
projection are COVERAGE of identity, never part of the key.

1. **Values merge globally, gated per FIELD.** One entry per
   `[model, pk]`. Incoming row at token V with columns C: for each
   field in C, write iff `V ≥ field.lastSeen`, then `lastSeen = V`.
   Fields outside C are untouched — values AND lastSeen. Sound because
   of the serialization-fidelity LAW (P1).
   *This SUPERSEDES I2's drop-whole clause, deliberately:* drop-whole
   was correct when a record-level version couldn't say which fields
   were fresher; per-field monotonicity is strictly more precise and
   preserves I2's intent exactly — no field ever regresses. (Amend
   DESIGN-entity-store I2 when this lands.)
2. **A token certifies only the fields present in the payload.**
   `entry.knownVersion` is the HIGH-WATER MARK: max token ever heard
   for this pk from ANY source — echo, load, or a signal-only frame
   with no payload at all. It is a staleness bound, never a freshness
   claim.
3. **Freshness is per-field, judged per projection.** A field is
   current iff `lastSeen ≥ knownVersion`; a projection (door view,
   form, card) is current iff every field it reads is current.
   Conservative by design: a signal can't say which fields moved
   (signal-only doctrine), so all trailing fields become suspect;
   `changedFields` frames are the future precision trim. Since
   projections are CLOSED compiled sets over the stable `k` field
   order, coverage compresses to a bitset + small version array per
   entry — or the coarser per-projection check, sufficient through
   phase 4.
4. **The projection is the FETCH UNIT.** Codegen numbers each model's
   distinct ceilings; the stale path is `get(model, pk, projId)` with
   `If-None-Match: <knownVersion>` — the server replies 304 (one
   integer compared) or exactly the dirty slice. The server validates
   projId against the requesting door's ceiling — a client-supplied id
   can never widen access. The receipt NEVER goes upstream beyond this:
   no field-mask uploads, no "what I hold" inventories (see §7).

Corollary (the store/view split, stated so P6 survives): the EntityStore
holds the UNION of fields this session has legitimately received; every
read path back out goes through a door-typed handle that masks the union
down to that door's ceiling. Storage is model-keyed; PROJECTION is
per-door, permanent, and type-enforced. What §3 retires is the per-door
STORAGE tier (duplicate value copies per door) — never the per-door
view. One copy of the values; N projected, ceiling-safe views of it.

## 3. The client side: wire the store, shrink the queries

The generated response handler (the I1 single origin) does exactly two
things: `entities` tables → `store.mergeRows` (per model, version-gated,
notify-coalesced); `membership` → the React Query entry. RQ entries
become tiny and mostly-stable (pk arrays structurally share), so RQ's
own re-render behavior improves for free.

Store hardening required first (the critique ledger):
- **Flat-row contract, enforced:** merge() rejects (dev-mode throws on)
  object-valued fields other than declared pk-arrays/jsonb Attrs; the
  nested-envelope poisoning path becomes unrepresentable.
- **Per-field versions** (the partial-merge law, §3a) beside fieldTicks;
  door handles expose slice-scoped freshness.
- **fieldTicks equality per Attr kind** (scalar `!==`; jsonb/pk-array by
  cheap structural compare) — no spurious flashes.
- **Notify coalescing:** mergeRows batches notifications per microtask.
- **One version-token kind per model** (lock int preferred), emitted and
  checked by codegen.
- **composeEntity patch order = mutation submission order,** stated.
- **RETIRED:** cache-coherence REV 2's per-(DOOR,id) slice STORAGE tier
  — duplicate per-door value copies. The subset doctrine made
  model-keyed identity sound; two identity STORES is one too many.
  Per-door projection itself is permanent (§3a corollary): door-typed
  handles remain the only read path, so retiring the tier retires
  nothing app-visible. (Rev-3 inline patching survives as: echoes merge
  into the STORE, not into per-door query data.)

## 4. The refetch storm, dissolved (P2 + P4 + P5)

Today: one mutation → family-prefix invalidation → every mounted query
refetches its FULL payload. After:

The three value paths, exhaustively (no fourth exists):

1. **Own writes: values never refetch.** The mutation echo's `touched`
   (`op ∈ create|update|destroy` — destroy drops the entry AND lets
   optimistic rows the server did not commit drain) + entity payloads
   merge into the store; every surface rendering those records updates
   instantly. (Own-write payloads are door-authorized — REV 3 rule 6.)
2. **Other-client values, already current:** signal `{resource, id, op,
   version}` checks per-slice freshness (§3a) BEFORE any fetch —
   current slices skip the round trip entirely.
3. **Other-client values, stale:** the affected projection fetches
   `get(model, pk, projId)` with `If-None-Match: knownVersion` (§3a.4)
   — never the family — merges its slice, notifies. Small, targeted,
   ceiling-respecting; already-current races resolve as a 304. (If this
   path refetched the door family it would be the old storm with better
   marketing; it must not.)

Structure is the only thing that invalidates
(create/destroy/reparent/reorder — membership questions), and what
refetches is MEMBERSHIP-sized: hundreds of bytes, not payloads. Those
refetches are **coalesced** by oRPC's batch plugin into one HTTP request
(off-the-shelf; enabled in the generated link; RQ dedupes identical keys
as today) and **304-guarded**: the membership ETag is a pure STRUCTURE
token — pk-set + order + count + pagination-cursor identity (+ facet
signature where the door serves facets, since aggregates legitimately
move with values) — NEVER row `updatedAt`, so value churn cannot bust
it. Unchanged membership costs one RTT and zero bytes; the coherence
engine's deliberate coarseness stops costing bytes — over-invalidation
becomes over-*confirmation*.

## 5. Persistence (the warm boot) — last, and nearly free

Snapshot the EntityStore (+ RQ persister for membership keys) into
IndexedDB. Restore on boot paints instantly from stale truth; P3 makes
restoration SAFE (a restored entity is just an old merge — anything
fresher wins) and revalidation cheap (§4's machinery). What P3 does NOT
make free, and phase 6 must carry: a store schema version beside the
snapshot (codegen bump invalidates it wholesale), quota handling
(snapshot is best-effort, never load-bearing), and a single-writer lock
across tabs (Web Locks; readers unrestricted). No app code.

## 6. Phasing (each slice independently shippable, none blocks the next)

1. **Store hardening** (§3 ledger) + retire the slice tier. Pure react
   package.
2. **Envelope + handlers:** normalized/columnar wire behind a per-door
   codegen flag; generated handlers wire the store; nested envelope
   remains the compat default until parity, then flips.
3. **Flat loading:** per-table batched include-loading behind the same
   flag (server-side twin of 2; can land before or after).
4. **Storm controls:** echo merging, membership-only refetch, batch
   link, ETags.
5. **Signals with versions** (rides DESIGN-ws-channels when it lands).
6. **IndexedDB persistence.**
7. **(someday, measured-need only)** packed codec at the link; delta
   membership; shared compression dictionaries.

## 7. What this explicitly does not do

- No client-side membership guessing, ever (I5 stands).
- No cross-door transforms (the LAW stands; the envelope depends on it).
- No second conflict system: rehydrate + 409 story untouched — forms
  keep their baseline three-way merge and FEED the store (entity-store
  wiring plan step 2), they do not read truth from it mid-edit.
- No server response caching (rejected: hard, and §4 removes its
  motivation).
- No sync-engine ambitions: pushed payloads to OTHER clients remain
  refused (door ceilings); signals stay signal-only. Delta sync, if it
  ever comes, is §4 + per-entity versions asked server-side — the floor
  is poured, the tower is optional.
- **No upstream state receipts.** The client never uploads field masks
  or "what this session holds" inventories — that path makes every read
  a negotiation, turns session contents into privacy surface, and
  requires versioning the mask across codegen runs (the sync-engine
  event horizon, entered gradually). The client declares only what the
  door already declares (which projection) plus one freshness integer
  (If-None-Match). A full receipt protocol lives in phase 7 beside the
  packed codecs, gated on a measurement proving the ~200-byte
  projection get is actually a cost.
