# DESIGN — Transport Work (the execution plan for the transport layer)

### Status: PROPOSED · 2026-08-27 · the work companion to
### DESIGN-transport-proof.md. Everything a person needs to pick this up
### cold: verified seams (file:line), decisions with rationale, workstreams
### with acceptance criteria, obligations mapped, protocol + schema
### appendices, and the landmine list. Code refs verified 2026-08-26/27 —
### re-grep before trusting a line number.

## 0. Reading order & document map

1. **DESIGN-transport-proof.md** — the kernel, the working question, the
   formal model (axioms A0–A6, Rule M, T1–T9, obligations O1–O16). Read
   the kernel and §3 (Rule M) minimum. The proof is the spec: when this
   doc and the proof disagree, the proof wins; when the proof and the code
   disagree, that is a bug or an open obligation.
2. **DESIGN-wire-identity.md** — the envelope, partial-merge law, 304
   path, phasing 1–7. This doc's WS1–WS3 implement it.
3. **DESIGN-ws-channels.md** — the frame/channel design. Superseded in
   part; §2 of this doc lists exactly which decisions changed and why.
4. **DESIGN-entity-store.md** — store invariants I1–I5 (I2's drop-whole
   clause is superseded by per-field merge; amend when WS1 lands).
5. **"One Door, Two Theorems"** (artifact) — prose architecture of the two
   lanes. **"The Transport Theorems"** (artifact) — rendered proof.
6. **REMAINS-FOR-LAUNCH.md** — Tier 0 items WS0 depends on. Do not spawn a
   parallel tracker; check items off there and here.

## 1. Ground truth (verified against the repo, 2026-08-26/27)

What EXISTS and is load-bearing for this work:

| thing | where | note |
|---|---|---|
| transaction() + ALS + afterCommit queue | `packages/core/src/runtime/boot.ts:11,17,171-204` | afterCommit flushes at outermost tx only |
| @afterCommit decorator | `packages/core/src/runtime/decorators.ts:125-131` | supports `if`, `on` |
| previousChanges (per-commit changed fields) | `packages/core/src/runtime/application-record.ts:633,782` | feeds frames AND the O10 write-log |
| advisory-lock precedent (xact-scoped) | `application-record.ts:1657-1676` `_withAttachmentSlotLock` | copy the shape for the doc lane; xact scope is CORRECT for sync (not doc ownership) |
| getExecutor() raw-sql escape hatch | `boot.ts:96-108` | `db.execute(sql\`…\`)` inside tx |
| permit → abilities resolution | `packages/controller/src/crud-handlers.ts:239-303` (envelope), `:1118-1150` (buildPermittedData — the ENFORCEMENT) | any new write surface must call this |
| optimistic lock / version token | `crud-handlers.ts:114-132,826-847` | doubly opt-in today — O2 fixes |
| @mutation / @action registration + router | `packages/controller/src/decorators.ts:193-212,234`, `router.ts:326-357,445-506` | template for @sync; NOTE: they bypass buildPermittedData |
| contract probes | `packages/controller/src/contract-probes.ts:37` | new write surface ⇒ new probes, by construction |
| one-time token precedent | `packages/controller/src/attach-guard.ts:26-31` | template for the WS upgrade token |
| EntityStore (identity, version-gated merge) | `packages/react/src/entity-store.ts:55-62,81-106` | WS1 rebuilds merge() per Rule M |
| coherence (signal lane, family invalidation) | `packages/react/src/coherence.ts:42-51,83-116` | survives as degraded mode |
| FormSession: commitField, autoFlush, rehydrate, nested-manager precedent | `packages/react/src/form-session.ts:556-630,691-769,989-1082` (nested skip at `:1014`) | doc-field manager copies the nested shape |
| presenter registry + ladder | `packages/react/src/presenters.ts:211-292` | Tiptap/ProseMirror presenter = one registerPresenter |
| generated hooks / query keys | `packages/core/src/codegen/react-generator.ts:931-945,1414-1450` | keys: `client-model.ts:139-161` |
| Attr system (open kinds, .encrypt precedent) | `packages/core/src/runtime/attr.ts:359-1073` (`makeEncryptable:1059`) | crdtDoc = new entry in `_AttrImpl` + `_opaque` marker |
| encrypted-query guard (opaque-column template) | `packages/core/src/runtime/relation.ts:295-323` | copy verbatim for crdtDoc |
| bytea column type | `codegen/generator.ts:785` | no new ColumnType needed |
| ChannelsConfig (typed, scaffolded, UNREAD) | `packages/core/src/config.ts:31-44` | wire it in WS4 |
| Hono + @hono/node-server scaffold | `packages/trails/bin/trails.mjs:382-423` (port `:421`, context `:417`) | WS upgrade attaches HERE; x-user-id header auth is WS-incompatible (browsers can't set upgrade headers) |

What DOES NOT exist (zero code): any ws/socket dependency, LISTEN/NOTIFY,
`@broadcasts`, channel server, CVR-like state, doc_updates, any
loro/crdt/rich-text code, derived columns machinery, per-field
lastSeen/last_write, membership tags, epochs.

## 2. Decisions already made (do not relitigate without new evidence)

| decision | choice | rationale (where argued) |
|---|---|---|
| Row-lane frame content | door-projected partial records + silence rule (`changed ∩ expose`; empty → no frame). NOT zero-payload pokes | projection is the moat; pokes tax every subscriber a refetch; ws-channels §4 |
| Channel naming | door-keyed `${controllerPath}:${id}` / `:index` / `doc:${docId}`. NOT table-keyed | the door is the authorization unit |
| WS library v1 | `ws` on the SAME @hono/node-server http server, upgrade at `/cable`. NOT uWS (cannot share a node:http listener; GitHub-only install; connection count is not the early bottleneck). uWS/Bun = stage-2 swap behind the gateway interface | Evil Martians bench 2026-06-24: uWS 1,018,366 conns @5.45GB; ws fine at our scale |
| WS auth | short-lived one-time upgrade token minted over authed HTTP (attach-guard pattern) + Origin allowlist. NEVER cookies alone (CSWSH), never long-lived tokens in query strings | browsers cannot set headers on upgrade; scaffold's x-user-id cannot work |
| Bus | one interface `publish(channel, frame)`/`subscribe`; tiers: 0 memory → 1 Postgres NOTIFY (payload = ids only, batched; fallback, NOT default — global commit lock, 8000B, PgBouncer-session-only) → 2 Redis → 3 NATS JetStream. Best-effort, NO outbox (C1 makes loss harmless) | Recall.ai outage 2025-03; DBOS 60k/s batched on 16 vCPU (db.m7i.4xlarge) |
| Doc merge engine | Loro (loro-crdt 1.x, verified stable; export update-from-VV, shallow snapshots) as trusted kernel (O4a) | eg-walker rich text unpublished; loro-prosemirror v0.4.4 BETA — vendor + fuzz |
| Doc serving | stateless per-request ingest under pg_advisory_xact_lock; snapshot compaction on cadence (export is O(doc) — never per save); resident worker = later optimization, same interfaces | no worker tier exists; Hocuspocus does NOT do single-owner (only persistence lock); Y-Sweet does |
| Rows offline / green-yellow-red | classification lane is FUTURE work (separate design); transport ships with all mutations red (round-trip) semantics | invariant confluence; do not couple to transport |
| Client live derivation (useLiveView / d2ts IVM) | future lane AFTER frames exist; membership stays server-computed (I5); IVM = derivation over held, certified data only | wire-identity §7 |

## 3. Workstreams

Dependency graph: WS0 → WS1 → {WS2, WS3} → WS4 → WS5; WS6 parallel from
WS1. Each WS lists: obligations discharged, files, precedent, acceptance.

### WS0 — Foundations (BLOCKER; overlaps REMAINS-FOR-LAUNCH Tier 0)
Discharges: **O1 (OPEN), O2 ✅, O14 ✅** (O2/O14 landed 2026-08-27).
- **O1 — OPEN, the remaining WS0 blocker.** Transactional `save()`
  (`application-record.ts:640` area) — A2's precondition. Already Tier 0;
  the transport work may not start past WS1 until it lands. Deliberately
  untouched by the O2/O14 change.
- ✅ O2 — ONE token kind per model, enforced. The schema is user-authored,
  so enforcement is REFUSE-with-teaching-error, not auto-emit: the
  cross-IR `validateVersionedModels` pass
  (`packages/core/src/codegen/versioned-models.ts`, wired into the vite
  plugin's strict gate on BOTH the model-side and ctrl-side change lanes)
  refuses a lock-tokened model without
  `lockVersion: integer('lock_version').notNull().default(0)` (the DB
  default IS the insert initializer; core's existing CAS at
  `application-record.ts:673` is the bump). The `updatedAt`-cosplay path
  is DELETED: `optimisticLock: true` now means the model's integer
  locking column, `versionToken()` refuses Dates with the migration in
  the message, and timestamp lock columns are refused at build time.
  `relation.updateAll()` now bumps the token in the same statement
  (the one write path that bypassed the CAS), counter-cache parent
  writes bump it in the same SET, and `destroy()` WHERE-guards it
  (stale hard-deletes raise StaleObjectError — Rails lock_version
  parity). The wire can never carry the token: `buildGovernedWriteData`
  and `sanitizeNestedWrites` strip the resolved lock column from every
  payload (a client-supplied value disarmed the CAS and could regress
  the token). Runtime backstop for plugin-less apps: `lockField(config,
  model)` throws the same teaching errors per-request — including the
  missing-column O2a error when core's schema is booted (shared rule +
  builders in `packages/core/src/runtime/optimistic-lock.ts`;
  `resolveLockColumnName` is THE resolution rule, consumed by core's
  CAS, updateAll, the controller, and the codegen pass).
- ✅ O14 — pk-lineage rule: codegen REFUSES a lock-tokened model whose pk
  is reusable (natural key, plain integer, DEFAULTLESS uuid — i.e.
  client-supplied — or undetectable — composite third-arg pks are
  invisible to the extractor and refuse conservatively) unless
  `@include(SoftDeletable)` is declared; SoftDeletable's destroy is
  `update({<configured column>})` riding save()'s CAS, so
  destroy/un-delete keep one strictly increasing chain on the same pk
  (the concern's destroy override now honors a custom `columnName`, and
  the validator checks the soft-delete column exists and is a
  timestamp). uuid pks WITH a default (defaultRandom/$defaultFn) stay
  automatic.
- Acceptance MET for O2/O14: every write path bumps the token atomically
  with its data (statement-local; the multi-write snapshot claim awaits
  O1); the lineage property test
  (`packages/core/tests/integration/lineage-tokens.test.ts`, real PG)
  pins DB-default init, per-update CAS bumps, StaleObjectError on stale
  copies, never-reused serial pks across destroy→create, the soft-delete
  same-pk chain, the updateAll auto-bump, and the destroy()-vs-token
  semantics in both directions (stale destroy raises, fresh destroy
  lands). CONTRACT EXCLUSION: A1 across recreation on serial tables
  holds only while nobody inserts explicit pk values or resets
  sequences on a lock-tokened hard-delete table, and — on
  soft-delete-certified models — while `hardDestroy()` /
  `Relation.deleteAll()` are not used to physically remove rows whose
  pk is then re-created (codegen cannot see those calls; they end the
  lineage the SoftDeletable certificate promised to keep) — Postgres
  and the runtime allow all of these; out of contract.

### WS1 — Store hardening: Rule M in `packages/react` — ✅ LANDED 2026-08-27
Discharges: **O9, O12-store-half** (client side of O3′ prepared).
Landed in `packages/react/src/entity-store.ts` (+ barrel exports, test
suite renegotiated, DESIGN-entity-store I2 amended). Scope notes, stated
rather than claimed wholesale: (a) the O12 checkbox covers the STORE half
— floor authority map surviving eviction + exportFloors/importFloors +
revision-keyed floorRetention (reviewer pass 2026-08-27: finite
retention is now PINNED by tests — prune-at-distance, keep-alive via
merge/signal/certify all routing through floorOf, and eviction
re-seeding the authority map from an entry whose FloorRec was pruned;
importFloors joins max and reconciles existing entries, so the
restore-ordering rule is healed, not prose. Finite retention remains
an explicit T2-for-memory trade — 𝒞w delay is unbounded, default
Infinity is the safe setting); the IndexedDB restore wiring itself is
future work that now needs no store rewrite. (b) the fieldTicks
kind-equality acceptance is fully met only once WS2's codegen emits
`registerFieldKinds` per model — unregistered models keep scalar `!==`
(today's behavior, no regression). (c) `remove()` keeps its legacy
untokened-evict semantics; call sites migrate to `destroy(token)` in
WS2/WS3 when real destroy tokens exist at the call site.
- Rewrite `entity-store.ts` merge to Rule M: entry = (floor, cells with
  per-field lastSeen), interpretation layer (visible/current/projFreshAt),
  knownVersion as rumor bound, L3 GC. Encoding: (defaultToken +
  exceptions) per entry — budget ≤2MB at 50k records.
- Floor map survives entry eviction AND IndexedDB restore; retention
  dominates max in-flight + retries + restore-holding-a-GET (O12).
- Flat-row contract enforcement, notify coalescing per microtask,
  fieldTicks equality per Attr kind (wire-identity §3 ledger).
- Amend DESIGN-entity-store I2 (drop-whole → per-field), per §3a note.
- Acceptance: the seeded property suite gains generators for the L2
  counterexamples — {a@10}·D15·{b@20} in all 6 orders converges to
  (floor 15, render {b@20}); D15·B20·A10 never renders a; 304-shaped
  merges never touch cells outside P.

### WS2 — Wire envelope + flat loading (wire-identity phases 2–3)
- Normalized columnar envelope behind per-door codegen flag; generated
  handlers wire store.mergeRows + membership→RQ; per-table batched
  include-loading with the parity checklist (`wire-identity §2`).
- Acceptance: parity tests per door (same rows/order/ceilings/codecs);
  measured payload ≤ ~40% of nested baseline (bench: 19.6K vs 55.2K).

### WS3 — Validation path (the 304 machinery)
Discharges: **O10, O5, O15** (server side).
- Server write-log: per commit, persist (token, changedFieldsBitmap,
  lifecycleFlag) per record — source is `previousChanges` (P4). Bounded
  retention; expiry ⇒ conservative slice response. Schema in Appendix B.
- Three-way validation endpoint `get(model, pk, projId,
  If-None-Match: projFreshAt)` → 304(V) | gone(D) | dirty slice, with
  A2′'s three clauses exactly. projId = hash of compiled field mask
  (ceiling change ⇒ new id).
- Membership tags: door-scoped commit-ordered counter (the theorem-grade
  option — DECIDE here, record in wire-identity §4) + splice endpoint;
  property-test apply(list@from, ops) = list@to per door (O15).
- Storm controls: echo merging, membership-only refetch, oRPC batch link,
  structure-token ETags (wire-identity §4).
- Acceptance: model-checkable invariants asserted as integration tests —
  "304 never freshens a cell the client does not hold"; "304 never
  certifies across a lifecycle event" (create→destroy→validate with
  stale W must NOT 304).

### WS4 — Channels: gateway, frames, bus
Discharges: **O16**; consumes ChannelsConfig.
- `ws` upgrade on the scaffold's http server at `config.channels.path`;
  upgrade-token mint endpoint (attach-guard pattern) + Origin allowlist;
  25s app-level heartbeat; reauth frame; SharedWorker tab sharing with
  BroadcastChannel+WebLocks fallback (SharedWorker now OK on Chrome 148+
  Android).
- Frame envelope per Appendix A — binary, epoch-carrying (O16). Subscribe
  = dry-run the door's show/index (router already pre-loads + re-verifies:
  `router.ts:466-479`); revocation ⇒ epoch bump + RESET.
- Emission: afterCommit hook computes `changed ∩ expose` per subscribed
  door (bitmap AND over compiled masks), silence rule, coalesce per
  channel 20–50ms. Best-effort; no outbox.
- Bus interface + tier 0 (in-memory) + tier 1 (NOTIFY, ids-only payload,
  optional batching; document the `class 1262 … database 0` lock-wait
  exit signal); tiers 2/3 as adapter stubs.
- Backpressure: drop PRESENCE → coalesce CHANGE harder → NEVER drop DOC
  (send RESET-to-cursor instead).
- Client: frame dispatch → store.merge (CHANGE), M3 (signal), epoch
  filter, reconnect = resubscribe with cursors + revalidate projections.
- Acceptance: two browsers, one edit → other renders inside 500ms with
  ZERO refetch (frame-only); kill the socket mid-stream, mutate 10×,
  reconnect → converges via pulls; revoked door: after RESET processes,
  a replayed old frame (test harness injects) is dropped by epoch.

### WS5 — Doc lane
Discharges: **O3, O3′** (+ consumes O4 decision).
- Schema: `doc_updates` per Appendix B; seq = max+1 per doc UNDER the
  advisory lock held through commit. NEVER bigserial (A4).
- `@sync` decorator + router branch (clone mutation registration,
  `decorators.ts:193-212`); handler: assert ability='edit' via the
  buildPermittedData path (`crud-handlers.ts:1118`) — @action/@mutation
  do NOT do this for you — then lock, append, import, refresh derived
  columns (text extract), afterCommit publish. Contract probes for the
  new surface.
- `Attr.crdtDoc()` in `attr.ts` `_AttrImpl` + `_opaque` marker honored by
  a relation guard copied from `relation.ts:295-323`; excluded from the
  LWW diff lane entirely (never in changedData/PATCH); codegen emits
  derived-column definitions + the presenter kind.
- Snapshot compaction task (cadence: every N updates or M seconds;
  shallow snapshot; archive tail).
- Client: doc-field manager on the nested-manager precedent
  (`form-session.ts:1014,1044-1056`): dirty = unacked updates
  (export-from-lastAcked non-empty), late-bound payload on 50–100ms
  debounce, rehydrate = import; PREFIX cursor (O3′) with out-of-order
  holding set. Presenter: registerPresenter over VENDORED
  loro-prosemirror (O4b fuzz workstream: split/merge, marks, undo, IME;
  known upstream bug: init-race content wipe — guard init before first
  docChanged).
- Acceptance: two tabs converge through Postgres with the bus DISABLED
  (pull-only — proves C1 for the doc lane); frame delivery 1,2,5 then
  catch-up yields identical doc to in-order delivery; 10k-update doc
  cold-loads under 200ms from snapshot+tail.

### WS6 — Mechanization + docs (parallel from WS1)
Discharges: **O8, O11, O7 (optional).**
- TLA+/PlusCal: Rule M with floor, both lanes, prefix cursor, A2′
  three-way response, epochs. Check the six invariants listed in
  proof §7/O8. Budget: ~1 week. Keep spec in `specs/transport.tla`.
- O11 sweep: re-state "session guarantees" language in wire-identity /
  entity-store as T6's scoped claims.
- O7 only if external validation demands the leak boundary formalized.

## 4. Appendix A — frame envelope (v1)

Binary; control bodies msgpack; CRDT payloads raw. All frames carry
`epoch` (per-channel subscription epoch, uint32 — O16).

```
byte 0: type   1=SUB 2=UNSUB 3=SUB_ACK 4=CHANGE 5=DOC 6=PRESENCE
               7=PING 8=PONG 9=RESET 10=REAUTH 11=SIGNAL
SUB:      channelId varint | epoch | cursor (token for row chans, seq for doc chans)
CHANGE:   channelId | epoch | pk | token | op | columnar slice (k-header form)
DOC:      channelId | epoch | docId | seq uint64 | loro bytes to EOF
SIGNAL:   channelId | epoch | pk | token | op            (degraded mode: M3 only)
RESET:    channelId | newEpoch                            (drop local, re-pull, re-sub)
PRESENCE: channelId | epoch | senderId | ttlMs | msgpack  (not v1; spec reserved)
```

Rules: CHANGE/SIGNAL/DOC with epoch < current(channel) are DROPPED on
arrival. A CHANGE frame's slice is byte-compatible with the validation
endpoint's dirty-slice response (same codegen serializer — A0/A3).
Heartbeat 25s; server closes 1001 on drain; client reconnect =
backoff+jitter, resubscribe with cursors, revalidate mounted projections.

## 5. Appendix B — schema sketches (names bikesheddable, semantics not)

```sql
-- doc lane (WS5). seq assigned as max+1 under
-- pg_advisory_xact_lock(hashtext('doc:'||field), record_id), lock held to commit.
create table doc_updates (
  doc_id     bigint not null,          -- (model, pk, field) resolved id
  seq        bigint not null,
  bytes      bytea  not null,
  created_at timestamptz not null default now(),
  primary key (doc_id, seq)
);
-- snapshot column + derived columns live on the owning row:
--   body bytea, body_text text (FTS/LIKE), body_json jsonb (optional)

-- validation write-log (WS3, O10). Source: previousChanges at commit.
create table record_write_log (
  model      smallint not null,        -- codegen-numbered
  pk         bigint   not null,
  token      bigint   not null,        -- the lock int
  changed    bytea    not null,        -- field bitmap, codegen field order
  lifecycle  smallint not null default 0,  -- 0 none, 1 create, 2 destroy
  primary key (model, pk, token)
);
-- bounded retention (e.g. 24h); expiry ⇒ validation answers with the slice.

-- membership tags (WS3, O5): counter option
-- per (door, paramsHash): last_tag bigint bumped in-commit when membership
-- changes; splice rows keyed (door, paramsHash, from_tag).
```

## 6. Landmine list (each has bitten someone; the proof found several)

1. `bigserial` for doc seq — gaps + out-of-order visibility ⇒ permanent
   cursor skip (violates A4). max+1 under the lock. (O3)
2. High-water-mark cursor client-side — same skip, no DB needed. Prefix
   cursor only. (O3′)
3. `If-None-Match: knownVersion` — freshens cells that never arrived: the
   one forbidden corruption. Coverage watermark only, A2′ all three
   clauses (lifecycle!). (O10)
4. Tombstone-as-replaceable-state — non-commutative + resurrection (the
   rev-2 L2 counterexample). Monotone floor only. (O9)
5. `@action`/`@mutation` skip buildPermittedData — a sync route that
   doesn't call the permit resolution is a door bypass. (WS5)
6. WS auth via headers/cookies — browsers can't set upgrade headers;
   cookies alone = CSWSH. Token + Origin allowlist. (WS4)
7. Loro snapshot export per save — O(doc) per keystroke batch. Compaction
   cadence. (WS5)
8. loro-prosemirror #77 init race (content wipe) — guard init ordering;
   it's why the binding is vendored + fuzzed. (WS5)
9. NOTIFY as default bus — global commit-order lock (`class 1262 …
   database 0` waits = the exit signal); ids-only payload; batched;
   session-mode connection (PgBouncer tx pooling breaks LISTEN). (WS4)
10. Membership short hash — neither theorem nor negligible-collision.
    Counter or crypto hash, declared. (O5)
11. Epoch-less RESET — old frames legally arrive after RESET on 𝒞w;
    delivery order is not a security boundary, the epoch filter is. (O16)
12. `updatedAt` as version token — display field cosplaying as a Lamport
    clock; ties within 1ms; not framework-maintained today. Lock int. (O2)

## 7. External facts relied on (verified, with dates — recheck if >6mo old)

- loro-crdt 1.14.x stable; `export({mode:'update', from})`, shallow
  snapshots, pending-buffer import (idempotent, order-tolerant) — loro.dev
  docs, verified 2026-08-26.
- loro-prosemirror 0.4.4 — beta; open #77 content-wipe race; no official
  Tiptap binding (custom extension or ProseMirror/ProseKit direct).
- NOTIFY global AccessExclusiveLock (async.c PreCommit_Notify); Recall.ai
  outage 2025-03-19..22; DBOS batched ~60k/s on db.m7i.4xlarge
  (16 vCPU/64GB — NOT the 96-core box).
- Evil Martians ws bench 2026-06-24 (uWS 1.02M @5.45GB; Socket.IO ~120k
  @~52KB/conn); uWS send() codes are 1=ok/0=queued/2=dropped.
- SharedWorker shipped Chrome 148 Android (2026-04); WebTransport = W3C CR
  2026-07-30 (still not a dependency).
- Proxy idle timeouts: Cloudflare 100s fixed (non-Enterprise), ALB 60s
  default, nginx 60s default ⇒ 25s heartbeat.
- Zero's CVR = the shipped revocation-exact design (predicate-in-view +
  per-client manifest); Hocuspocus has NO doc ownership (persistence lock
  only); Figma/Linear = server-ordered per-property LWW, machinery in the
  log/bootstrap, not the merge.

## 8. Definition of done (the whole program)

- All O1–O16 checked off in DESIGN-transport-proof.md §7 (or explicitly
  re-scoped there, never silently).
- The six O8 invariants pass under TLC AND exist as property tests.
- WS4/WS5 acceptance demos pass with the bus disabled (C1 witnessed).
- REMAINS-FOR-LAUNCH updated; DESIGN-ws-channels + DESIGN-wire-identity
  amended where superseded (frame content, signal-only doctrine, I2,
  Terry language) — the docs must not disagree with the proof.

## 9. Glossary (terms of art in these docs)

**door** — controller-as-projection: scope ∘ expose ∘ permit; the only
serializer (A3). **cell** — (model, pk, field) with (value, lastSeen).
**floor** — monotone deletion token; "deleted" is interpretation.
**token** — per-lineage strictly-increasing commit stamp (the lock int).
**knownVersion** — max token *heard*; rumor, never certification.
**projFreshAt** — min lastSeen over a projection; the coverage watermark
sent as If-None-Match. **silence rule** — empty (changed ∩ expose) ⇒ no
frame. **prefix cursor** — max n with {1..n} received (doc lane).
**epoch** — per-channel subscription generation; frames from old epochs
are dropped (the revocation boundary). **green/yellow/red** — mutation
classification by invariant confluence (future work, separate design).
**𝒞w / 𝒞r** — weak (push) and RPC (request/response) channel models.
