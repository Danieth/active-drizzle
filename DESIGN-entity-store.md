# DESIGN — The Entity Store (identity layer; one page, no doctrine)

**Status: BUILT** — `packages/react/src/entity-store.ts`, invariants attacked
by the seeded property suite in `tests/entity-store.test.tsx`.

## The split

React Query = **membership** (which pks, what order, aggregates, async
lifecycle, pagination). The entity store = **identity**: `[model, pk] →
merged record`. Index responses normalize on arrival (rows → store; the
RQ entry keeps pks + pagination + facets). One write updates every
surface. Neither layer does the other's job — that division is where
Apollo/Relay/Zero stalled (client libraries guessing at unknown backends;
we compile both ends).

## The consistency contract (the ACID/CAP answer)

Server is the single writer; per-record serialization via the optimistic
LOCK (409 + fresh envelope on stale write). Clients are read replicas.
The client-side guarantees are exactly T6 of DESIGN-transport-proof.md —
scoped claims, deliberately NOT the Terry session guarantees (O11):
**own-write floor** (T6a: after a mutation returns, every echoed field's
lastSeen ≥ that mutation's token — you read your own write *or a
causally later server value*, never anything preceding your write) and
**per-field monotonic reads** (T2i: lastSeen, floor, knownVersion never
decrease). Bounded staleness for others' writes via model-keyed
invalidation (WS frames shrink the bound later). Optimistic UI is NOT in
the consistency story — it is rendering of in-flight intent, composed at
read time.

## Invariants (each enforced by construction, each property-tested)

- **I1 single origin** — only generated response handlers call
  `merge()`; app code has no write path. Cache-corruption is
  unrepresentable.
- **I2 monotonic (per-field join — Rule M1)** — merges are token-gated
  PER FIELD: incoming payload at token V writes field f iff
  `V ≥ lastSeen(f)` (a missing cell has lastSeen = −∞), then
  `lastSeen(f) = V`; fields absent from the payload are untouched —
  absence is projection, never null. Deletion is a monotone FLOOR
  (`destroy(token)`), never a tombstone object: a cell is visible iff
  `lastSeen(f) > floor`, so no delivery order can resurrect a pre-delete
  cell (T2, DESIGN-transport-proof.md §3/L2). *This supersedes the old
  drop-whole clause, deliberately (2026-08-27, proof rev 3 / WS1)* —
  drop-whole was correct only while a
  record-level version couldn't say which fields were fresher; per-field
  monotonicity is strictly more precise and preserves I2's intent
  exactly: no field ever renders backwards (see the supersession note at
  DESIGN-wire-identity.md §3a.1). Tokens are the model's lock int
  (proof §3, WS0); `updatedAt` is inert data, never a token
  (landmine 12). No token → the named UNTRACKED lane: arrival-order
  value writes, never `current`, never 304-able, hidden once a floor
  exists — and an untracked overwrite of a TRACKED cell **demotes** it
  to untracked (its old lastSeen is deleted, not kept): a value must
  never stay paired with a token it was not read at (T4), or a stale
  arrival-order row would become 304-certifiable at a commit it never
  came from. *Migration note (supersession, stated):* the old
  drop-whole rule also guaranteed that a rendered record was a
  token-coherent snapshot; per-field joins deliberately give that up —
  a stale slice's *novel* cells land at their own (older) token, so a
  record may render cells from mixed generations (exactly the window a
  document cache always had). The store cannot see cross-field
  semantic coupling (e.g. `status`+`closedAt`); an invariant pair that
  must render from one generation belongs in one payload, and WS
  `changedFields` frames shrink the window.
- **I3 optimism never enters truth** — intents live in RQ's mutation
  cache and compose via pure `composeEntity()`. No rollback code exists,
  so no rollback bugs can.
- **I4 convergence** — rendered = truth + intents; intents always drain;
  ∴ rendered → truth. Simulation (classified @mutation bodies) only ever
  contributes intents.
- **I5 membership never guessed** — the store holds records, never
  lists. Values update instantly everywhere; membership/aggregates
  reconcile by refetch driven by derived effect sets.
- **I6 ceilings survive the merge** — the store may hold the union of
  doors' slices (same user already received them); per-door typed handles
  + canView keep components inside their own projection.
- **Eviction safety** — LRU (default 5000) never evicts pinned
  (`retain()` by live queries) or mounted (subscribed) entities.

**Known window, stated:** slice-merging can briefly compose fields from
two versions (A@v2 + B@v1) during the invalidation round-trip — exactly
the staleness a document cache has today; WS `changedFields` frames
shrink it. Not hidden: documented.

## Backend-agnostic (Daniel's non-Postgres future)

The store never sees a database: model names, opaque `string|number`
pks, opaque numeric-comparable versions. A model backed by Postgres, an
external API, or a queue merges identically.

## Wiring plan (next slices)

1. Generated queryFns call `mergeRows` / envelope handlers call `merge`;
   index queries `retain()` their pk-lists.
2. Row handles + Board/Table read through `useEntity` + `composeEntity`
   with pending patches from `useMutationState` (the optimistic slice —
   zero declarations: diffs, transition targets, simulated bodies).
3. WS frames = `merge()` calls (the store is the channel sink).

## LAW: serialization fidelity (Daniel, 2026-07-24)

Controllers can NEVER custom-serialize an EXISTING model field. The
model's Attr codecs are the ONE representation of every field, on every
door, always — this is what makes slice-merging sound (cross-door
`amount` is `amount`). Custom action payloads are their own shapes and
never normalize into the store (I1). Enforcement: no field-transform
seam exists or will be built; FIXES-NEEDED #12 (included children
bypassing child codecs) is a VIOLATION of this law and its fix is
mandatory, not optional.

## Per-record status (bare minimum, built)

`useEntityStatus(model, pk)` → `{ pending, tick, entry }`:
- `pending` — a write is in flight (store.markPending, counted/stacking,
  released only AFTER the echo merges: the own-write-floor ordering of
  T6a — once released, every echoed field's lastSeen ≥ the mutation's
  token, i.e. you read your write or a causally later server value,
  never anything earlier; deliberately not literal read-your-writes)
- `tick` — bumps on every APPLIED merge (stale drops never flash);
  effect-on-tick = the row highlight
FormSession keeps its own reality (draft/baseline) and FEEDS the store
(pending during flight, echo on settle/rehydrate) — wiring lands with
slice 1 via a `entity: { model, pk }` session option.
