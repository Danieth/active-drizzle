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
  the same PER-FIELD compare: `incoming < lastSeen(f) → drop f` (§3a
  rule 1; there is no record-level drop). A token certifies ONLY the
  fields present in the payload: record-level "is it current?" is not a
  well-formed question when doors are projections; the question is
  always asked per door-slice. Consequence: stale values are impossible
  to APPLY; freshness misreports exist only in the SAFE direction (a
  bare signal may call a current field stale — costing a small fetch —
  but nothing can call a stale field current), so caching/persisting/
  patching aggressively is SAFE by construction, not by discipline.

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
  optimistic lock (CAS) — codegen REFUSES the array form on any door
  whose write path can't CAS it (silent LWW-lost-add is the failure
  mode). And the array form is only tolerable WITH signal intersection
  (§4b): without it, every note-add bumps the parent token and
  false-stales every OTHER parent field on every door — "the title card
  flickers when someone adds a comment." Intersection delivers the
  bump only to doors whose mask includes the array.
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
   `If-None-Match: <projFreshAt>` where `projFreshAt = min lastSeen(f)`
   over the fields THIS projection reads — the COVERAGE watermark,
   deliberately NOT `knownVersion`. (`knownVersion` is rumor — "I heard
   v11 exists" — and conditioning on rumor makes a 304 either fabricate
   freshness for cells that never arrived, the one forbidden
   corruption, or loop forever. Conditioning on coverage makes 304 mean
   what ETag means: "the cells you hold ARE the cells at V." A 304
   therefore advances `lastSeen` of the projection's fields to the
   validated token — sound, because the server certified those exact
   cells unchanged since then.) The server replies 304 or exactly the
   dirty slice. The server validates projId against the requesting
   door's ceiling — a client-supplied id can never widen access — and
   projId is a HASH of the compiled field mask, so a door whose ceiling
   changes gets a new id and can never 304 against a slice that is no
   longer the door. The receipt NEVER goes upstream beyond this: no
   field-mask uploads, no "what I hold" inventories (see §7).

Two definitional footnotes the clauses depend on:
- **Absence is projection, null is a value.** A field missing from a
  payload's columns means "not in this projection" — NEVER null. Null
  travels as an explicit cell. (Rule 1's `V ≥` equality is sound only
  because two same-token packets containing `f` must carry the same
  `f` — agreement — and that requires absence to be unambiguous.)
- **Path-2 reading, strictly:** "already current" does not mean "the
  signal changed nothing" — a bare signal ALWAYS raises knownVersion
  and stales every trailing field. Path 2 fires only when a payload at
  that token already merged (own echo, an envelope, a fetch that won
  the race); the signal is then redundant. Signals never certify;
  only payloads (and coverage-validated 304s) do.

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
- **Versioned tombstones for destroy.** Today's `remove()` just deletes
  the entry — a slow in-flight GET resolving after the destroy would
  re-insert the record (resurrection). A destroy at token V replaces
  the entry with a tombstone at V: merges below V drop against it (rule
  4 unchanged — a tombstone is a value), mounted surfaces render the
  gone-state, and tombstones age out with the LRU. Membership
  invalidation removes the pk from lists; the tombstone is what makes
  the IDENTITY layer's answer correct in the gap.
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
   `get(model, pk, projId)` with `If-None-Match: projFreshAt` (§3a.4 —
   the coverage watermark, not knownVersion) — never the family —
   merges its slice (or advances lastSeen on a coverage-validated 304),
   notifies. Small, targeted, ceiling-respecting. (If this path
   refetched the door family it would be the old storm with better
   marketing; it must not.)

Structure is the only thing that invalidates
(create/destroy/reparent/reorder — membership questions), and what
refetches is MEMBERSHIP-sized: hundreds of bytes, not payloads. Those
refetches are **coalesced** by oRPC's batch plugin into one HTTP request
(off-the-shelf; enabled in the generated link; RQ dedupes identical keys
as today) and **304-guarded**: the membership ETag is a pure STRUCTURE
token — pk-set + order + count + pagination-cursor identity — NEVER row
tokens, so value churn cannot bust it. Facets are NOT in this token:
aggregates legitimately move with values, so a facet signature would put
value churn right back on the 304 for every door that shows a count
("12 open" → "11 open" must not refetch the pk list). Facets travel as
a separately-validatable section of the response — structure can 304
while facets 200 alone. Unchanged membership costs one RTT and zero
bytes; the coherence engine's deliberate coarseness stops costing bytes
— over-invalidation becomes over-*confirmation*.

## 4b. The collaborative lane (what makes foreign writes feel like Meteor)

§4's three paths dissolve OWN-WRITE storms and FAMILY-PREFIX storms.
They do not dissolve the collaborative storm: after a bare signal,
path 2 is nearly empty — every mounted slice not already holding that
token is a path-3 GET. Two upgrades close this, both possible ONLY
because the server compiles every door mask ("the server cannot know
the projection" was Meteor's problem, not ours — refusing to use that
knowledge is a product choice, and we decline to make it):

- **Signal intersection (server-side, phase 5).** At commit, for each
  listener, compute `write-set ∩ π_d` against the COMPILED door masks
  of that listener's subscriptions and DROP the frame when empty. No
  mask ever travels (no metadata leak about hidden fields moving);
  uninvolved projections never hear the rumor, so knownVersion doesn't
  rise and path 2 becomes the COMMON case. This is the smallest change
  that makes §4's English true, and the change that makes parent
  pk-array token bumps tolerable (§1).
- **Door-keyed slice push (rides DESIGN-ws-channels).** §7's ceiling
  objection to pushed payloads — "whose projection would they be in?" —
  has an answer: THE CHANNEL'S. A subscription bound to
  `(model, pk, projId)` is authorized at subscribe time; under P1 same
  mask ⇒ same bytes, so fanout is per-PROJECTION (usually 1–2 distinct
  masks intersect a write), not per-user. At commit, push exactly the
  columnar slice `get()` would have returned; the client merge is rule
  4 unchanged; pull remains the fallback for missed frames/resume/
  fresh mounts. HARD REQUIREMENT for the channels design: subscriptions
  tear down on authorization change — a revoked user must stop
  receiving slices at revocation, not at reconnect. Membership stays
  re-ask + structure ETag: we push IDENTITY slices, never list shapes —
  no mergebox (the thing that actually ate Meteor).

Deliberately NOT adopted here: server-side per-field version columns
for slice-aware 304s. Once intersection filters signals, a DELIVERED
signal implies this door's slice actually changed — the follow-up GET
carries real cells, and the "row moved but slice didn't" 304 case that
per-field columns would serve is starved to ~nothing. Record-version
If-None-Match stays (its 304 certifies all cells, a fortiori the
slice — sound, conservative); per-field server tokens go to phase 7,
measured-need, beside the receipts.

## 4a. The trusted computing base (named, so it gets tested like one)

Three things are load-bearing assumptions, not derived facts, and the
guarantees are exactly as strong as their enforcement:

- **Write-set completeness (A3).** "The unified write path knows the
  true write-set" is the premise of convergence. A hook's side write
  omitted from `touched` AND missing its signal leaves a related row
  stale with `lastSeen == knownVersion` — invisible to every freshness
  check. This is the coherence doc's honest boundary; here it is
  promoted to TCB: afterCommit-fed signals discharge it at runtime, the
  static write-effect graph approximates it before then, and the
  validator nag (hook touches undeclared model) guards the gap.
- **The closed-set premise (P1/P6).** Rule-4 bookkeeping is over a
  compiled set of (model, field, door) triples. Any escape hatch that
  lets app code add a transformed field, a nested child with hidden
  version, or a client-side membership patch turns the lemmas back
  into hopes. The dev-mode throws are not ergonomics; they are the
  proof obligations.
- **Forms' record-level lock is COARSER than rule 4, on purpose.** Two
  users editing disjoint fields with no rehydrate in between still
  409 (stale token, though no field conflicts). Product choice, not a
  hole — and it has a principled softening: on 409, the client can run
  the SAME three-way merge against the returned fresh envelope and
  auto-resubmit iff no true field conflict exists (reusing rehydrate,
  not a second conflict system). Optional, later, measured.

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
5. **Signals with versions + server-side intersection** (§4b — the
   intersection is phase 5 proper, not future precision: it is what
   makes the collaborative storm dissolve and pk-arrays tolerable).
6. **Door-keyed slice push** (rides DESIGN-ws-channels; §4b) +
   **IndexedDB persistence.**
7. **(someday, measured-need only)** packed codec at the link; delta
   membership; shared compression dictionaries; server-side per-field
   version columns (slice-aware 304s); upstream receipts.

## 7. What this explicitly does not do

- No client-side membership guessing, ever (I5 stands).
- No cross-door transforms (the LAW stands; the envelope depends on it).
- No second conflict system: rehydrate + 409 story untouched — forms
  keep their baseline three-way merge and FEED the store (entity-store
  wiring plan step 2), they do not read truth from it mid-edit.
- No server response caching (rejected: hard, and §4 removes its
  motivation).
- No sync-engine ambitions — with the fence now drawn PRECISELY (§4b
  moved it, deliberately): pushed payloads on a NAKED socket remain
  refused (no projection to be in), but a slice pushed on a channel
  BOUND to `(model, pk, projId)` at authorized subscribe time is inside
  the fence — the channel IS the projection. What stays outside,
  permanently: live-query MEMBERSHIP push (the mergebox), client-side
  `where` evaluation, and shape inventories. We push identity slices;
  membership is always re-asked. Delta sync, if it ever comes, is §4 +
  per-entity versions asked server-side — the floor is poured, the
  tower is optional.
- **No upstream state receipts.** The client never uploads field masks
  or "what this session holds" inventories — that path makes every read
  a negotiation, turns session contents into privacy surface, and
  requires versioning the mask across codegen runs (the sync-engine
  event horizon, entered gradually). The client declares only what the
  door already declares (which projection) plus one freshness integer
  (If-None-Match). A full receipt protocol lives in phase 7 beside the
  packed codecs, gated on a measurement proving the ~200-byte
  projection get is actually a cost.
