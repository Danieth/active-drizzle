# Cache coherence — cross-surface mutations vs live (dirty) forms
### Design doc · session 10 · 2026-07-19 · status: PROPOSED (rev 2 — Daniel's per-door slice design)
### The "FML-level" bug: Form A edits Loan+proposals; an independent button mutates proposal #4; the form must get fresh WITHOUT losing the user's edits.

> **REV 2 DECISIONS (Daniel):**
> 1. The `touched` echo (A2) is DEMOTED to optional-someday — post-hoc,
>    opinionated, and slow-ish. The static graph + forced refetch is the
>    trigger story: "we auto-reload in forms anyway; any mutation just
>    forces it." Fires in the global MutationCache.onSuccess (after
>    completion), optionally optimistic at onMutate for display.
> 2. NEW TIER: **per-door normalized entity slices.** When a door's
>    envelope arrives, seed cache entries for every embedded child under
>    `[door, childResource, id]` (e.g. `[LoanCtrl.proposals, 4]` AND the
>    child's own `[ProposalCtrl, 4]` stays separate). Normalization is per
>    (DOOR, id), NEVER per (model, id) — projections never merge (the
>    partial-projection corruption that makes Apollo-style normalization
>    unsafe and that React Query core refuses to touch); only
>    INVALIDATION fans across the family, and the family is statically
>    enumerable at codegen time from the include graph.
> 3. Amendment (a): slices are SEEDED + DERIVED — no queryFn. Invalidating
>    a slice invalidates its FEEDER query (the parent detail); the parent
>    refetch re-seeds slices in the same pass. No new endpoints. (Codegen
>    MAY emit sub-resource GETs later as a hot-path optimization only.)
> 4. Amendment (b): slices serve DISPLAY surfaces (Items rows, chips,
>    counts — fine-grained re-renders via tracked queries). FORMS remain
>    on the FormSession baseline three-way merge (rehydrate) — a slice
>    cannot know about dirty keystrokes. Two consumers, one cache.
>
> Final stack: static door-graph invalidation → parents refetch →
> envelopes re-seed slices → display re-renders from slices → live forms
> three-way-merge → true conflicts fall through to the 409 story.
>
> **REV 3 (Daniel): cross-door INLINE PATCHING + the transport plug.**
>
> 1. **The subset doctrine (new, permanent):** a controller may REDUCE
>    the model's representation (expose = mask) but NEVER change it — no
>    per-door transforms, renames, or reshaped fields; codecs are
>    model-owned. This supersedes rev 1's blanket "never merge
>    cross-door" rule: that was the safe default before this invariant;
>    under it, cross-door patching is sound because shared fields are
>    guaranteed the same representation.
> 2. **Updates PATCH, structure INVALIDATES.** A value-update to a row
>    already present by id may be written inline into other doors'
>    cached copies (`setQueryData`). Creates/destroys/reparents/reorders
>    always invalidate — membership in a scoped list is a server-only
>    question.
> 3. **Static coverage check per door-pair edge:** codegen compares
>    projections; source ⊇ target ⇒ emit `patch` for that edge, else
>    emit `invalidate` (an incomplete patch would leave silent
>    staleness). The reverse-include map becomes a generated table of
>    `(sourceDoor → targetKeyFamily: patch | invalidate)` edges.
> 4. **Version guard on every patch** (layer C reused): apply only if
>    incoming version ≥ stored.
> 5. **One client entry point:** `applyEntityChange({resource, id, op,
>    version, payload?})` — fed by MutationCache.onSuccess today, a
>    WEBSOCKET tomorrow, a poller if desperate. The transport is a plug
>    because the fan-out engine is source-blind.
> 6. **WS events are SIGNAL-ONLY** — `{resource, id, op, version}`, no
>    payloads: the server broadcasts ONE canonical event and stays
>    door-ignorant (the CLIENT fans out across its projection keys via
>    the static map); pushed row payloads would bypass per-user door
>    ceilings (whose projection would they be in?) — that's the
>    sync-engine research problem, refused. Inline patches are fed only
>    by same-client mutation responses, where the client legitimately
>    holds a door-authorized payload.
> 7. Patches compose with live forms for free: setQueryData notifies →
>    useGeneratedForm hands the payload to rehydrate() → baseline merge
>    still governs dirty state.

## 0. Why this is winnable here and almost nowhere else

Three assets no other framework has together:
- **A unified write path** — every mutation, hook cascade, counterCache
  bump, and nested write goes through `ApplicationRecord.save()`. The
  server can KNOW, per request, exactly which rows changed.
- **The envelope + baseline** — every form session already stores "what
  the server last said" (`baseline`), separate from the draft. That's
  2/3 of a three-way merge, already shipped and already tested.
- **The 409 conflict story** — reload/overwrite UX for true conflicts is
  BUILT (optimisticLock). This design routes its hard case there instead
  of inventing a second conflict system.

The architecture is three layers. Each is independently useful; together
they close the bug.

```
A. TRIGGER   — make the right queries refetch (invalidation)
B. MERGE     — fold a refetch into a LIVE, possibly-dirty session
C. ORDERING  — never let an older payload overwrite a newer truth
```

---

## A. TRIGGER — exact invalidation, two sources

### A1. Static: the reverse-include graph (codegen)

Codegen already knows every door's `get.include` / `index.include`. Build
the transitive reverse map at generation time:

```
reactions → notes → deals        ⇒  mutating reactions invalidates dealKeys
proposals → loans                ⇒  mutating proposals invalidates loanKeys
```

Emitted as data (`_invalidationGraph`), not as per-hook code.

### A2. Dynamic: the `touched` echo (runtime — the killer feature)

Per-request AsyncLocalStorage collector in the controller runtime; every
`save()`/`destroy()` that commits appends `{resource, id, op}`. The
mutation response (and PATCH envelope) carries:

```
touched: [{ resource: 'proposals', id: 4, op: 'update' },
          { resource: 'loans',     id: 9, op: 'update' }]   // counterCache bump!
```

This answers Daniel's "side effect in a record the frontend doesn't know
about" — the frontend doesn't need to know; **the server tells it.**
Hook cascades, autosave associations, nested writes, counter caches: all
captured, because all writes funnel through one method. The static graph
(A1) remains as the fallback for engines/paths that can't echo.

### A3. Where it runs: ONE global subscriber, not per-hook wiring

React Query's `MutationCache` supports a global `onSuccess`. The
generated `_client` wires it once:

```ts
new MutationCache({
  onSuccess: (data, _vars, _ctx, mutation) => {
    const touched = data?.touched ?? graphLookup(mutation.meta?.resource)
    for (const t of touched) invalidateFamiliesThatInclude(t)   // via A1 map
  },
})
```

Every generated mutation (form hooks, `mutateCreate/Update/Destroy`,
nested instant transports) carries `meta: { resource, id }`. No hook
rewrites; central policy; app-defined mutations get it for free by
setting meta.

---

## B. MERGE — `session.rehydrate(envelope)`: the three-way merge

Today `useGeneratedForm` refuses refetches when `isDirty()` — all or
nothing. Replace with a real merge. Definitions per flat field `k`:

```
base  = baseline[k]        (server truth as of last sync)
mine  = draft[k]           (possibly edited)
their = incoming[k]        (fresh envelope)
```

| case                        | action                                   |
|-----------------------------|------------------------------------------|
| mine == base (clean field)  | adopt `their` into draft AND baseline     |
| mine != base, their == base | keep mine (server didn't move) — no-op    |
| mine != base, their != base | **true conflict** — see below             |

Field-diff submits make the disjoint case SILENTLY CORRECT: my later
PATCH carries only my dirty fields, so their concurrent change to OTHER
fields survives untouched. Disjoint concurrent editing just… works.
(This is applyFlushSuccess's never-clobber semantic, promoted from the
autosave success path to a general method — most of the code exists.)

### True conflicts route to the EXISTING 409 story

On any true field conflict: keep mine on the draft (never eat a
keystroke), and **do NOT adopt the incoming version token.** The next
submit/flush then 409s against the server, which returns the fresh
envelope, and the already-built conflict UX (status `'conflict'`,
SaveStatus "Changed elsewhere", `$resolveConflict('reload'|'overwrite')`)
takes over. One conflict system, not two. Optionally surface a soft
banner immediately ("this record changed elsewhere; your unsaved fields:
X, Y") — cosmetic, the 409 remains the enforcement.

No-conflict rehydrates DO adopt the fresh version token — so background
refreshes don't cause spurious 409s.

### Children: merge by id, door-homogeneously (the projection rule)

**THE RULE: merges only ever happen between payloads of the SAME door.**
Never write ProposalController's response into the loan's embedded rows —
different projections, guaranteed nightmare ("nested models are a
projection"). Instead the proposal mutation only *invalidates* the loan
family (layer A); the loan's OWN refetch arrives in the loan's OWN
projection, and rehydrate merges like-with-like. The projection problem
cancels out by construction.

Per nested manager, merge incoming rows by id:
- id in both → recurse: `child.session.rehydrate(row)` (same table above;
  children have baselines too).
- id only in incoming → new child appeared elsewhere → insert (unless
  locally destroy-marked: that's a structural conflict → 409 route).
- id only in local: locally-new row (`new:` key) → keep, it's mine;
  persisted-but-missing → deleted elsewhere → if child clean, drop; if
  child dirty → structural conflict → 409 route.
- Singular (hasOne) manager: same table, arity one.

### updated_at's real role

The baseline three-way is STRICTLY STRONGER than timestamp comparison
(exact per-field, no clock skew, no same-second ties). `updated_at` /
the version token serves only layer C ordering (below) and telemetry.
Daniel's "best effort on updated_at" intuition maps to: version tokens
decide WHOSE PAYLOAD IS NEWER; baselines decide WHAT CHANGED.

---

## C. ORDERING — monotonic truth

Races: a slow in-flight GET can resolve AFTER a mutation echo that was
fresher. Guard in `rehydrate()`:

```
if (incoming.version < session.knownVersion) ignore payload entirely
```

(Version token compares as the opaque monotonic the optimisticLock
already defines: epoch millis for updatedAt, integer for lockVersion.)
React Query dedupes most of this; the guard makes it airtight, including
for envelope echoes arriving out of band (submit responses vs refetches).

---

## D. What stays out of scope / explicitly rejected

- **Surgical `setQueriesData` cross-door cache writes** — rejected (the
  projection rule). Invalidate-and-refetch is the only cross-door path.
  (Same-door `setQueryData` from a PATCH echo is fine and already
  implicit — the echo IS that door's payload.)
- A second conflict system. Overlaps route to the 409 machinery, period.
- Client-side clock reasoning. Only server tokens order payloads.

## D2. REV 4 — the compressed statement + the honest boundary

**THE CHALLENGE:** any surface can mutate a record other surfaces are
displaying or editing, through different doors with different
projections, with server-side effects the mutating client can't see —
without corrupting caches, losing keystrokes, or lying silently.

**THE SOLUTION (5 rules):**
1. Projections REDUCE, never change → shared fields always agree.
2. Codegen emits the door-pair edge table: `patch` where source provably
   covers target, `invalidate` everywhere else. Precision is decided at
   BUILD time. (This already catches Daniel's "secret field" case: a
   field exposed on the embedding door but not the mutating door fails
   coverage → that edge is `invalidate` → the refetch through the
   embedding door picks up the hook's side effect. No corruption
   possible; degradation IS the design.)
3. Updates patch; structure invalidates (membership is a server-only
   question).
4. Fresh payloads merge into live forms via the baseline three-way;
   true conflicts fall through to the EXISTING 409 story.
5. One source-blind entry point (`applyEntityChange`) — local mutations
   today, signal-only WS tomorrow, same pipeline.

**REV 5 — WRITE-EFFECT EDGES (Daniel's BidCtrl case).** The rev-4 graph
had only READ edges (include composition) and missed write propagation:
a Proposal mutation that side-effects its Loan leaves BidCtrl (which
includes loans, not proposals) stale. Fix: the edge table takes a second
static input — the **write-effect graph** — composed transitively, THEN
the read graph applies:

```
proposals →(touch/counterCache)→ loans →(included-by)→ bidKeys, loanKeys…
```

Sources, in order of cost:
1. **FREE, derived from existing declarations:** `counterCache` (child
   writes parent), `touch: true` on belongsTo (same), `dependent:
   'destroy'/'nullify'` (parent writes children), acceptsNested +
   autosave associations (parent writes children).
2. **DECLARED, one annotation for arbitrary hooks:** `@afterSave({
   affects: 'loans' })`. (Future validator nag: hook body references
   another model without declaring it.)
3. **Everything else = THE HONEST BOUNDARY** (best-effort, named, not
   silent): manual invalidate · the `touched` echo (deferred) · WS
   canonical events (future).

**Cross-CLIENT staleness is a different problem entirely** (Borrower's
browser mutates; Admin's browser holds the cache): no client-side graph
can help — that is purely the transport story (staleTime/focus refetch
today, signal-only WS tomorrow).

**Why runtime transports make this cheaper, not harder:** side-effected
records fire their OWN afterCommit inside the same request — so WS
publishers and the `touched` echo see ACTUAL writes (side effects
included) with zero static analysis. The static graph is the
approximation for request/response; the transports are the truth when
plugged in; same `applyEntityChange` pipeline, increasing fidelity.

---

## G. Form liveness — autoReload, autosave, poll-until (rev 4 additions)

- **`<Form autosave autoReload>`** — autosave exists; autoReload becomes
  REAL when `rehydrate()` (phase B) replaces the all-or-nothing dirty
  gate. Together: a form that saves itself when coherent and absorbs the
  world's changes when they arrive. `autoReload` defaults ON for
  envelope forms once rehydrate ships (it is strictly safer than
  today's ignore-refetches-while-dirty).
- **Poll-until** — thin over React Query (`refetchInterval` fn returning
  `false` stops the poll):

  ```tsx
  <Loans.One id={5} poll={{ every: 3000, until: d => d.reportStatus === 'ready' }}>
    <loan.reportUrl view pendingIf={d => d.reportStatus !== 'ready'}
                    pendingLabel="Generating report…" />
  ```

  `pendingIf` is a field prop resolved like presentIf/lockedIf; the
  presenter receives a pending state and renders its own affordance
  (spinner + label, overridable per presenter like everything else).
  The poll stops the moment `until` is satisfied; unmount cancels.
  Use cases: backend-job fields, "waiting for underwriting", imports.

## E. The convoluted demo form (the test rig — rev 4 final shape)

One page, deliberately nasty, in the demo repo. Fixture: give Note (or
Proposal) a field `internalScore` that a server hook recomputes whenever
`body` changes, exposed on DEAL's embedded slice but NOT on the child's
own controller — the "invisible side effect" case.

Layout: a dirty `<Deals.One id={1}>` form (user has edited `name` and
one note's body) beside three fully independent buttons:
  (a) edits ANOTHER note's body via the child controller — the hook
      also bumps that note's `internalScore`;
  (b) edits the exact field the user has dirty;
  (c) creates a new note.

Assertions (browser-verified, form never unmounts):
  1. after (a): the clean note's body updates in place AND its
     `internalScore` display refreshes — even though the mutating door
     never exposed it (the coverage check made that edge `invalidate`;
     the refetch came through the deal's own door);
  2. the user's dirty field and dirty note NEVER change under them;
  3. after (b): next save parks in `conflict`; reload and overwrite
     both behave (the 409 story, reused not duplicated);
  4. after (c): the new note appears in the list mid-edit (structure
     invalidated, not patched);
  5. the deals LIST card's note count updates (include-graph
     invalidation reaching a different surface entirely);
  6. a poll-until field ("report generating…") spins, then resolves and
     stops polling when the backend flag flips;
  7. **the write-effect edge (rev 5):** the note edit's hook also touches
     the DEAL (touch/counterCache) — a SECOND surface on the page that
     includes deals-but-not-notes (the BidCtrl shape) refreshes its
     embedded deal field, proving proposals→loans→bidKeys transitivity.

## G2. Draft persistence across navigation (rev 7 — "leave page A, come back, edits survive")

Nearly free because the only hard problem — the server moved while you
were away — IS rehydrate(): restoring a parked draft is the three-way
merge with roles renamed (mine = stored edits, base = stored baseline
slice, incoming = the fresh envelope on return). Same silent-merge /
keep-mine / withhold-token-→-409 outcomes; T1–T5 extend unchanged (a
parked draft is a form session with a long pause in it).

**The DraftStore (the only new piece, ~150 lines):**
- STORE THE DIFF, not the draft: `changedData()` (flat dirty + nested
  attributes payload — _key'd new rows, id'd edits, destroy marks) +
  baseline values OF THOSE FIELDS ONLY + version token, keyed
  [door, formKey]. Wire-shaped, JSON-safe, a few hundred bytes.
- Serialize on unmount (useGeneratedForm cleanup); restore after the
  next mount's session builds (replay flat fields via setValue, nested
  via the managers); CLEAR on successful submit of that key.
- WEAK semantics: module Map, LRU cap + TTL — a courtesy, not a
  database. Optional sessionStorage tier for tab-reload survival.
- New-record forms: key 'new' per door; if autocreate already minted an
  id (createdId), the stored key follows it.
- UX free of charge: restored fields are dirty-by-construction against
  the fresh baseline → SaveStatus "Unsaved changes" + per-field dirty
  dots light up with zero new code. Optional soft "restored your
  unsaved edits" banner.
- Synergy: React Query's cache makes the RETURN instant (last envelope
  renders immediately, background refetch re-trues via rehydrate); the
  validity-gated autosave means the drafts most worth parking (half-
  valid, couldn't flush) are exactly the ones parked.

## H. APPENDIX — the formal model (rev 6: prove it or name the assumption)

### H.0 What IS this problem, in a lot of words

This is **cache coherence for a projected, permissioned, request/response
distributed system**. There is one authoritative state (Postgres). Every
browser holds multiple *replicas* of *projections* of fragments of that
state: React Query entries keyed per door, and form sessions holding a
baseline plus a divergent working copy (the draft). Replicas are updated
concurrently by: the user's own edits, the user's own mutations through
other surfaces, other users' mutations, and server-side write effects
(hooks, counters, cascades) that no client ever directly requested.

We are explicitly NOT building strong consistency or linearizability —
request/response forbids it and the product doesn't want it (a form is
SUPPOSED to hold divergent state; that's what editing is). The problem
is to guarantee, precisely: **no replica ever holds a state the server
never served through that door (no corruption); no user edit is ever
destroyed except by that user's explicit choice (no lost keystrokes);
every genuine conflict becomes visible rather than silently resolved
(no silent divergence); and, under stated transport assumptions, every
replica eventually reflects current server truth through its own door
(convergence).** Safety unconditionally; freshness best-effort with the
effort quantified. That is the problem. Everything in this doc is a
mechanism serving one of those four clauses.

### H.1 The model

- Server state `S_t`: records `r` with fields `F(r)`; each governed
  record carries a monotonic version `v_t(r)` (optimisticLock token).
- Doors `d`: projection functions `π_d` over records/graphs.
- Cache entries `C[d,k]`: claimed to hold `π_d(S_t)` for some `t`.
- A form: `(B, W)` — baseline `B = π_d(S_t)` for some `t`, draft `W`.
  Dirty set `Δ = { f : W.f ≠ B.f }`.
- Mutation `m`: server transition `S → S'` with true write-set
  `touched(m)` (every record changed, side effects included).
- `G`: the static edge relation = read edges (includes) ∘ transitive
  write-effect edges (counterCache/touch/dependent/nested/declared
  `affects`).

### H.2 Axioms (these are DOCTRINES — enforced by construction/validator,
not proven)

- **A1 (Subset):** `π_d` only masks fields; one model-owned codec per
  field. Two doors agree on every shared field of the same `S_t`.
- **A2 (Membership):** whether a record belongs in a door's
  list/include is computable only server-side.
- **A3 (Effect completeness):** `touched(m) ⊆` records reachable from
  m's target via `G`. TRUE by derivation for counters/touch/cascades/
  nested; by DECLARATION for annotated hooks; VIOLABLE by an undeclared
  hook — the named boundary.
- **A4 (Transport):** every client eventually runs `applyEntityChange`
  for changes relevant to it — via HTTP (staleTime/refocus/own
  mutations) or WS signals + refetch-on-reconnect.
- **A5 (Version monotonicity):** `v(r)` strictly increases per governed
  write; payloads carry it.

### H.3 Theorems

**T1 — No corruption.** Every cache entry always equals `π_d(S_t)` for
some REAL past `t`, through that ONE door.
*Proof sketch.* Entries are written only by: (i) that door's own
responses — trivially `π_d(S_t)`; (ii) patch edges, which require
static coverage `fields(source) ⊇ fields(target)`: the patch rewrites
EVERY target field from one source payload of state `S_t'`, and by A1
the values equal `π_d(S_t')` — so the entry becomes exactly
`π_d(S_t')`, not a chimera. Partial patches are unrepresentable (the
edge table emits `invalidate` when coverage fails). Structural changes
never patch (A2), so list membership is only ever door-served. ∎

**T2 — No lost keystrokes.** For every field `f ∈ Δ`, `W.f` is never
overwritten except by the user's own `resolveConflict('reload')`.
*Proof sketch.* Exhaustive over write paths into `W`: rehydrate's case
table never adopts into dirty fields; applyFlushSuccess folds only
fields unchanged since the flush snapshot; applyEnvelope on refetch is
replaced by rehydrate (the all-or-nothing gate's successor); patches
touch `C`, not `W` — forms read `C` only through rehydrate. The only
remaining writer is resolveConflict('reload'), which is the explicit
choice. ∎

**T3 — No silent divergence.** If `f ∈ Δ` and the server's `f` moved
from `B.f`, then before the user's value can persist, the conflict is
surfaced.
*Proof sketch.* Rehydrate detects `mine ≠ base ∧ their ≠ base` and
WITHHOLDS the fresh version token. Any subsequent submit/flush carries
the stale token; by A5 the server compares and returns 409 with the
fresh envelope; the session parks in `conflict` with exactly two
labeled exits. The user's value cannot land without passing through
`overwrite` — an explicit act. (If no rehydrate arrived first, the
submit itself 409s directly — same terminal.) ∎

**T4 — Convergence.** At quiescence (no new mutations), under A3 + A4,
every entry and every CLEAN form field reflects `π_d(S_final)`.
*Proof sketch.* Each mutation's `touched` set is covered by `G` (A3),
so every dependent family is invalidated or patched; A4 delivers the
event; invalidated entries refetch through their own door (yielding
`π_d(S_final)`); patched entries equal it by T1; clean form fields
adopt via rehydrate case 1; ordering cannot regress by T5. A3
violations degrade FRESHNESS of the affected entries only (stale until
a hatch fires) — never safety, since no mechanism fabricates data. ∎

**T5 — Monotonicity.** No entry or baseline ever regresses to an older
state: every apply path is guarded by `incoming.v ≥ stored.v` (A5). ∎

### H.4 What is NOT claimed (the honest ledger)

- Not linearizability; a replica may be stale within A4's window.
- Field-level merge can compose a state no single user authored (two
  users, different fields). Server-side validations re-run on every
  save, so invalid compositions are REJECTED server-side; semantically
  coupled-but-valid compositions are accepted — that is a deliberate
  granularity choice, same as every field-merging system.
- A3 is an assumption in static mode. It is DISCHARGED — becomes a
  runtime fact — by any transport that observes actual writes
  (afterCommit-fed WS or the touched echo), because the server no
  longer predicts its write-set, it reports it.
- Cross-client freshness is exactly as good as A4's transport. HTTP:
  bounded by staleTime/refocus. WS: bounded by signal latency +
  reconnect reconciliation.

### H.5 "If I just added WS — would it just work?" — YES, precisely:

WS is a second event source feeding the SAME `applyEntityChange`, with
`refetch-active-queries` on reconnect (missed-signal reconciliation).
Given the client pipeline exists (rehydrate + edge table + entry
point), adding WS changes NO safety machinery and upgrades two things:
1. **A4 tightens**: cross-client staleness drops from
   staleTime/refocus-bounded to signal-latency-bounded.
2. **A3 is discharged**: afterCommit fires on ACTUAL side-effected
   records inside the mutating request, so signals carry the true write
   set — undeclared hooks stop being a hole, and the static graph
   becomes a same-client latency optimization rather than the source of
   truth.
T1/T2/T3/T5 are untouched (they never depended on the transport).
That is the meaning of "it would just work": the proofs are
transport-independent by construction; WS only strengthens the two
assumptions the proofs lean on.

## F. Phasing (rev 2)

1. **B first, standalone** — `session.rehydrate()` + manager merge-by-id
   + ordering guard, replacing the isDirty() refetch gate. Pure react
   package + tests; valuable even with today's dumb invalidation
   (refocus refetches stop being all-or-nothing).
2. **A1** — reverse-include graph emission + global MutationCache
   subscriber + meta on generated mutations/transports. Invalidation
   fans across the per-door key family (statically known).
3. **SLICES** — envelope-arrival seeding (`setQueryData` per embedded
   child under `[door, resource, id]`), feeder-invalidation semantics,
   display components subscribing to slices (Items rows first).
4. **E** — the convoluted form, browser-verified, folded into the demo
   as a standing showcase ("edit while the world changes under you"):
   dirty form + independent same-row mutation + independent same-FIELD
   mutation + new-child-appears + counterCache count elsewhere.
5. *(someday, only if over-invalidation measurably hurts)* — the
   `touched` echo as a precision trim on top of the graph.
