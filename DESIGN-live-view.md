# DESIGN — Live View (client live derivation over the store)

### Status: PROPOSED · 2026-08-27 · the client-IVM lane the transport
### program deferred (DESIGN-transport-work §2: "future lane AFTER frames
### exist"; wire-identity §7's fence applies in full). Companions:
### DESIGN-transport-proof (σ, T4, T7, I5), DESIGN-wire-identity (§3a,
### §4b), DESIGN-mutation-classification.md (the overlay grades composed
### here). Code refs verified 2026-08-27 — re-grep before trusting a line.

## 0. The goal, stated against the competition

TanStack-DB-grade DX — live queries over local collections, incremental
sub-millisecond updates, an optimistic overlay — **without Electric**.
Their architecture needs a sync engine because their client has no other
source of certified truth. Ours already has one: **the doors are the sync
source.** Every byte in the client store arrived door-projected,
token-certified, and Rule-M merged; the live-view lane adds derivation
over that store, not a second synchronization system beside it.

This is not a grudging substitution. The store WS1 built is *stronger*
input for an IVM than a synced collection: every cell carries a certified
token (per-field `lastSeen`, monotone floor), so a derived view can say
what its sources were certified at — a question TanStack DB's collections
cannot answer at all.

## 1. The mapping (theirs → ours, term by term)

| TanStack DB concept | this system | delta |
|---|---|---|
| immutable synced collections | the Rule M store σ (`packages/react/src/entity-store.ts` — WS1) | ours carries per-cell certified tokens (per-field lastSeen, deletion floor, knownVersion); theirs has object identity only |
| optimistic overlay / transactions | T7's `compose(σ, intents)` — `composeEntity` (`entity-store.ts:809`), VERBATIM | overlay never enters σ (I3), drains on echo-merge or drop; identical discipline, already landed and proof-anchored |
| live queries (d2ts differential dataflow) | d2ts consuming the store's change feed: microtask-coalesced notifications (`entity-store.ts:248` — the dirty set) + per-field `fieldTicks` (kind-aware equality, no spurious ticks) | WS1 built exactly the change-feed an IVM wants — coalesced, per-key, field-granular — before this lane existed to consume it |
| load normalized, denormalize through queries | WS2's columnar envelope (`packages/react/src/wire-envelope.ts` — the ONE decoder) + client-side joins | their loading doctrine is our landed wire; `projectRow`/`recomposeRow` are the hand-rolled joins d2ts generalizes |

The lane, in one sentence: replace the hand-maintained recompose in
`useProjectedRows` with a general differential-dataflow layer fed by the
same subscriptions, holding the same invariants.

## 2. The line we hold that they don't

**DERIVED COLLECTIONS ARE PRESENTATION; MEMBERSHIP IS AUTHORITY (I5).**

A d2ts join/filter/aggregate over σ answers exactly one question: *"what
do I know locally?"* That answer is sound — every input cell is
componentwise a true past value (T4) — and it is honest presentation:
group the held rows, count the held rows, join the held rows.

A filtered, ordered page is a DIFFERENT kind of statement: a claim about
the database — "these are the open invoices, in this order." That claim
is server-computed, structure-ETag'd (WS3's membership lane:
`membership.structureToken` + the door-scoped counter tag,
`packages/controller/src/membership-tags.ts`), and replaced, never merged
(T8; proof kernel: "identity merges; membership is replaced").

The rule, absolute: **never patch server membership from local
derivation.** A locally-derived row matching a list's predicate is not
license to insert its pk into that list — the door's scope, the page
boundary, and the order are facts the client cannot compute (its `where`
runs over a projection of a moving database). This is where TanStack DB
and every sync engine draw the line differently — their local collection
is presumed complete within its shape, so local queries ARE the truth.
Our doors are projections under authorization; local completeness is
never total, so local derivation is presentation, full stop.

What a live view MAY do with membership: consume it. A server pk-list is
a legitimate d2ts input (as data, tagged by its query identity); joining
membership × identity locally is exactly what `useProjectedRows` does
today and is the intended common case.

## 3. API sketch and subscription mechanics

Shape (name bikesheddable, contract not):

```ts
// compiled over door-typed handles — the view can only mention fields
// some door already granted this session (A3 is not renegotiated here)
const view = defineLiveView((q) =>
  q.from(invoicesDoor)                       // identity source: σ, masked
   .join(loansDoor, (i, l) => i.loanId === l.id)
   .where((i) => i.status === 'open')        // PRESENTATION filter (§2)
   .orderBy((i) => i.dueAt))

function InvoiceBoard() {
  const rows = useLiveView(view)             // useSyncExternalStore, live
  ...
}
```

Mechanics, pipelined:

1. **Inputs.** Each (table, pk) the view touches is a d2ts input; rows
   enter as multiset deltas. Sources are door-masked visible cells, never
   raw entries (§4.1).
2. **Change feed.** Store notify fires per key, coalesced per microtask
   (the dirty set). On notify: diff the entry's visible projection
   against the last-fed value (fieldTicks say *whether* a field moved;
   the retract-old/insert-new delta comes from the snapshot diff) and
   feed one d2ts batch per flush. One store flush = one dataflow step =
   one render — the coalescing alignment is the sub-ms budget.
3. **Self-rewiring dependencies.** A recompute discovers new (table, pk)
   deps (a join reached a new child); subscriptions re-wire to match,
   and unsubscribed keys are released — the exact discipline
   `useProjectedRows` already implements (`wire-envelope.ts:380-435`).
4. **Subscriptions double as eviction pins** — the store never evicts a
   subscribed key (WS2's precedent). A live view pins its working set by
   construction (§4.3).
5. **Output.** The view's output collection feeds
   `useSyncExternalStore`; overlay composition happens HERE, on the
   output rows (§4.2), so pending intents render without ever entering
   the dataflow.

Freshness accounting (the strength §0 claimed): each output row can carry
`min lastSeen` over its source cells — projFreshAt generalized through
the dataflow (`entity-store.ts:153`). Surfaces may render it ("as of
token N"); nothing may treat it as a server certification of the derived
SHAPE — certification is per-cell (T4), and no theorem lifts it through a
join.

## 4. Landmines (each one is a T-theorem violated if ignored)

1. **Derived views read only VISIBLE cells.** Inputs come from
   `visibleFields`/`isGone` (`entity-store.ts:136,166`) — never raw
   `entry.fields`. A cell under the deletion floor is dead; feeding it to
   the dataflow resurrects a deleted row in every downstream join —
   T2(ii) violated at the presentation layer after the store got it
   right. Floor rises ⇒ retraction delta, same as any change.
2. **The optimistic overlay composes at the VIEW layer, never written
   into d2ts inputs as truth.** Intents stay outside σ (I3, T7); if a
   pending patch enters the dataflow as an input delta, the drain
   becomes a retraction storm, and — worse — optimistic values flow into
   derived aggregates rendered as truth. Compose over OUTPUT rows;
   grades from DESIGN-mutation-classification decide the marking (yellow
   = pending badge; green = unmarked), the plumbing is identical.
3. **Eviction pins are load-bearing, not a nicety.** An LRU eviction
   under a live view is a phantom retraction — a row vanishes from a
   list because memory pressure, not truth, removed it. The
   subscription-pin rule (§3.4) makes this unrepresentable; any future
   store eviction change must keep it.
4. **The untracked lane degrades, and must say so.** Models without a
   lock column merge arrival-order (`v: null` — WS2's untracked lane):
   no per-field tokens, no floor from destroy echoes. Views over
   untracked models are best-effort presentation; freshness accounting
   (§3) is undefined there and must render as such, not as token 0.
5. **Membership staleness is not view staleness.** A live view joining
   a server pk-list stays "live" only in its VALUES; the pk-list
   refreshes by the WS3 machinery (signal → structure-token-guarded
   refetch), not by local inference. Rendering a locally-derived "this
   row would match" hint beside stale membership is permitted UI;
   splicing it in is landmine, per §2.

## 5. Non-claims

- **No offline queue.** Absence of network stalls pulls; the view keeps
  rendering σ (valid stale state, T4). Nothing queues writes.
- **No cross-collection transactions.** A dataflow step is not a
  snapshot: two views over the same flush may observe cells at different
  tokens (T4 is componentwise; the remark under it applies verbatim).
- **No local-first authority.** σ is a cache of D(S); derivation over a
  cache is still a cache. A different algebra (CRDT-as-SoT, local-first)
  is a **different peak, not a larger version of this one** (proof
  kernel).
- **No live-query membership push, no mergebox, no client-side `where`
  promoted to membership** — wire-identity §7's fence, unmoved. This
  lane lives entirely on the presentation side of it.
- **No new wire surface.** The lane consumes WS1's store, WS2's
  envelope, WS3's validation, WS4's frames. If a design sketch here
  seems to need a new endpoint, it has crossed §2's line.

## 6. External facts relied on (as-of dates; recheck before vendoring)

- TanStack DB (2025–2026): live queries built on **d2ts** — differential
  dataflow in TypeScript, ElectricSQL lineage, vendored into the project
  as its IVM engine; collections + transactions architecture per its
  docs. Verified against knowledge as of 2026-08; re-verify version and
  license at adoption time.
- d2ts itself is small and vendorable — the same posture as
  loro-prosemirror in WS5 (vendor + fuzz), and the same reason: the
  engine is trusted-kernel-shaped (deltas in, consistent collections
  out), so O4's trust-level menu applies to it by analogy (axiomatize /
  fuzz / prove).
- Electric is NOT a dependency of this lane at any tier — the point of
  §0.

## 7. Sequencing and acceptance

Position: after WS4 (frames give the store a push-fed change feed worth
deriving over; until then a live view is just a prettier refetch), consuming
WS1–WS3 as landed. No workstream number claimed here — this doc is the
design gate the work doc's §2 row points at.

Acceptance, minimum:

- **C1 witnessed:** a two-table joined live view converges across two
  clients with the bus DISABLED (pull-only), same bar as WS4/WS5 demos.
- **Floor test:** destroy at D reaching the store by any of the six
  L2-counterexample orders removes the row from every live view exactly
  once, no resurrection through any join path (§4.1).
- **Drain test:** an optimistic intent renders through a view's output,
  then 409s; the view returns to σ-derived output with zero residue
  (§4.2, T7).
- **Pin test:** a mounted view's working set survives forced LRU
  pressure (§4.3).
- **Perf bar:** one store flush of N changed cells updates a mounted
  view in O(affected rows), not O(collection) — the reason d2ts is here
  at all; measured and recorded like WS2's payload finding.

## 8. Relation to the other documents

- **DESIGN-transport-proof.md** — σ and Rule M (the input contract), T4
  (why local derivation is sound), T7 (the overlay), I5 via
  DESIGN-entity-store (membership never guessed), the kernel (different
  peaks).
- **DESIGN-transport-work.md** — §2 "Client live derivation" row (this
  doc is that row's design); WS1/WS2 seams cited throughout; WS4 as the
  sequencing gate.
- **DESIGN-wire-identity.md** — §3a (the store/view split this lane
  generalizes), §4b (the collaborative lane feeding the change feed),
  §7 (the fence).
- **DESIGN-mutation-classification.md** — the grades composed at this
  lane's view layer; the two docs meet at T7 and must not drift: overlay
  composition is specified THERE, consumed HERE.
