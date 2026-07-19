# Advanced Queries

Grouped aggregation, window functions, `DISTINCT ON`, keyset pagination, set operations, and full-text search — the Postgres power tools, surfaced as chainable `Relation` methods that still return typed models or typed rows.

Everything on this page composes with the normal builder (`where`, `order`, scopes, `includes`).

## Grouped aggregation

`.group(...)` turns the aggregate terminals (`count` / `sum` / `average` / `minimum` / `maximum`) into `{ groupKey → value }` maps — Rails' `Order.group(:status).sum(:total)`.

```ts
await Order.all().group('status').count()
// → { pending: 3, confirmed: 1, shipped: 1 }

await Order.all().group('userId').sum('total')
// → { '1': 3000, '2': 1200, '3': 3000 }
```

Group keys run through the column's `Attr.get`, so an `Attr.enum` column groups by **label** (`pending`), not the stored integer.

::: tip Return type
Ungrouped, these return a scalar (`Promise<number>`). With `.group(...)` they return a map at runtime — a deliberate Rails-style overload. TypeScript still declares the scalar, so cast when grouping:
```ts
const byStatus = await Order.all().group('status').count() as unknown as Record<string, number>
```
:::

### `having(condition)`

Filter the groups themselves. Takes a raw drizzle `sql` condition.

```ts
import { sql } from 'drizzle-orm'

await Order.all().group('userId').having(sql`count(*) > 1`).count()
// → { '1': 2, '2': 2 }   — users with more than one order
```

## Many metrics, one round-trip — `aggregate()`

Firing several aggregates concurrently costs several round-trips. `.aggregate()` computes them all in a **single** `SELECT`.

```ts
const { orders, revenue, avg } = await Order.where({ status: 'paid' }).aggregate(a => ({
  orders:  a.count(),
  revenue: a.sum('total'),
  avg:     a.average('total'),
}))
// → one query: SELECT count(*), coalesce(sum(…),0), avg(…) FROM orders WHERE …
```

It composes with `.group()` — a whole dashboard in one query:

```ts
await Order.all().group('status').aggregate(a => ({ n: a.count(), rev: a.sum('total') }))
// → { pending:   { n: 3, rev: 2200 },
//     confirmed: { n: 1, rev: 2000 },
//     shipped:   { n: 1, rev: 3000 } }
```

Builder methods: `a.count()`, `a.sum(field)`, `a.average(field)`, `a.minimum(field)`, `a.maximum(field)`.

## `DISTINCT` and `DISTINCT ON`

```ts
await Product.all().distinct().load()          // SELECT DISTINCT
```

With a column, you get Postgres' `DISTINCT ON` — **one row per group**. Pair it with an order whose leading column matches:

```ts
// the highest-total order per user, in a single query
await Order.all()
  .distinct('userId')
  .order('userId').order('totalInCents', 'desc')
  .load()
```

::: warning Ordering rule
Postgres requires the leading `ORDER BY` expressions to match the `DISTINCT ON` columns. `.order('userId')` must come first.
:::

## Window functions — `select((t, Fn) => …)`

`.select()` projects arbitrary expressions and returns **plain typed rows** (not model instances). The callback receives the drizzle table (real columns) and `Fn`, the window helpers.

```ts
import { desc } from 'drizzle-orm'

// rank products by price *within* their type
const rows = await Product.all().select((t, Fn) => ({
  name: t.name,
  rank: Fn.rank().over({ partitionBy: t.type, orderBy: desc(t.priceInCents) }),
}))
// → [{ name: 'B', rank: 1 }, { name: 'A', rank: 2 }, { name: 'C', rank: 1 }]
```

Available on `Fn`, each followed by `.over({ partitionBy?, orderBy? })`:

| Helper | SQL |
|---|---|
| `Fn.rowNumber()` `Fn.rank()` `Fn.denseRank()` `Fn.ntile(n)` | ranking / bucketing |
| `Fn.sum(col)` `Fn.avg(col)` `Fn.min(col)` `Fn.max(col)` `Fn.count(col?)` | running totals & moving windows |
| `Fn.lag(col, n?)` `Fn.lead(col, n?)` | compare a row to the previous / next |
| `Fn.firstValue(col)` `Fn.lastValue(col)` | first / last in the window |

`partitionBy` and `orderBy` accept a column, a drizzle expression like `desc(col)`, or an array of either.

```ts
// running revenue total per user, oldest → newest
await Order.all().select((t, Fn) => ({
  id:      t.id,
  running: Fn.sum(t.totalInCents).over({ partitionBy: t.userId, orderBy: t.createdAt }),
}))
```

## Keyset (cursor) pagination — `seek()`

`OFFSET` scans and discards everything it skips, so deep pages get slower and slower. `.seek()` uses a row-value comparison instead — the same cost on page 1 and page 1,000.

```ts
const page1 = await Order.all().seek(['id']).limit(20).load()

const page2 = await Order.all()
  .seek(['id'], { after: { id: page1.at(-1)!.id } })
  .limit(20)
  .load()
```

- `fields` are ordered and also become the `ORDER BY`.
- `after` values run through `Attr.set`, so model-space values (money, enum labels) work.
- `dir: 'desc'` pages backwards. All seek fields share one direction.

Use a tiebreaker (a unique column like `id`) as the last field so the ordering is total:

```ts
.seek(['createdAt', 'id'], { after: { createdAt: last.createdAt, id: last.id } })
```

## Set operations

Combine two relations on the same table; results come back as **model instances**.

```ts
await Order.where({ userId: 1 }).union(Order.where({ userId: 3 }))   // → Order[]
```

Also: `.unionAll(other)`, `.intersect(other)`, `.except(other)`. Any `.order()` / `.limit()` on the receiver applies to the combined result.

## Search

### `search(term, fields)` — simple ILIKE
Case-insensitive substring match ORed across columns. The term is escaped, so user input is safe to pass straight through; a blank term is a no-op.

```ts
await User.all().search('ada', ['name', 'email']).load()
// WHERE (name ILIKE '%ada%' OR email ILIKE '%ada%')
```

### `ftsSearch(term, fields)` — weighted full-text
Postgres full-text search with per-column weights (`'A'` highest → `'D'` lowest).

```ts
await Article.all()
  .ftsSearch('postgres tuning', { title: 'A', body: 'B' })
  .orderByRelevance()
  .load()
```

`orderByRelevance()` orders by the full-text `ts_rank` computed by the preceding `ftsSearch`.

### `whereAny(branches)` — OR across hashes

```ts
await Order.all().whereAny([{ status: 'pending' }, { userId: 7 }]).load()
// WHERE (status = 0) OR (user_id = 7)
```

### `orderByIds(ids)` — preserve an explicit order
Returns rows in exactly the order of the ids you pass (handy after a search engine hands you a ranked id list).

```ts
await Product.where({ id: rankedIds }).orderByIds(rankedIds).load()
```

## Inspecting the SQL — `toSQL()`

Compile the current query **without running it**.

```ts
Order.where({ userId: 1 }).toSQL()
// → { sql: 'select ... where "orders"."user_id" = $1', params: [1] }

Order.all().distinct('userId').toSQL().sql   // contains 'distinct on'
```

## Escape hatch

Anything not surfaced here is still reachable with a raw drizzle expression — `where()` accepts `sql` directly, and `.select()` / `.having()` take arbitrary expressions:

```ts
import { sql } from 'drizzle-orm'

await Order.all().where(sql`extract(year from placed_at) = 2026`).load()
```
