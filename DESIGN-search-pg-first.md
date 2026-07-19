# Search: PG-first, badass as fuck — and the seam that keeps ES honest
### Design doc · session 10 · 2026-07-19 · status: RECOMMENDATION
### Refines the esindex section of DESIGN-index-filters-esindex.md

## 0. The verdict up front

**Daniel's lean is right. Ship PG-backed search and make it excellent.
Do NOT build the ES pipeline now.** But make three architectural cuts
today — they cost almost nothing and they're the difference between "we
can add ES later cleanly" and "adding ES is a rewrite."

The reasoning is one sentence: search has THREE separable concerns that
every bad implementation welds together —

1. **The search document** — what shape is matchable (the
   "transmogrification").
2. **The sync transport** — how model changes reach the index.
3. **The query engine** — who answers the query (PG or ES).

The nightmare lives almost entirely in **#2**. The product value lives
almost entirely in **#1 and #3's ranking**. PG-first lets you have the
value while making #2 LITERALLY DISAPPEAR — that's the whole argument.

---

## 1. Why PG-first isn't a compromise (the "cheaper than you think" part)

The majority case, in Daniel's own words: *"a postgres thingie,
transmogrified, into the index"* + *"making these items easier to find."*
Postgres natively does everything that use case needs:

- **`tsvector` + GIN** — real full-text: stemming, weighting (name > body),
  `ts_rank` relevance ordering, websearch-style query parsing
  (`websearch_to_tsquery` — quoted phrases, `-negation`, OR).
- **`pg_trgm`** — fuzzy/typo/substring matching and fast `ILIKE '%…%'`,
  the thing everyone THINKS they need ES for.
- **GENERATED columns** — and this is the killer:

  ```sql
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(body,'')), 'B')
  ) STORED
  ```

  The index updates **in the same row write, in the same transaction**.
  Sync transport (#2) doesn't exist. No callbacks, no queue, no drift, no
  reindex task, no "ES is down" branch, no eventual consistency. Zero
  moving parts is not a lesser version of the pipeline — it is the
  pipeline, solved, for the PG engine.
- **Facet counts** — `GROUP BY` / filtered aggregates. Fine at demo/mid
  scale; declared per-filter opt-in so the cost is visible.

What ES genuinely adds over this: cross-field relevance tuning at scale,
huge-corpus performance, aggregations at volume, "did you mean",
language-aware analyzers per field. **None of those are "easier to find"
problems at the scale where ActiveDrizzle apps start.** Searchkick's own
ecosystem lesson: half its users needed pg_search and adopted an ES
cluster's operational burden for `ILIKE` with ranking.

### What "badass as fuck" concretely means for the PG engine

Declared on the controller (extending the already-designed index surface):

```ts
index: {
  search: {
    fields: { name: 'A', contactEmail: 'B', 'company.name': 'B' },  // weights
    trigram: ['name'],          // typo tolerance on these
    highlight: true,            // ts_headline snippets in the response
  },
}
```

Codegen emits the migration snippet for the generated column + GIN index
(the schema stays the user's file — we print what to paste, we don't
mutate their schema). `?q=` upgrades from bare ilike to: websearch query →
tsquery match ∪ trigram similarity → rank-ordered, highlighted. The
`<Loans.Search/>` box and every filter component from the index-surface
design work unchanged. Relevance sort appears in `sortable` as
`'relevance'` when search is declared.

That's a competitive search experience with **zero infrastructure** and
zero of concern #2.

---

## 2. The searchkick lessons (studied, not idolized)

What searchkick got RIGHT — steal these:
- **`search_data` is just a method returning a hash.** The transmogrify
  "DSL" is not a DSL — it's a function. Arbitrary derivation, relations,
  computed fields, all expressible, nothing to invent. (See §3.)
- **Zero-downtime reindex via index aliases** — build `loans_v2`, swap the
  alias, drop v1. When we do ES, this is table stakes.
- **`should_index?`** — a predicate for partial indexes.

What searchkick got WRONG — the nightmare fuel to refuse:
- **Inline `after_commit` HTTP to ES as the default.** Couples every
  model write's latency and failure mode to a search cluster. Lost
  updates on crash. This is THE pattern that does not scale, and it's
  the default thousands of apps shipped.
- Its async modes bolt queues on afterward, each with its own
  consistency story — because the transport wasn't a first-class seam.
- Reindex-the-world as the recovery story for drift.

Rule extracted for ActiveDrizzle, permanent: **the framework NEVER ships
inline synchronous index-write-on-save as the ES transport.** Not as
default, not as option. See §4 for the one transport we ever bless.

---

## 3. The transmogrification, defused

Daniel's fear: the "shove this derived variant of the model into ES" DSL
either becomes the greatest thing ever or a nightmare. The nightmare
scenario is specifically **bidirectional mapping** — if the derived shape
must invert back to the model, you've built a second ORM.

**It never inverts. Cut that head off now.** The locked door principle
already decided this: the engine returns **ranked ids only**, hydration
re-enters the scoped relation + expose ceiling. Therefore:

> The search document is a **one-way, lossy projection whose only
> load-bearing field is `id`.** Everything else exists purely to be
> matched and faceted against. "Inverting back to the model" is
> `WHERE id IN (...)` — already built, already governed.

So the eventual declaration is just searchkick's good idea, typed:

```ts
static searchDoc = (loan: Loan) => ({
  name: loan.name,
  amount: loan.amount,
  companyName: loan.company?.name,     // denormalized relation — fine, it's lossy
  ownerIds: loan.coOwnerIds,           // habtm flattened — fine
  big: loan.amount > BIG,              // derived — fine
})
```

No inversion contract, no auto-include magic to design, no "generated
type with a way back." A function, a hash, an id. If a field isn't in the
doc you can't match on it; the row you get back is always the real model
through the real door. **This is the part of the eventual ES story that
CANNOT become a nightmare, because we've removed the surface the
nightmare grows on.**

(For the PG engine, `searchDoc` isn't even needed — the generated column
IS the projection. `searchDoc` only comes to life with an external
engine.)

---

## 4. The one scaling primitive we ever bless: the outbox

When ES (or anything external) eventually arrives, the transport question
returns. Daniel's instinct — "delta table, or pipe changes to Kafka" — is
the correct family. The framework blesses exactly ONE pattern:

**Transactional outbox.** `search_outbox(id, table, record_id, op, at)` —
written in the SAME transaction as the model write (afterCommit enqueue is
the degraded fallback; same-tx is the real thing). Then:

- small deployments: a polling drainer ships rows to ES, deletes on ack;
- big deployments: Debezium/Kafka eats the outbox (or replaces it with
  CDC on the tables themselves) — the framework doesn't care, because
  the contract is "deltas appear in a table," which every scale of
  infrastructure can consume;
- recovery from anything: replay the outbox / reindex from PG, which
  remains the source of truth forever.

**Ownership boundary (Daniel's call, and it's right): the outbox is NOT
an ActiveDrizzle module — not now, not later.** The framework's whole
obligation is to not PREVENT one, and it already satisfies it: same-
transaction writes (`transaction()` / `@transactional`) and `afterCommit`
hooks are the only two hook points an outbox needs, and both exist. The
outbox itself is app code (~a 30-line concern) or someone's infra; the
framework ships a documented RECIPE, never the pipe. Proof this is the
right boundary: the best at-scale transport — WAL-based CDC (Debezium
reading the replication log) — needs literally ZERO framework support.
When the endgame requires nothing from you, owning the midgame is pure
liability. So even the eventual `@active-drizzle/search-es` package gets
an engine (query side) and a reindex-from-PG task, but no transport — it
CONSUMES "deltas arrive somehow," documented shapes: outbox recipe,
afterCommit enqueue (small apps), or CDC (real scale).

---

## 5. What we actually commit to now (the three cheap cuts)

1. **`SearchEngine` interface in the index surface** (already in the
   other doc): `search(req) → { ids, total, facets? }`. The PG engine is
   the first and only implementation. ES later = new implementation, zero
   API change, client never knows.
2. **`searchDoc` reserved as a one-way projection function** — documented
   now, consumed only by future external engines. No inversion, ever.
3. **Transport doctrine, not a transport module** — the framework never
   ships inline index-on-save AND never ships the pipe. The outbox is the
   documented recipe (built on the existing transaction + afterCommit
   hook points); CDC is the documented scale path (needs nothing from
   us). ActiveDrizzle's obligation is only to keep those hook points
   stable.

And then: **build the PG engine to be genuinely excellent** (weighted
tsvector + trigram + websearch parsing + highlight + relevance sort +
opt-in SQL facets), riding the index-surface phases already planned.

## 6. What we explicitly do NOT do

- No ES cluster, client, mappings codegen, or sync worker now.
- No inline index-on-save transport, ever.
- No bidirectional search-document mapping, ever.
- No silent facet counts (opt-in, cost visible).
- No framework assumption that prevents Kafka/CDC at scale — the outbox
  contract is deliberately consumable by both a 20-line poller and a
  Debezium pipeline.

**Bottom line:** PG-first isn't the cautious choice — it's the choice
that deletes the entire risk class (#2) while shipping all the product
value ("easier to find") — and the three cuts above mean ES, when its
day genuinely comes, is an adapter, not an event.
