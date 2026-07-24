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
LOCK (409 + fresh envelope on stale write). Clients are read replicas:
read-your-writes via echo (an intent drops only AFTER its echo merges);
bounded staleness for others' writes via model-keyed invalidation (WS
frames shrink the bound later). Optimistic UI is NOT in the consistency
story — it is rendering of in-flight intent, composed at read time.

## Invariants (each enforced by construction, each property-tested)

- **I1 single origin** — only generated response handlers call
  `merge()`; app code has no write path. Cache-corruption is
  unrepresentable.
- **I2 monotonic** — merges are version-gated (numeric tokens: lock ints
  / epoch millis; falls back to a numeric-able `updatedAt`; no version →
  arrival order, i.e. today's document-cache guarantee). A stale slice
  drops WHOLE — no field-picking, no resurrection.
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
