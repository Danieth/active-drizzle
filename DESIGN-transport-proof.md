# DESIGN — The Transport Theorems (mathematical proof of the transport layer)

### Status: rev 3 · 2026-08-27 · externally reviewed twice (rev 2's L2 had a
### real counterexample, fixed here). Formal companion to DESIGN-ws-channels
### and DESIGN-wire-identity; obligations O1–O16 open, tracked in §7.

---

## The kernel

**Object.** Application state that is records under policy, plus a document
lattice. One Postgres commit order is the authority. The browser is a
replica, not a second database.

**Normal form.** Five pieces, all required:

- **Registers for rows.** Each cell is a last-writer-wins register whose
  timestamp is the server's per-record token. A token certifies only the
  fields present in the payload. Lifecycle is itself a register: a delete
  floor that never goes down. Merge is join.
- **Lattice for docs.** Rich text is not a row. Updates join; a gapless
  ledger plus a *prefix* cursor (not a high-water mark) is the pull floor.
- **D the only serializer.** A door is a function
  `(user, doorId, record) → field-slice`. It masks; it never transforms.
  Every GET, echo, frame, and 304 factors through D. Agreement on
  overlapping fields is then a lemma, not a convention.
- **Pull as law.** Safety assumes a weak channel: loss, reorder,
  duplication. Push is prepaid pull — latency, not correctness. Signals are
  rumors; only payloads and coverage-validated 304s certify.
- **Compiler as finite universe.** The lemmas range over a closed set of
  (model, field, door) triples. App code cannot add a second serializer, a
  nested hidden version, or a guessed membership patch. That is why a short
  model/form description implies the invariants.

**Two cuts that are not style.**

- Identity merges; membership is replaced. A filtered, ordered page is not
  a join of local facts.
- Storage is keyed by identity; freshness is asked by coverage. "Is this
  record fresh?" is not well-formed when doors see different fields.
  `knownVersion` is a rumor bound. `projFreshAt` is the receipt.

**What the theorems are allowed to say.** Every cell in the authoritative
client store σ is a door-image of a value that existed at its certified
token, or is hidden by the delete floor. A rendered card is
componentwise-valid, not a historical snapshot of S. Session snapshots,
Terry-complete guarantees, and non-interference are outside the model.
After an own-write RPC returns: lastSeen is at least that mutation's token
— your write or a later server value, never an earlier one. Optimism lives
in an overlay; it never enters σ.

**Kernel, not universe.** This is the strongest closed form for "Postgres
stays the record, the client is real, auth is field-exact, memos actually
co-edit." Kafka, object storage, search, foreign systems are adaptors
around that kernel. A different algebra (CRDT-as-SoT, accept-write-here
multi-region, HTML-over-the-wire with no client replica) is a different
peak, not a larger version of this one.

**One sentence.** Authority produces a total order of facts; the client
store is the join of the facts it has been shown, filtered by D; the
compiler makes every other state unrepresentable.

## The working question

This document was not produced by "does this cache design make sense?" It
was produced when the question became a *classification of the problem*,
not a review of a mechanism.

> Almost all application software is a single canonical database of
> records, projected through authorization into many surfaces, cached in a
> real client that must stay cheap, live, and unable to invent state.
> Collaborative documents exist, but they are not the database. Scale-out,
> logs, and foreign systems are adaptors.
>
> If Postgres is that authority, the model is a typed superset of what can
> be saved, every user-visible byte is a compiled projection (never a
> second serializer), and the UI is presenters over a cache —
>
> **what is the strongest closed algebraic form of that system?**
>
> Precisely: what merges, what must be re-asked, what a version token may
> certify, what the network is allowed to break, and what the compiler must
> make unrepresentable so the application stays a few dozen lines.

The clauses that do the work:

1. **Canonical store** — one commit order, not "the client is also true."
2. **Typed model ⊇ saveable state** — the model cannot say an unsavable thing.
3. **Projection + auth as the same function** — countless controllers, one D.
4. **Client is a cache of D(S)** — live is acceleration; correctness is pull.
5. **Docs are a second algebra** — lattice, not `UPDATE body`.
6. **Closed world** — compiler, not discipline.
7. **Ask for the form, not a feature list** — "what joins, what is
   forbidden," not "is websockets a good idea."

Omit (7) and you get a framework review. Omit (3) and (6) and you get
Apollo. Omit (5) and you get rows pretending to be editors. Omit (1) and
you get local-first as the kernel. Everything below is that question
answered without leaving the class it defines.

---

## §0 Scope and method

A distributed system is proved *relative to* a machine model and axioms,
never absolutely. This document names the model, the axioms (each a
property of a purchased component — Postgres, Loro — or a discipline the
codebase must enforce), and proves what follows. Everything not derivable
here is a **non-theorem** (§6) or an **obligation** (§7). The following are
*not* claims of this model and must never be quoted as such: session
snapshots, the Terry session guarantees, snapshot isolation of any surface,
non-interference of the push channel, and cross-record atomicity of
envelopes.

## §1 Machine model

One server S; clients c₁…cₙ. Time is asynchronous; no physical clocks
appear anywhere. Two channel models, never silently interchanged:

- **Definition 1.1 — weak channel 𝒞w.** Delivers an arbitrary sub-multiset
  of sent messages, in arbitrary order, with arbitrary duplication. All
  push traffic (frames, signals, resets) is modeled on 𝒞w. Every safety
  theorem is proved on 𝒞w; none may assume more.
- **Definition 1.2 — RPC channel 𝒞r.** Request/response: a response, if
  delivered at all, is delivered to its caller, after its request was
  processed, before the call returns. Mutations and GETs run on 𝒞r.
  Exactly one result (T6a) uses this strengthening.

## §2 Axioms

- **A0 — canonical representation.** Each field has one codec; every
  payload kind — GET response, echo, frame, validation response —
  represents a given cell (record, field, token) identically. Doors mask
  fields; they never transform values. (Previously an unstated "law"
  invoked by L1; now an axiom. It replaces any claim of byte identity
  between frames and pulls: frames are simply payloads satisfying A0–A3.)

- **A1 — lineage token chain.** Each identity (model, pk) carries a token v
  that is strictly increasing across **all** commits writing that identity,
  including destroys and any later re-creation of the same pk. (Tokens are
  per-lineage, not per-row-incarnation: a physical delete must not restart
  the counter. Satisfied automatically when primary keys are never reused —
  serial/UUID allocation, the framework default; tables with natural keys
  require soft deletion or an external lineage source. Obligations O2,
  O14.) No axiom asserts a global order across records. All theorems are
  per-identity; "one watermark" language is licensed only per identity.

- **A2 — snapshot payloads (single record, all payload kinds).** Every
  payload about an identity r — pull, echo, **or frame** — carrying fields
  F at token V is computed from one committed snapshot in which v(r) = V; a
  destroy payload at D corresponds to a real destroy commit at D.
  **Deliberately not claimed:** that a multi-record envelope is one
  snapshot. No theorem below is cross-record. (Obligation O1: false of
  today's code until `save()` is transactional.)

- **A2′ — the validation predicate (lifecycle-aware).** On a validation
  request (r, P, W) with current token V = v(r), the server answers:
  - **304 carrying V** iff (i) ∀f ∈ P: last_write(f) ≤ W, **and**
    (ii) lastLifecycle(r) ≤ W — no destroy or re-create in (W, V] —
    **and** (iii) r is live at V;
  - **gone(D)** if r is destroyed, where D is the destroy token;
  - the dirty slice otherwise.

  (Clause (ii) is required: with (i) alone, a client holding `name@10`
  against a record destroyed at 11 validates with W = 10, receives 304, and
  certifies a value at a token where the record does not exist. Lifecycle
  is part of the predicate, not an implementation detail. Obligation O10.)

- **A3 — door totality.** The door is a function
  D: (user, door, record) → field-slice, and *every* byte path to a client
  factors through D: row pulls, echoes, CHANGE frames, validation
  responses, **and doc-lane frames** — Loro bytes for a field travel only
  on channels whose door grants that field.

- **A4 — gapless linearized ledger.** Per document, `doc_updates` is
  append-only; appends are linearized under an advisory lock held through
  commit; the committed `seq` set is always {1,…,k}. (Obligation O3:
  `seq := max+1` under the lock; a Postgres sequence is non-transactional
  and violates this axiom.)

- **A5 — Loro kernel.** Loro's document states form a join-semilattice;
  `import` joins current state with received updates — idempotent,
  commutative, associative — buffering causally premature updates. SEC
  (Shapiro et al. 2011) applies: equal received *sets* imply equal states.
  (Trusted kernel; O4 selects the trust level.)

- **A6 — fair pull (liveness only).** A client that keeps attempting a pull
  eventually completes one. No safety result uses A6. **Product note:** A6
  is where the product lives — the proofs are content for the screen to be
  stale forever if pulling is broken.

## §3 Client state and Rule M

**Record lifecycle is monotone state.** The store is
σ: (model, pk) → entry, where an entry is a pair

    entry = ( floor ∈ T ∪ {−∞},  cells: f ↦ (value, lastSeen ∈ T) )

— the **deletion floor** is never discarded and only rises. Beside the
entry, knownVersion(pk) is the greatest token ever *heard*: a rumor bound,
never a freshness claim. There is no tombstone object; "deleted" is an
*interpretation*, not a state shape.

**Rule M (merge).**

- **M1 (live payload F at V).** For each f ∈ F:
  cell(f) := (payload.f, V) iff V ≥ lastSeen(f) (a missing cell has
  lastSeen = −∞). The floor is untouched. Fields ∉ F are untouched —
  **absence is projection, never null**; null travels as an explicit cell.
- **M2 (destroy at D).** floor := max(floor, D). Cells are untouched
  (garbage collection may drop dead cells; Lemma L3).
- **M3 (bare signal at V).** knownVersion := max(knownVersion, V). Nothing
  else. Signals never certify.
- **M4 (validation response for projection P).** *Precondition:* the client
  holds a cell for every f ∈ P (else lastSeen is undefined and the request
  is ill-formed — enforced by construction, since W is computed from held
  cells). On **304 carrying V**: lastSeen(f) := max(lastSeen(f), V) for
  each f ∈ P. On **gone(D)**: apply M2. On a slice: apply M1.

Every payload also performs M3's knownVersion update with its token.

**Interpretation I (rendering, not state).** Cell f is **visible** iff
lastSeen(f) > floor. The record renders as **gone** iff no cell is visible
and floor > −∞. Field f is **current** iff visible and
lastSeen(f) ≥ knownVersion; projection P is current iff every f ∈ P is;
projFreshAt(P) := min over f∈P of lastSeen(f). The doc-lane **cursor** is
the contiguous prefix max{ n | {1,…,n} ⊆ received }, never the high-water
mark.

## §4 Lemmas and theorems

**Lemma L1 — agreement.** Any two payloads carrying field f of identity r
at the same token V carry equal values.

*Proof.* By A2 each is read from a committed snapshot with v(r) = V; by A1
there is exactly one such state in the lineage; by A0 both apply the same
codec to the same cell. The absence≠null clause makes "carrying f" a
predicate; without it the lemma is not well-posed. ∎

**Lemma L2 — the entry semilattice.** The entry space under Rule M is a
join-semilattice, and processing any multiset of payloads about one
identity yields the componentwise join of their contributions —
independent of order and duplication.

*Proof.* The entry is a product: floor lives in the max-semilattice
(T ∪ {−∞}, max); each cell lives in the max-by-token semilattice (values
well-defined at each token by L1); knownVersion in (T, max). M1, M2, M3,
and M4's three cases each compute a componentwise join with the payload's
contribution (a destroy contributes only to floor; a live payload only to
its carried cells; a 304 only to lastSeen, soundly by T3). A product of
join-semilattices is a join-semilattice; joins are idempotent, commutative,
associative by construction — there is no cross-component interaction to
check, because **no rule ever lowers or removes the floor and no rule's
guard reads another component**. ∎

> **Why rev 2's L2 was false — the counterexample, preserved.** Rev 2 made
> tombstone and field-map mutually exclusive, with a live payload above the
> tombstone *replacing* it. Then {a@10} · destroy@15 · {b@20} gave {b@20}
> in one order, but {a@10, b@20} in the order A·B·D (the destroy at 15
> dropped against max lastSeen = 20) — non-commutative; and in the order
> D·B·A the resurrected map accepted the pre-delete cell a@10 —
> resurrection through recreation. The floor repairs both: in every order
> the result is (floor 15, {a@10, b@20}) with a@10 **invisible forever**
> (10 ≤ 15, and the floor only rises), rendering as {b@20}. The deletion
> token can never disappear; that is the entire fix.

**Lemma L3 — garbage collection.** Physically dropping a dead cell
(lastSeen ≤ floor) never changes the interpretation of any reachable
future state.

*Proof.* A dropped cell re-merges from lastSeen = −∞; any payload for it at
V ≤ floor recreates a cell that is again invisible (floor is monotone);
any payload at V > floor produces the same visible cell whether or not the
dead cell existed (max-by-token with a dead lower bound is the identity on
the outcome). ∎

**Theorem T1 — per-cell convergence.** Each cell (r, f) is a
last-writer-wins register with per-lineage totally ordered timestamps; the
floor is a monotone register. Two clients that have received the same
**set of payloads mentioning (r, f)** (and the same destroy payloads) hold
the same cell, floor, and hence interpretation — regardless of order and
duplication.

*Proof.* L1 + L2 (joins over equal sets are equal). A bare signal is not a
payload carrying f (M3) and certifies nothing. No cross-cell claim is
made. ∎

**Theorem T2 — monotonicity and no resurrection.** (i) lastSeen, floor, and
knownVersion are nondecreasing; a rendered cell's certified token never
regresses. (ii) After a destroy at D merges, no cell with token ≤ D is
ever visible again, in any delivery order — including the recreation case:
a re-created record at tokens > D can never exhibit a pre-delete cell.

*Proof.* (i) All rules are joins. (ii) Visibility requires
lastSeen > floor ≥ D, and floor never decreases; by A1 the re-created
lineage's tokens exceed D, so its cells are visible while every pre-delete
cell stays dead. The guarantee is unconditional on delivery order — the
rev-2 dependence on tombstone survival is gone; what remains is that the
**floor itself** must survive entry eviction (a compact pk → floor map;
obligation O12, which also bounds the IndexedDB-restore path). ∎

**Theorem T3 — validation soundness (on A2′, by cases).** Processing any
validation response under M4 preserves T4's invariant; in particular, after
a 304 carrying V, every f ∈ P holds a value true at its (possibly
advanced) lastSeen, and the record was live throughout the certified
interval.

*Proof.* Fix f ∈ P, let L = lastSeen(f) at processing time, and note the
precondition (client holds f) makes L defined. **Case L ≥ V** (a fresher
payload — e.g. a push at 20 — arrived while the 304 at V = 15 was in
flight, legal on 𝒞w/𝒞r): M4 is the join with a smaller token, a no-op;
validity is untouched. **Case L < V**: the request's watermark satisfied
W ≤ L; A2′(i) gives last_write(f) ≤ W ≤ L, and A2′(ii) excludes any destroy
or re-create in (W, V] ⊇ (L, V], so f's value is constant and the record
continuously live on [L, V]; the held value (true at L, by T4) is the value
at V, and advancing lastSeen to V is a certification. The gone(D) case is
M2, sound by A2. ∎

> **Rejected predicates — recorded as counterexamples.**
> **(a)** "304 iff v(r) = W": after any signal it almost never fires — the
> uninteresting 304. **(b)** "slice-at-W = slice-at-V": the client does not
> hold slice-at-W; cells sit at individual lastSeen ≥ W. **(c)**
> "If-None-Match: knownVersion": conditions on rumor; freshens cells that
> never arrived — the one forbidden corruption. **(d)** A2′ without the
> lifecycle clause: certifies a value at a token where the record does not
> exist (the destroyed-at-11 example). Model-checking targets (O8): *a 304
> never freshens a cell the client does not hold*, and *a 304 never
> certifies across a lifecycle event*.

**Theorem T4 — valid stale state (safety on 𝒞w).** Under arbitrary loss,
reordering, and duplication, every reachable store σ is **componentwise a
true past value**: every cell's value is the value of that field at commit
lastSeen(f) in its lineage; every floor corresponds to a real destroy at
its token. Frames add no proof surface: a frame is a payload satisfying
A0, A2, A3, indistinguishable in the model from the pull it pre-pays.

*Proof.* Induction on merge events; each M-step joins an (L1-agreed,
A2-snapshotted) true contribution; M3 writes no value; M4 is sound by T3.
No step manufactures a value–token pair or a floor that never existed. ∎

> **Remark — what T4 is not.** T4 is **not snapshot isolation**: a surface
> with cells at lastSeen 12 and 9 is componentwise true and is not a state
> of S. The design refused session snapshots deliberately; do not quote T4
> as one.

**Corollary C1 — transport irrelevance.** No safety statement references
delivery, ordering, or duplication. Every bus tier, coalescing policy, and
backpressure drop affects only latency of convergence. Push is a latency
optimization of pull; only pull (A6) is load-bearing. This is the
architectural claim of the system, and it is why a best-effort bus with no
outbox is sound rather than negligent.

**Theorem T5 — doc lane (on A4, A5, and the prefix cursor).** With the
cursor as the contiguous prefix, a client's applied document is the Loro
join of a causally closed subset of the gapless ledger; catch-up over
(cursor, k] is a pure range scan; equal cursors and received sets imply
equal documents; under A6, convergence.

*Proof.* Duplicates and reordering vanish by A5; gaplessness (A4) makes
"what is missing" exactly the interval above the prefix. **The prefix
definition is load-bearing on 𝒞w:** frames arriving 1, 2, 5 with a
high-water cursor of 5 make catch-up over (5, k] omit 3 and 4 forever —
permanent divergence with no bigserial required. A5's buffering protects
applied state, never a cursor that has already jumped (O3′ beside O3, the
same landmine class). ∎

**Theorem T6 — own-write floor and per-field monotonicity (deliberately not
Terry).** (a) **Own-write floor (on 𝒞r):** when a mutation committing at
V_mut returns, its echo has merged, so every echoed field satisfies
lastSeen(f) ≥ V_mut. The caller subsequently reads **its own write or a
causally later server value — never anything preceding its write**. (The
stronger "reads its own write" is false: a concurrent commit at V_mut+1
whose push outruns the response legitimately wins the join; the floor
property is what the product wants.) On 𝒞w no such claim holds.
(b) **Per-field monotonic reads:** T2(i). (c) **Write ordering:**
sequential submission into A1's lineage chain with the form's
optimistic-lock baseline as the read token — a property of OCC plus A1,
not of any watermark.

*Proof.* (a) Definition 1.2 + M1 (join with V_mut forces
lastSeen ≥ V_mut; a larger incumbent survives, and by A1 anything ≥ V_mut
is causally later in the lineage). (b) T2. (c) the 409 rule. **Scope:**
these are not the Terry guarantees, which are defined over session
snapshots this design does not maintain (O11 propagates this restatement).
The rendering guard — do not paint P while projFreshAt(P) < my last acked
write touching P — is the product rule and claims nothing more. ∎

**Theorem T7 — optimistic overlay (a discipline theorem).** With
rendered := compose(σ, intents), intents held outside σ (I1/I3), every
intent terminating in echo-merge or drop, and compose(σ, ∅) = σ:
rendered → σ, and σ → truth (T4, A6). The claim that a green-classified
mutation's composed prediction *equals* its eventual echo is not a
consequence of Rule M; it is an obligation on the compiled write-effect
graph (O13) — part of the trusted computing base beside write-set
completeness. Note the overlay may display values that have never existed
in S; that is its job, and it is why the Master Theorem speaks of σ, not
of rendered.

**Theorem T8 — membership.** Membership is replaced, never merged. Let tags
identify membership states and let the server-produced splice satisfy the
**application axiom**: apply(list@from, ops) = list@to (obligation O15 —
tag identity does not imply it; a unique tag around a wrong ops computation
is still wrong). Then applying a splice only on tag match yields the
server's list at *to*, and mismatch falls back to the full fetch —
self-healing with T5's shape. Tag identity comes in two grades, stated
separately: a door-scoped commit-ordered counter gives a **theorem**; a
cryptographic content hash gives a **probabilistic assumption** (collision
probability negligible, not zero). Choose one and say which (O5); a short
non-cryptographic hash gives neither and will be the first flaky 304
debugged.

**Theorem T9 — bounded, epoch-scoped leak (deliberately not
non-interference).** Frames carry a per-channel **subscription epoch**; a
RESET establishes a new epoch, and the client discards any frame whose
epoch precedes its current one. Then: (i) by A3, the content of every
*accepted* byte is in the image of D under the authorization in force for
its epoch; (ii) after the client processes the RESET for a revocation, no
frame produced under the revoked authorization is ever accepted —
including old frames delivered after the RESET, which 𝒞w permits and which
epoch filtering, not delivery order, excludes; (iii) what leaks despite
(i)–(ii) is exactly: change-existence metadata for frames *produced before
revocation*, plus everything legitimately received earlier — information
already acquired cannot be retracted, and no claim of forgetting is made.
The leak grows with frame precision (door-keyed frames refine "this id
changed" to "changed within your mask"); it never includes values outside
D's image. This is a bounded-leak statement with an explicit boundary
mechanism; upgrading it to non-interference requires the information-flow
model of O7.

## §5 Master theorem

Under A0–A3 and Rule M: every cell of the **authoritative client store σ**
is a door image of a value that existed at its lastSeen token in its
identity's lineage; deletion is a monotone floor that no delivery order can
lower or erase; the network can neither invent, regress, nor resurrect a
cell (T1–T4, L2). Under A4–A5 with a **prefix** cursor: every applied
document is a Loro join of a causally closed subset of a gapless ledger
(T5). Push is a latency optimization of pull (C1); convergence requires
fair pulls (A6). What the *screen* shows is σ composed with a draining
optimistic overlay (T7) — the overlay may show what does not yet exist,
and drains to σ. Session snapshots, Terry-complete guarantees, snapshot
isolation, cross-record envelope atomicity, and non-interference are
**not theorems of this model**.

## §6 Non-theorems

- **Session snapshots / snapshot isolation.** Refused by design; T4 is
  componentwise only.
- **Terry's four session guarantees.** Defined over snapshots; T6 offers
  the scoped substitutes.
- **Read-your-writes literally.** Only the own-write floor of T6(a): own
  write *or causally later*.
- **Cross-record atomicity of envelopes.** A2 is per-record; multi-model
  envelopes assert nothing jointly.
- **Non-interference.** T9's leak is bounded and epoch-scoped, not absent;
  received bytes are never unlearned.
- **Anything about the bus.** By C1, bus semantics are outside the
  correctness surface.

## §7 Obligation register

| id | obligation | kind |
|---|---|---|
| O1 | Transactional `save()` — A2 is false of today's code until it lands (the Tier-0 blocker). The whole stack rests here. | code (blocker) |
| O2 | Codegen-maintained token per model, satisfying A1's per-lineage chain. (No global-order claim is made or needed.) | code |
| O3 | Ledger seq = `max+1` under the advisory lock held through commit; Postgres sequences violate A4. | code (landmine) |
| O3′ | Cursor is the contiguous received prefix, never max seq observed — the client twin of O3. | code (landmine) |
| O4 | Loro trust level: (a) axiomatize and say so — the adult option; (b) boundary fuzz of import/export; (c) mechanized proof — a paper, not a task. | trust decision |
| O5 | Membership tag identity: door-scoped commit-ordered counter (theorem) or cryptographic content hash (probabilistic assumption). Choose and state which. | design ¶ |
| O7 | Information-flow model for T9, if external validation must cover the leak boundary. | design ¶ |
| O8 | TLA+/PlusCal of Rule M (floor semantics) + both lanes + prefix cursor + A2′ + epochs; check: no-regression, no-resurrection (incl. recreation), no-cursor-skip, "304 never freshens a cell the client does not hold," "304 never certifies across a lifecycle event," "no pre-epoch frame is ever accepted." ~A week, not a program; the seeded property suite remains the runtime shadow. | mechanization |
| O9 | ✅ **DONE 2026-08-27 (WS1)** — Floor semantics implemented in the store: monotone deletion floor per entry, visibility interpretation, L3 garbage collection. (Replaces rev 2's tombstone-clearing clause, whose replace-semantics was the L2 counterexample.) `packages/react/src/entity-store.ts`; L2-counterexample generators in the property suite. | code |
| O10 | A2′ server-side: per-field last_write **and lifecycle tracking** (destroy/re-create tokens), the three-way validation response (304 / gone / slice) echoing current V. | code + design |
| O11 | Restate every "session guarantees" citation in the design docs as T6's scoped claims; drop or qualify Terry. | docs |
| O12 | ⏳ **store half DONE 2026-08-27 (WS1)** — The deletion floor survives entry eviction and IndexedDB restore: a compact pk → floor map with retention dominating max in-flight + retries + restore-holding-a-GET. Landed: floors authority map (never LRU-evicted), exportFloors/importFloors (max-join; reconciles existing entries, so import-after-merge heals itself), revision-keyed floorRetention (default: keep forever; finite retention is an explicit T2 trade — 𝒞w delay is unbounded — pinned by tests incl. keep-alive through merge/signal/certify and eviction re-seeding a pruned FloorRec from the entry's render copy). Open: the actual IndexedDB persistence wiring (restore path = importFloors before first merge; no store rewrite needed). | code |
| O13 | Green-mutation prediction ≡ echo, proven against the write-effect graph — TCB, beside write-set completeness (P4). | TCB |
| O14 | A1 lineage across pk reuse: framework default is never-reused pks (serial/UUID); tables with natural keys require soft deletion or an external lineage/version source. Codegen must refuse the unhandled case. | code + design |
| O15 | Splice application correctness: server-produced ops satisfy apply(list@from, ops) = list@to — property-tested per door; tag identity does not imply it. | TCB |
| O16 | Subscription epochs carried on every frame; RESET bumps the epoch; the client drops pre-epoch frames. Protocol amendment to the frame envelope. | protocol |

---

## Revision history

**Rev 3** (this document) incorporates the second external review: rev 2's
L2 was *false* — its tombstone-replacement rule was non-commutative
({a@10}·D15·{b@20} order-dependent) and admitted resurrection through
recreation (D15·B20·A10 re-admitting a pre-delete cell); the entry is now
(floor, cells), a genuine product of join-semilattices, with deletion a
monotone floor no rule lowers (L2, L3, O9). A2′ gained the lifecycle
clause (the destroyed-record 304 was unsound). T3 is proved by cases on
lastSeen vs V, with M4's held-cells precondition explicit. T6(a) is
weakened to the own-write floor. A1 is per-lineage with pk reuse handled
(O14); the former A1b (global embedding) is deleted — no theorem used it.
A0 states the codec law L1 silently invoked; A2 now covers frames,
retiring T4's byte-identity appeal. T8 separates tag identity (counter =
theorem, crypto hash = probabilistic) from splice application correctness
(O15). T9 gains subscription epochs (O16) and distinguishes future
disclosure from already-received bytes. The Master Theorem speaks of σ;
rendered belongs to T7.

**Rev 2** incorporated the first external review: A2′ replaced an
under-specified 304 hypothesis; the doc-lane cursor became the contiguous
prefix; T6 was demoted from Terry's guarantees; the channel model was
split (𝒞w for push, 𝒞r for RPC).

**References.** Shapiro, Preguiça, Baquero, Zawirski, "Conflict-free
Replicated Data Types" (SSS 2011); Terry et al., "Session Guarantees for
Weakly Consistent Replicated Data" (PDIS 1994) — cited to scope what is
*not* claimed. Companion designs: DESIGN-ws-channels.md,
DESIGN-wire-identity.md, DESIGN-entity-store.md. A rendered copy lives at
the "The Transport Theorems" artifact.
