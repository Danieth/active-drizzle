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
| Rows offline / green-yellow-red | classification lane is FUTURE work (separate design); transport ships with all mutations red (round-trip) semantics | invariant confluence; do not couple to transport; the separate design now EXISTS: DESIGN-mutation-classification.md (green certificate, yellow-by-construction dynamic permits, O13 as the bar) |
| Client live derivation (useLiveView / d2ts IVM) | future lane AFTER frames exist; membership stays server-computed (I5); IVM = derivation over held, certified data only | wire-identity §7; the lane's design now EXISTS: DESIGN-live-view.md (d2ts over the WS1 change feed; I5 held — derived collections are presentation, membership is authority) |

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
  payload measured and recorded per door. (The original "≤ ~40% of nested"
  target came from a deeper synthetic graph and did NOT reproduce — see the
  measured finding below: raw ~50%, post-brotli ~parity. The bench pins
  raw ≤ 0.55 and brotli ≤ nested; the wins are decode cost + identity/token
  semantics, not compressed bytes.)
- ⏳ **SERVER + CODEGEN half LANDED 2026-08-27**; **CLIENT RUNTIME half
  LANDED 2026-08-27** — `packages/react/src/wire-envelope.ts` is the ONE
  decoder for the ONE serializer: `mergeEnvelope` (k/v/r zip → per-row
  Rule-M1 merges with `{version: v[i]}`, v null = untracked lane;
  `touched` destroy → store.destroy(floor) / legacy remove when
  token-less), `mergeRecordEnvelope` (merge + PURE recompose of the
  nested RecordEnvelope — hasMany via idsColumn in order with the
  idsColumn key removed, belongsTo via FK, hasOne via child-side FK scan,
  `_key` stitched from meta.nestedKeys — P6: FormSession untouched),
  `mergeIndexEnvelope` (IndexResult shape in membership order), and
  `useProjectedRows` (useSyncExternalStore-live door-masked rows from the
  store, re-nested per spec, self-rewiring child subscriptions which
  double as eviction pins; hasOne omitted from STORE projection — no FK
  index — reaches app code via the recomposed get/echo shapes). Contract
  suite: `packages/react/tests/wire-envelope.test.tsx` (17 green; full
  react suite 332+ green, tsc clean). Landed: `wire: 'columnar' | 'nested'`
  top-level CrudConfig flag; ONE serializer
  (`packages/controller/src/columnar-envelope.ts` — buildColumnarEnvelope)
  branched at every usesEnvelope seam incl. 409s, `this.envelope()`, and a
  destroy `{success, touched:[{resource,id,op,version}]}` echo; flat
  include-loading (`packages/core/src/runtime/flat-loader.ts`, 1 root query
  + one per included table, association order honored, loader-agnostic
  serializer); the columnar-doors codegen gate
  (`packages/core/src/codegen/wire-columnar.ts`: expose required,
  hasMany-include ⇒ optimisticLock, STI-divergence + habtm/through/
  polymorphic refusals) in both vite lanes; `_entities.gen.ts`
  registerFieldKinds; flagged hook/wire-spec emission in react-generator.
  Parity suite: `packages/controller/tests/columnar-parity.test.ts` (real
  PG, flag-on vs flag-off, §2 checklist as tests — 24 green, incl.
  Attr-kind codec parity: money/dates/jsonb cells JSON-round-trip
  identical across lanes, explicit-null vs absence pinned per kind).
  **Acceptance evidence complete 2026-08-27:** the Rule M handshake —
  `packages/react/tests/columnar-handshake.test.ts` (real PG → real
  handlers → the GENERATED `_MergeEcho` funnel verbatim → EntityStore):
  every wire field lands at per-field lastSeen == the row's ACTUAL
  lock int (distinct per-row child tokens prove no record-level
  stamping), update echoes re-thread the bumped token and a replayed
  stale GET regresses nothing, projFreshAt over the door's fields
  equals the DB lock (304-able) and certify() at a newer token
  re-freshens every field (M4), and a destroy echo's floor survives a
  stale-GET replay (T2). Full suites green: controller 384, react 336,
  core 1305.
  **Measured finding (recorded):** on the 2-level 20×40×8 fixture the raw
  payload is 50.3% of nested, but POST-BROTLI the lanes converge (~98%) —
  brotli erases repeated keys and duplicated embedded objects; the ~40%
  compressed target did not reproduce on a 2-level door (the risks section
  predicted this: record per-door numbers at flip time; the raw ratio and
  decode-cost win are the structural invariants). Two pre-existing
  nested-lane gaps pinned by the suite: (a) toJSON only-mode serves
  included child rows RAW — child Attr codecs bypassed AND the child's
  lockVersion ships in the payload (columnar hydrates children through the
  model class per A0 and keeps tokens out of k); (b) drizzle RQB include
  loading ignores the association's declared `order` (pk order); the flat
  loader honors it.
  **Review hardening (2026-08-27 overnight, pre-commit):** applied the
  external review's findings to the WS2 diff —
  (1) *Ceiling totality:* on an explicit `access:` door the serializer now
  REFUSES any include absent from the access tree (it previously defaulted
  the child to a STAR node — every column of the child table shipped past a
  ceiling the nested lane enforced). Gate clauses W7/W8 catch the same
  (plus access/expose divergence) at build time.
  (2) *Absence ≠ []:* an unloaded hasMany now OMITS the pk-array column
  instead of emitting `[]` at the owner's current token (which certified an
  empty membership and wiped the client store's true pk-array on every
  custom-@mutation echo). `ActiveController#envelope()` is now async and
  flat-attaches the door's GET includes first, so custom echoes carry the
  TRUE membership. The belongsTo FK cell likewise never coerces
  undefined→null.
  (3) *Destroy-commit token:* `defaultDestroy` echoes D = lock + 1 (A1/A2 —
  the read token left a same-token race window where a concurrent update's
  cells outlived the floor).
  (4) *Child masks client-side:* wire specs now carry per-child `fields`
  (from the access node) and `useProjectedRows` masks re-nested children
  with them (§3a corollary — union storage, per-door projection, children
  included). Expose-only doors keep whole-row children — now PINNED as an
  exact k-list in the parity suite so accidental widening fails loudly.
  (5) *Flat-loader semantics decided + pinned:* child loading is
  `.unscoped()` — the nested RQB lane never ran child default scopes, and a
  row-set/membership change must not ride a transport flag (a
  default-scoped-child parity test enforces it). Polymorphic-inverse type
  scoping now matches the loaded roots' actual class names (STI subclass
  rows keep their children) and is PG-tested, as are hasOne first-per-parent
  and the pk-order tiebreaker.
  (6) *Gate tightened:* W5 requires `get.abilities` (a bare-record door
  flipping to the envelope shape was a silent P6 break — runtime backstop
  too); W6 refuses hasOne in the INDEX include tree (list rows cannot
  re-nest it); W2/W4 now recurse the include tree, and a depth≥2 hasMany
  requires the OWNING model's own lock column (untracked pk-array = the
  silent-LWW W2 exists to refuse).
  (7) *Flag-off extractor fixes:* `resolveIncludeArray` resolves
  SpreadElements (`include: [...SHARED]` silently lost its entries — a
  flag-off codegen regression). SIGN-OFF NOTE: the new include extractor
  also SURFACES object-form entries (`{ notes: [...] }`) that the old
  string-only parser dropped — generated projections/imports for unflagged
  doors using that form now include those associations. This is a bugfix
  (the runtime always served them) but it does change flag-off generated
  output for exactly those doors.
  (8) *Coverage the review demanded:* columnar pagination across pages
  (hasMore true→false), non-pk asc/desc sort parity, defaultCreate echo
  (issues + _key adoption), `envelope()` echo path, emptyReason/chart/
  metric passengers, `_entities.gen` emitted for zero-kind columnar
  projects, generated-string assertions for the touched-lane decoder /
  infiniteIndex / 409 mapper / index queryFn, and a handshake assertion
  pinning the emitted wire spec against runtime `resolveWireAssociation`
  (the "cannot drift" comment is now a test). React's PG test deps are now
  declared in its own package.json (no more hoisting luck).
  Deferred (recorded, not fixed): compiling/executing a generated hook file
  end-to-end (string assertions cover the named mutant class); child-codec
  parity beyond enums (money/date/jsonb child cells) and encrypted Attrs on
  the columnar wire; a k-divergence (two-slices-one-table) runtime trigger
  test; STI-door runtime serialization tests.

### WS3 — Validation path (the 304 machinery)
Discharges: **O10 ✅, O5 ✅, O15 ⏳-pinned** (server side LANDED
2026-08-27; client dispatch LANDED same day — see the storm-controls
bullet below; O15's real splice ops remain the pinned residual).
REVIEW-HARDENED same day (external review, all blockers closed): lazy
fieldsRev wiring, hook aliasing for the generated siblings, scoped-door
gone(D) refusal (§6 non-theorem), physical-lock registry verification,
unlogged-root slice + W9 + symmetric client skip, insertAll/deleteAll
contract closure, read-side degrade on unmigrated DBs, splice-route
ordering + reserved names + tagless refusal, retention narrowed to the
tombstone, bulk log batching + honest hot-row cost — details inline
below and in proof §7 O5/O10/O15.
- ✅ Server write-log (`core/src/runtime/write-log.ts` + hooks in
  application-record.ts / relation.updateAll / counter-cache): per commit,
  (token, changed bitmap over ONE declaration-order model numbering,
  lifecycle 0/1/2/3 — undelete=3 so soft re-creation trips clause ii),
  written **INSIDE the data transaction**, never afterCommit. THE
  WRITE-POINT ARGUMENT, recorded: (a) tokens are DENSE per lineage
  (create=0 by DB default, every bump +1 — lineage-tokens pins it), so
  validation gap-checks (W,V] — count == V−W — and a lossy log degrades to
  the conservative slice, never a wrong 304; but (b) gone(D) makes
  afterCommit untenable regardless: after a hard destroy the lifecycle=2
  row is the ONLY durable carrier of D, and a fabricated D violates T4.
  In-tx logging makes log-row-exists ⟺ commit-happened a Postgres
  atomicity fact. Cost accepted: logged models force the save()/destroy()
  wrap (`_saveNeedsTransaction`/`_destroyNeedsTransaction` return true —
  a partial dividend on O1, which stays open; the data-modifying-CTE
  single-statement form is the later optimization). WHICH models: derived,
  zero new config — lock-tokened ∩ reachable from a wire:'columnar' door
  (codegen: `computeWriteLogRegistry` in wire-columnar.ts; runtime
  backstop: `registerColumnarDoorTransport` at buildRouter). Schema: the
  Appendix B sketch REVISED in code — text pk + tableName model key (uuid
  pks are a framework default, O14; smallint model numbering was not
  deploy-stable), `committed_at` added; retention prunes everything but
  lifecycle=2 (default 72h, bounded per call) — ONLY the destroy
  tombstone is load-bearing forever (O12 symmetry; creates are outside
  every interval since W ≥ 0, a pruned undelete degrades to the slice,
  and immortal create rows were unbounded growth + a pk-reuse collision
  trap). fieldsRev reconciliation is WIRED LAZILY: memoized per table
  per process, awaited before the FIRST bitmap read
  (readWriteLogInterval) — zero-config, no boot hook to forget; a
  drifted model's lifecycle=0 rows are deleted so bitmaps are never
  misread, only degraded to slices (`reconcileWriteLogFieldsRev()`
  remains as an optional boot accelerator). The logged registry verifies
  the PHYSICAL lock column (lazily post-boot): a declared-but-absent
  lock column no longer over-registers an untracked model into permanent
  wrap overhead. The vite strict gate now runs `validateWriteLogSchema`
  (both lanes) so a columnar project missing the transport tables
  refuses AT BUILD with the paste-ready DDL; at runtime the READ side
  (index tag) degrades by omission on an unmigrated DB while writes
  refuse (atomicity is the point). CONTRACT EXCLUSION (extends WS0's):
  out-of-contract writes (raw SQL, sequence resets) leave gaps — safe
  for updates (slice), but an out-of-contract HARD delete never writes
  its tombstone: gone(D) is then unanswerable forever. Because that loss
  is permanent and invisible, `Relation.deleteAll` REFUSES on a logged
  model (teaching error naming `destroyAll`); `insertAll` is in-contract
  (bulk lifecycle=1 rows + ONE tag bump, atomic with the INSERT).
- ✅ Three-way validation endpoint: a generated SIBLING PROCEDURE of show
  (`validate` on every columnar door's router namespace, scope+scopeBy
  through show's exact dispatch — and `only:`-scoped @before/@after
  hooks run under the CRUD ALIASES too: validate ≈ get, splice ≈ index,
  a conservative union, so an app auth gate naming only the CRUD actions
  is never bypassed by a generated sibling; 'validate'/'splice' are
  RESERVED procedure names on columnar doors, refused at route build for
  custom @mutation/@action collisions; the REST `GET /splice` route is
  registered BEFORE `GET /:id` so order-sensitive adapters reach it;
  contract probe added by construction). Input `{id, projId,
  ifNoneMatch: W}`; output the application-level tagged union
  `{status:'fresh',v} | {status:'gone',d} | {status:'stale',envelope}`
  (not HTTP-304 — oRPC batching + typed unions are the house style; A0
  needs only that the stale envelope be buildColumnarEnvelope's bytes,
  and it is — the ONE serializer through show's ONE assembly tail,
  `finishColumnarRecordEnvelope`, shared with defaultGet). A2′'s clauses
  literally; clause (iii) read from the row itself and never skipped at
  V==W; projId validated against THIS door's ceiling (mismatch ⇒ slice
  at the door's actual mask; grade is PROBABILISTIC — 48-bit hash,
  declared in wire-identity §3a.4); an UNLOGGED root (no physical lock
  column) answers the slice, never a registry 500 — codegen warns (W9)
  and the react generator skips the client transport symmetrically; the
  one known codegen/runtime mask divergence (Attr property→column
  rename) warns at router build naming the field (ONE-computation
  registry emitter is the named follow-up). Scope-miss = show's 404
  (soft-deleted rows are re-scope-checked via `unscoped('SoftDeletable')`
  before gone — no cross-tenant leak; hard-deleted gone(D) is answered
  ONLY through UNSCOPED doors — the tombstone stores no scope columns,
  and a scoped door answering it would be the cross-tenant destroy
  oracle now recorded as its own §6 non-theorem in the proof doc, NOT a
  T9 citation; scoped doors 404 and the client evicts via the legacy
  lane). PROJECTION SCOPE V1: projId masks cover scalar +
  belongsTo-FK columns ONLY — hasMany pk-array columns are EXCLUDED,
  stated: child commits do not bump the owner's token or appear in its
  previousChanges, so clause (i) over a pk-array is unanswerable from the
  owner's log; list/child freshness rides the membership lane + per-child
  validation. Doors dominated by includes therefore 304 rarely until that
  lane matures — expected, not a bug report. The dirty slice is the
  door's FULL record envelope at V (sound under Rule M; changed-fields
  trimming is phase-7).
- ✅ Membership tags: DECIDED — the door-scoped commit-ordered counter
  (theorem grade; recorded in wire-identity §4). One row per door,
  upsert-bumped by the write-log ON THE SAME EXECUTOR as lifecycle
  writes — ALL doors of a table in ONE statement, and bulk paths
  (updateAll/insertAll) log via one multi-row INSERT + at most one bump
  per door per call. COST, stated honestly: the counter row is a
  per-door serialization point — its lock is held until the surrounding
  write transaction commits, so concurrent creates/destroys on a doored
  table serialize on it (mitigation path recorded in write-log.ts's
  header: tail-of-transaction bump / per-(tx,door) dedupe; it cannot
  leave the transaction — rollback atomicity is the theorem).
  Conservative v1 detection (create/destroy/undelete; value writes
  don't bump — v1's splice is always replace-all so tag-equality is not
  yet consumed as a skip; compiled scope-intersection is the named
  precision trim that must precede real ops). Splice endpoint ships
  keyed (door, paramsHash, fromTag), v1 always
  `ops=[replace-all(list@to)]`; O15's apply(list@from,ops)=list@to
  property test pins the contract, paramsHash is pinned for
  distinctness + key-order invariance, and splice REFUSES when the door
  cannot produce a tag (untracked root / unmigrated tables) — no
  read-after-list fallback, no frozen-0 counter on the wire. SEPARATELY
  the index-refetch guard is the pure STRUCTURE token (truncated
  SHA-256 of pk-set+order+count+cursor; facets excluded; declared
  probabilistic — landmine 10) riding `membership.structureToken`, with
  `membership.tag` (the counter, read BEFORE the list queries so a race
  yields an old tag, never a mislabeled list — stated invariant; a
  deterministic pinning test for the ordering is NAMED TEST DEBT: it
  needs a write injected between the tag read and the list queries)
  beside it on columnar index responses.
- ✅ Storm controls, both halves: echo merging + the structure-token guard
  live server-side; the CLIENT dispatch LANDED 2026-08-27 as ONE module —
  `react/src/validation-client.ts` `revalidateProjection` (signal ⇒
  echo-merge skip [W ≥ knownVersion, §4 path 2] ⇒ unheld-fields fetch via
  the door's GET, never validate [projFreshAt null ⇒ no lawful W, T3/O8] ⇒
  W=projFreshAt at ISSUE time ⇒ fresh⇒certify(fields, V, the SAME W) /
  gone⇒destroy(D) / stale⇒mergeEnvelope / NOT_FOUND⇒legacy remove()).
  Generated doors embed the codegen twin literals (`_xValidatableFields` +
  `_xProjId` via the shared projIdFor — no runtime hashing, no drift) and
  expose `.with(scopes).revalidate(id, {signal?, force?})`; the membership
  structure-token guard rides the generated index queries as
  `structuralSharing: shareMembershipData` (token-equal confirming refetch
  keeps pks/pagination identity — and the whole data object when passengers
  are unchanged; facets stay fresh, never frozen by the token). The oRPC
  batch link is documented in the user-owned `_client.ts` stub (enabling it
  is an app choice — the stub is written once, never overwritten).
- ✅ Acceptance MET (server): the two forbidden-corruption invariants as
  real-PG integration tests through buildRouter's real procedures +
  EntityStore — `react/tests/transport-forbidden-corruption.test.ts`
  ("304 never freshens a cell the client does not hold" incl. the
  GC/stale-re-merge certify-guard replay; "304 never certifies across a
  lifecycle event" incl. gone(D) from the tombstone, soft
  destroy→undelete ⇒ slice-never-fresh, the UNDELETE-ONLY interval
  (W = the destroy token, restore after — lifecycle=3 alone must trip
  clause ii), destroyed-at-exactly-W hitting clause iii on BOTH lanes —
  the 404 re-check AND the record path of a door that serves
  soft-deleted rows — and the W>V clamp), the hook-alias and
  scoped-door (scopeBy) A3 pins, the depth-2 include-tree registry
  walk, plus substrate pins in
  `core/tests/integration/write-log.test.ts` (density, per-path bitmaps
  under a NON-PREFIX mask numbering, tombstone permanence,
  prune⇒detectable-gap, fieldsRev truncation, in-tx atomicity for
  save AND destroy AND updateAll via error injection, bulk
  soft-delete/restore lifecycle classification, insertAll logging +
  single bump, deleteAll refusal, the conservative full-bitmap fill)
  and the codegen registry in
  `core/tests/codegen/write-log-registry.test.ts` (incl. the
  validateWriteLogSchema green path, the W9 lock-token warning, and the
  Attr-rename mask exclusion). NAMED TEST DEBT (deliberate, cheap-first
  filter): the tag-read-before-list ordering pin (needs deterministic
  write injection inside the window) and a single cross-world
  codegen↔runtime mask/projId equality assertion on one shared door
  (the two computations share one rule + one hash and each side is
  pinned separately; the ONE-computation registry emitter supersedes
  the test when it lands).

### WS4 — Channels: gateway, frames, bus
Discharges: **O16**; consumes ChannelsConfig.
✅ **DONE 2026-08-27** (server half + client transport + the six-scenario
node-level acceptance suite — O16 ticked): ChannelsConfig fleshed out +
teaching gates (`core/src/config.ts` — resolveChannelsConfig /
assertChannelsServable: prod-without-allowlist, publish-only+memory,
heartbeat>55s warn, coalesce clamp 20–50ms); the isomorphic frame codec
(`core/src/transport/frame-codec.ts`, `@active-drizzle/core/frames`
subpath, @msgpack/msgpack only — Appendix A below is amended to the landed
fixed 9-byte header); the commit-event tap
(`core/src/runtime/transport-events.ts`, emitted from the SAME write-log
call sites in application-record.ts / relation.updateAll / insertAll /
counter-cache, deferred through the EXISTING afterCommitQueue — never
in-tx, rollback discards; save/destroy carry the live record → CHANGE,
bulk paths ids-only → SIGNAL, C1 makes the downgrade harmless); the door
registry (registerColumnarDoorTransport now RETAINS
{model, config, doorId, scopes, get/index masks} — ONE registry populated
by buildRouter, shared by emitter+gateway+WS3, zero app wiring); the bus
(`controller/src/channels/bus.ts` — MemoryBus tier 0 with the record
short-circuit, PgNotifyBus tier 1 opt-in with dedicated session connection
+ boot self-NOTIFY probe teaching the PgBouncer failure + batched/chunked
<7.5KB payloads + the 1262 signal documented, Redis/NATS teaching stubs;
ids-only events ALWAYS — epochs never ride the bus); the emitter
(`controller/src/channels/emitter.ts` — silence rule per VIEW mask,
tenant-hashed index lanes for URL-scoped doors, slice builders through
buildColumnarEnvelope with a k-divergence per-row fallback); the gateway
(`controller/src/channels/gateway.ts` — Origin gate + one-time
mint/consume tokens (attach-guard pattern, in-memory ⇒ sticky-LB note),
SUB dry-run via oRPC call() into validate/get/index (record SUB with
cursor IS the WS3 three-way validation; index SUB_ACK carries the
membership tag), per-sub epochs starting 1, RESET on re-check/REAUTH
failure, revalidate-TTL'd reload-through-door as the emission re-check,
coalesce+supersede per sub, CHANGE→SIGNAL soft backpressure + 1013 hard,
both heartbeat levels, drain 1001); the trails scaffold main.ts template
captures serve()'s http server, attaches channels, and mounts the token
mint inside the app's own context builder. Suites: core
channels-config/frame-codec/transport-events (unit + real PG), controller
channels/bus + channels/emitter + channels/gateway (real PG, real routers,
in-process ws clients — auth refusals, dry-run three-way, frame-only edit
delivery, end-to-end silence, touched-only destroy frames, tag SIGNALs,
revocation RESET with bumped epoch, REAUTH, drain 1001, heartbeat
termination). CLIENT HALF: `react/src/channels.ts` (`connectChannels`
behind the ChannelTransport seam — SharedWorker is a documented TODO on
the interface; the O16 peekHeader epoch filter; CHANGE→mergeEnvelope, the
ONE decoder; SIGNAL→store.signal + coalesced WS3 revalidate; RESET→adopt
epoch, force-revalidate, re-SUB fresh; reconnect 1001-fast/1013-short/
full-jitter with per-dial token mint + cursor re-SUB + mount-registry
force revalidation; app heartbeat + REAUTH), pinned by
`react/tests/channels.test.ts`. ACCEPTANCE:
`controller/tests/channels/acceptance.test.ts` — the cross-package
six-scenario suite, real PG → real routers over real HTTP
(@orpc/server/node, the scaffold's serving shape incl. the POST
/cable/token mint) → real 'ws' sockets → the REAL react client + store:
(1) frame-only convergence <500ms with ZERO refetch (HTTP ledger +
validator-callable counters both flat), (2) silence rule asserted at the
socket, (3) kill + 10-write catch-up via the cursor-carrying re-SUB
dry-run + mount revalidation, per-field lastSeen at the final token,
(4) O16/T9(ii) epoch replay — captured AND forged pre-RESET frames
injected post-RESET leave the store untouched, (5) upgrade auth
(401/single-use/Origin 403), (6) heartbeat aliveness + burst coalescing
(fewer CHANGE frames than writes, same final state).

**REVIEW-HARDENED 2026-08-27 (same-day external review; two blockers +
nine majors applied, all pinned by new tests):**
(a) **A2 at the tap** — commit events now carry a SNAPSHOT instance
(fresh instance over cloned `_attributes`, built at the write-log call
sites, only when a publisher is registered) instead of the LIVE record:
the gateway serializes at coalesce-flush time, and app code mutating the
record (or starting a second save) inside that 20–50ms window could pair
uncommitted values with a committed token — a phantom the 304 machinery
would then CERTIFY permanently. Pinned by the overlapping-writes drive in
core transport-events.test.ts.
(b) **The tenant boundary now covers metadata** — record-less index
events (ALL cross-process events under pg-notify) were emitted as
SIGNAL{table,pk,token,op} door-wide with no scope check: a pk/version/op
oracle over every other tenant's rows. Scoped doors now per-pk dry-run
EVERY record-less event (scopeBy already did for value slices), and the
emitter STRIPS unplaceable records before any door-wide publish.
(c) **T9 on the index lane** — flushIndexSub consulted no pass at all
(no RESET was ever produced for an index sub; revocation streamed
forever). The same revalidate TTL now re-runs the index dry-run at flush;
failure RESETs. Destroy frames on record subs are likewise gated: an
expired-pass destroy downgrades to RESET (the re-SUB re-answers through
the validate/tombstone fences) instead of handing a stale-authorized
socket the tombstone triple.
(d) **O5 license restored** — WS4 consumed tag-equality as a reconnect
skip, which v1's lifecycle-only bump never licensed. Two-sided fix:
scope-column VALUE writes now bump the tag in-commit
(registerMembershipDoor carries membership columns; the emitter fans an
ids-only membershipHint door-wide so the OLD tenant invalidates live),
and the client fires onTag on EVERY re-ack, tag-equal included. Residual
stated in ws-channels §6 + docs: arbitrary filter-crossings heal on
refetch/reconnect until the compiled scope-intersection trim.
(e) **Lane-hash agreement** — the gateway hashed ALL SUB params while the
emitter hashes only scope columns: any extra param (filter, perPage)
silently subscribed a lane nobody publishes. indexChannelsFor now picks
entry.scopes' paramNames only (String()-canonicalized both sides); hash
widened 48→128 bits (the value lane trusts it).
(f) **Authenticated-DoS bounds** — `ws` maxPayload 64KB (default was
100MiB/frame); maxConnections (503 at cap, before the token burns);
maxSubsPerConnection (SUB_LIMIT) doubling as the SUB token-bucket burst
(refill 20/s, RATE_LIMITED) — every SUB dry-run is a real DB query.
(g) **pg-notify self-healing** — a dropped LISTEN session reconnects
with backoff + re-LISTEN (was: permanently deaf node with
heartbeat-healthy sockets); chunk sizing counts UTF-8 BYTES not UTF-16
length; a single over-cap event is dropped from the wire loudly.
(h) **Scaffold honesty** — trails.config template no longer selects the
THROWING 'redis' stub off ambient REDIS_URL; bus tiers are explicit
opt-ins.
(i) Cheap hardening from the same review: client epoch table is
max-join at RESET and SUB_ACK (a forged old-epoch RESET cannot regress
the O16 filter — pinned by a subId-reuse drive); degraded SIGNALs carry
their honest op (a destroy never announces as an update); backpressure
thresholds/degrade extracted to an exported seam
(sendFrame/sendChangeWithBackpressure) with unit tests (bufferedAmount
never rises on loopback, so socket suites cannot execute the ladder);
scopeBy pkPass cache pruned; coalescer supersede pinned deterministically
via bus-injected same-pk events (keep-LATEST, record-preferring at equal
tokens); token single-use pinned under CONCURRENT double-upgrade; REAUTH
failure pinned (old ctx kept, both sides); reconnect fan-out pinned with
2 record subs + 1 index sub + 2 mounts; k-divergence fallback and
async-rejecting publishers pinned. NOT taken, stated: a bus-delivered
per-principal revocation push (the revalidate TTL is the documented
bound; docs now say so explicitly), and a heartbeat-tolerance pin (node
'ws' auto-answers protocol pings — no cheap deterministic seam).
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

**AMENDED 2026-08-27 (WS4 server landing)** — the varint-channelId sketch is
superseded by a FIXED 9-byte header; this section now describes the landed
wire (`packages/core/src/transport/frame-codec.ts`, the isomorphic
`@active-drizzle/core/frames` subpath — ONE codec for server and browser).

Binary; control bodies msgpack; raw payload tail on CHANGE (later DOC).

```
byte  0      type     1=SUB 2=UNSUB 3=SUB_ACK 4=CHANGE 5=DOC(reserved)
                      6=PRESENCE(reserved) 7=PING 8=PONG 9=RESET
                      10=REAUTH 11=SIGNAL
bytes 1–4    subId    uint32BE — server-interned per-connection subscription
                      integer, assigned at SUB_ACK (0 = connection-level)
bytes 5–8    epoch    uint32BE — per-(connection, subscription) generation
                      (O16); 0 where n/a
bytes 9–12   bodyLen  uint32BE
bytes 13…    body     msgpack control body
then…        payload  raw bytes to EOF (CHANGE only in v1)
```

WHY fixed instead of the original varint channelId: the epoch filter
(landmine 11) must drop pre-epoch frames BEFORE parsing any body — a fixed
offset makes it a 9-byte peek (`peekHeader`), no allocation, no msgpack.
Channel STRINGS travel only inside SUB/SUB_ACK bodies; interning keeps data
frames tiny.

Control bodies (msgpack):

```
SUB      c→s  { ref, door, id?, params?, cursor?, projId? }
              record chan: id set; cursor = projFreshAt (W) + projId invokes
              the door's WS3 validate as the dry-run; cursor-less invokes get.
              index chan: id absent; dry-runs index (perPage 1).
SUB_ACK  s→c  { ref, ok:true, door, id?, cursor?, gone?, d? }   header: subId, epoch=1
              record cursor = the lock-int watermark; index cursor = the
              membership tag. stale ⇒ an immediate CHANGE follows the ack.
              refusals: { ref, ok:false, code, message } (header subId 0).
CHANGE   s→c  body {} — payload = the UTF-8 JSON BYTES of a partial
              ColumnarEnvelope { entities, touched? }: buildColumnarEnvelope's
              own output (the serializer is TEXT JSON, so "byte-compatible
              with GET/validation slices" MEANS those JSON bytes framed raw —
              A0/A3). Client decode: JSON.parse → mergeEnvelope, unchanged.
              Destroys: payload { touched:[{resource,id,op:'destroy',version}] }.
SIGNAL   s→c  { table, pk, token, op } (rumor lane / CHANGE degrade) or
              { tag } (index-channel membership tag)
RESET    s→c  { reason } — header epoch = the NEW epoch; drop local sub
              state, revalidateProjection(force), re-SUB with cursors
UNSUB    c→s  {} (header subId)
PING/PONG both { …echoed } — app-level (browser-visible) liveness; the
              server ALSO runs protocol-level ws pings
REAUTH   c→s  { ref, token } (fresh one-time token) / s→c { ref, ok }
```

Rules: data frames with epoch < current(subId) are DROPPED at the 9-byte
peek, before any body decode. Epoch is stamped at socket-write time by the
serving node and NEVER rides the bus. Heartbeat 25s both levels; server
closes 1001 on drain; backpressure: bufferedAmount >1MB ⇒ CHANGE degrades
to SIGNAL (tokens only), >4MB ⇒ close 1013; client reconnect =
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
-- LANDED FORM (write-log.ts WRITE_LOG_SCHEMA_SQL) revises this sketch:
-- model = TABLE NAME text (smallint numbering is not deploy-stable),
-- pk = text (uuid pks are a framework default — O14), committed_at added
-- for retention, lifecycle gains 3 = undelete (soft re-creation trips
-- clause ii). Plus record_write_log_meta(model, fields_hash) — fieldsRev
-- reconciliation (wired LAZILY before each table's first bitmap read;
-- optional boot accelerator) deletes a drifted model's lifecycle=0 rows.
create table record_write_log (
  model        text     not null,      -- table name (identity space)
  pk           text     not null,
  token        bigint   not null,      -- the lock int
  changed      bytea    not null,      -- field bitmap, declaration order
  lifecycle    smallint not null default 0,  -- 0 none, 1 create, 2 destroy, 3 undelete
  committed_at timestamptz not null default now(),
  primary key (model, pk, token)
);
-- retention: everything but lifecycle=2 prunable by age (default ~72h;
-- expiry ⇒ the gap rule ⇒ conservative slice; creates are outside every
-- interval since W ≥ 0); lifecycle=2 EXEMPT forever — the tombstone map
-- (gone(D)'s only lawful source; O12 symmetry).

-- membership tags (WS3, O5): counter option — LANDED as ONE row per door
-- (not per paramsHash: unbounded rows, multiplied writes), upsert-bumped
-- in-commit by lifecycle writes; splice wire shape stays keyed
-- (door, paramsHash, from_tag) so per-paramsHash precision can land later.
create table membership_tags (
  door text   not null primary key,
  tag  bigint not null default 0
);
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
