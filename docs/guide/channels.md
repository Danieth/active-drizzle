# Live Channels (WebSocket)

Channels push live `CHANGE` frames — door-projected partial records — to
connected clients over one WebSocket per browser tab. This page is the
operator's manual: every config field, the boot sequence, the bus tiers,
and what to watch in production.

**The one doctrine you need before touching anything below:** push is a
latency optimization, **pull is correctness**. Delivery is best-effort by
design — there is no outbox, no delivery guarantee, no replay log. A lost
frame is harmless because every client revalidates through the same HTTP
door on reconnect, on tab focus, and on subscribe (the cursor dry-run).
If the socket layer is completely down, the app still works; it is just
not live. Operate it accordingly: you are running a latency feature, not
a source of truth.

## What ships frames (and what doesn't)

Only doors built with `wire: 'columnar'` have channels. A `SUB` to any
other door is refused with `BAD_CHANNEL`. Frames obey the **silence
rule**: a commit whose changed columns don't intersect the door's
`expose` mask publishes nothing for that door — projection is enforced at
emit time, not just at read time.

## ChannelsConfig — every field

All fields live under `channels:` in `trails.config.ts`. Every field is
optional; an absent `channels:` block entirely still boots channels with
all defaults (memory bus, `/cable`).

| Field | Default | Unset means | Notes |
|---|---|---|---|
| `bus` | `'memory'` | Single-process fan-out, zero infrastructure | `'redis'` is **the** multi-process tier (Redis pub/sub over `redisUrl`, at-most-once by design). `'pg-notify'` is the opt-in multi-process fallback. `'nats'` is a **typed stub that throws at boot** with instructions — do not set it expecting it to work. |
| `redisUrl` | `undefined` | — | `redis://` or `rediss://` url for `bus: 'redis'` (required with it — boot refuses otherwise). TLS, auth, and db index all ride the url. Reference it from the environment: `redisUrl: process.env.REDIS_URL`. |
| `path` | `'/cable'` | WS upgrades handled at `/cable`; token mint at `/cable/token` | Change it if `/cable` collides with a route. |
| `originAllowlist` | `undefined` | Dev: only `localhost` / `127.0.0.1` / `::1` origins may connect. **Production: boot refuses to serve** | The upgrade request rides ambient cookies; the Origin check is the only thing stopping any site the user visits from opening an authenticated socket (cross-site WebSocket hijacking). Non-browser clients (no Origin header) pass this gate — the token still gates them. |
| `heartbeatMs` | `25000` | 25s protocol-level ws pings | Values > 55000 print a boot warning: they outlive common proxy idle timeouts. See [Heartbeats vs proxies](#heartbeats-vs-proxy-idle-timeouts). |
| `coalesceMs` | `25` | 25ms per-subscription coalescing window | Clamped to 20–50 regardless of what you set. Same-pk commits inside the window supersede (newer token wins); multi-row batches share one frame. |
| `revalidate` | `30` | Door pass cached 30s per subscription — **both lanes** (record subs reload through the door; index subs re-run the index dry-run) | `'always'` disables the cache (every emit re-checks through the door). See [Revocation](#revocation--reset). |
| `role` | `'serve'` | This process holds sockets | `'publish-only'` is for a dedicated-channels topology (API processes publish, a channels fleet serves). `'publish-only'` + `bus: 'memory'` throws at boot — an in-memory bus never leaves the process, so a publish-only process would publish to nowhere. |
| `tokenTtlMs` | `10000` | Upgrade tokens live 10s | Single-use regardless of TTL. The token map is **in-memory**: mint and upgrade must hit the **same process** — behind a load balancer you need sticky sessions until a shared token store ships. |
| `maxConnections` | `10000` | Upgrades beyond the cap are refused **503** (per process) | A capacity bound, not auth — the client's token is checked *after* the cap, so a refused client retries with the same token. |
| `maxSubsPerConnection` | `256` | The 257th live SUB on one socket is refused **`SUB_LIMIT`** | Also the SUB **rate-limiter's burst size**: every SUB dry-runs a real door query, so sustained SUB flooding beyond ~20/s answers **`RATE_LIMITED`** (a reconnect's re-SUB-everything burst always fits). Client→server frames are additionally capped at **64KB** (`ws` `maxPayload`) — control frames are tiny, and `CHANGE` is server→client only. |

Environment overrides work like everything else in `trails.config.ts` —
deep-merged by `NODE_ENV`:

```ts
export default defineConfig({
  channels: { bus: 'memory' },
  environments: {
    production: {
      channels: {
        originAllowlist: ['https://app.example.com'],
        revalidate: 'always',        // the paranoid tier — see Revocation
      },
    },
  },
})
```

### Boot-time refusals (by design)

`assertChannelsServable` throws — never warns — on configurations that
would run silently broken:

- **Production + `role: 'serve'` + no `originAllowlist`** → boot refuses.
  List your app origins.
- **`role: 'publish-only'` + `bus: 'memory'`** → boot refuses. Frames
  would go nowhere.
- **`bus: 'redis'` + no `redisUrl`** → boot refuses. The bus dials two
  dedicated connections from that url (Redis command-restricts a
  subscribing connection, so publisher and subscriber cannot share one).
- **`heartbeatMs > 55000`** → warning (not a refusal): idle sockets will
  be severed by infrastructure between heartbeats.
- **`bus: 'nats'`** → the stub constructor throws with the interface
  contract and the working alternatives.

## The boot sequence

The scaffold from `trails new` wires everything; an app author enables
channels by **doing nothing** — they are on by default. This is the
entire wiring, so you know what exists when you debug it:

```ts
// server/main.ts (scaffolded — you already have this)
const server = serve({ fetch: app.fetch, port })          // node:http server
const channels = await attachChannels(server as any, {
  routers: [posts],          // buildRouter() results — the doors
  config,                    // loadConfig() result
})
app.post(`${channels.path}/token`,
  (c) => c.json({ token: channels.mintToken(contextFor(c)) }))
```

What `attachChannels` does, in order:

1. Resolves `config.channels` defaults and runs the boot refusals above.
2. Creates the bus (`memory` instantly; `redis` dials its connection
   pair and runs a loopback probe; `pg-notify` connects its dedicated
   session and runs the self-NOTIFY probe — boot **fails** if a probe
   hears nothing, see below).
3. Starts the emitter: every committed write (save, destroy, `insertAll`,
   `updateAll`, counter caches), after its transaction commits, is routed
   onto bus channels per door, silence rule applied.
4. Mounts a WebSocket upgrade handler **on the same HTTP server** at
   `channels.path`. No second port, no second process.
5. Starts the heartbeat timer.

The connect flow a client walks (the generated client does all of this):

1. `POST {path}/token` over the app's normal authed HTTP →
   `{ token }`. Your existing auth **is** the socket's identity — the
   context builder used for `/rpc` and for `mintToken` must be the same
   function (the scaffold shares one `contextFor`).
2. Dial `ws://host{path}?token=…`. The upgrade is gated by Origin
   allowlist first, then the token — which is deleted on first look
   (single-use, even when expired). 403 = origin, 401 = token.
3. Each `SUB` dry-runs the door's own procedures (`validate` / `get` /
   `index`) with the connection's context. `scope`, `scopeBy`, and
   permission hooks all run — **there is no second permission system**.

A query-string token is acceptable here, exceptionally, because browsers
cannot set headers on a WS upgrade and the token is single-use with a
~10s TTL. Long-lived credentials still never belong in query strings.

### Minimum diff from `trails new` to live channels

None. The scaffold boots with channels attached on the memory bus.
For production you must add the origin allowlist (boot enforces this):

```diff
 export default defineConfig({
   server: { port: 8787 },
   database: { url: process.env.DATABASE_URL },
+  channels: {},
   environments: {
-    production: {},
+    production: {
+      channels: { originAllowlist: ['https://app.example.com'] },
+    },
   },
 })
```

## Bus tiers

The bus carries **ids-only commit events** (table, pk, version token, op,
changed keys) — never serialized frames, never row values. Frames are
built per-subscriber, on the serving node, through the subscriber's own
door. This one payload shape serves every tier.

### `memory` (default, tier 0)

Same-process pub/sub. **Single-node semantics, stated plainly: if you run
two API processes on the memory bus, a write handled by process A is
never pushed to a socket held by process B.** The client on B is not
broken — it heals on its next revalidation pull — it is just not live for
that write. The memory bus also carries the live record instance with
each event, so frames are built with zero reloads (fast path).

Use it: one process, or a dev/staging box, or any deployment where
"live within one process, eventually-fresh across processes" is fine.

### `pg-notify` (tier 1) — the opt-in multi-process fallback

Postgres `LISTEN`/`NOTIFY` as the cross-process wire. Deliberately
**opt-in, never a silent default**, because NOTIFY has real operational
teeth:

- **When to use it:** a handful of processes, moderate write volume, and
  you don't want to run Redis. It is a fallback, not the scaling tier —
  `redis` is.
- **Ids-only, batched, chunked:** events are packed for ~10ms into one
  NOTIFY payload, chunked under 7.5KB of UTF-8 (the hard payload cap is
  ~8000 bytes). A single event that alone exceeds the cap (an enormous
  changed-column set) is dropped from the wire with a loud log — local
  delivery already happened, remote nodes heal via pull. Local
  subscribers are served directly first — the wire is only for other
  processes, and self-published batches are dropped on receipt
  (origin-id dedupe).
- **The LISTEN session self-heals:** if the dedicated session drops (PG
  restart, idle kill, network blip), the adapter reconnects with backoff
  and re-LISTENs — a node is never left permanently deaf while its own
  sockets look healthy. The PgBouncer probe runs at **boot only**; a
  mid-life blip is not re-diagnosed as misconfiguration. While the
  session is down, wire copies are **dropped loudly** (throttled to a
  counted summary during a storm), never queued for the outage's
  duration and never shipped stale after reconnect — the same gap
  convention as the redis tier: local delivery already happened, remote
  nodes heal via pull.
- **PgBouncer: SESSION mode required.** `LISTEN` registers on a server
  session; transaction pooling hands every statement a different session,
  so notifications are delivered to a session nobody holds — *silently*.
  The adapter opens its own dedicated `pg` client from `database.url`
  (never the app pool) and runs a **self-NOTIFY probe at boot**: it must
  hear its own notification within 5s or boot fails with a teaching
  error. `pool_mode` is not queryable from an ordinary connection — the
  probe is the only honest detector. Point channels at a direct database
  URL or a session-mode pool.
- **The saturation signal:** NOTIFY serializes commits through a global
  lock. When this tier is overloaded, Postgres logs and `pg_locks` show
  waits on **`class 1262 … database 0`** (the database-object lock NOTIFY
  takes on database id 0). If you see those waits, this tier is
  saturated and is now slowing your *commits*, not just your pushes —
  move off it.
- Requires `npm install pg` (a teaching error at boot says so if absent).

### `redis` (tier 2) — THE multi-process tier

Redis pub/sub as the cross-process wire — no global commit lock, no
payload cap, no pooler landmine. Same payload law as every tier: ids-only
commit events on one broadcast channel, batched ~10ms per PUBLISH,
self-published batches dropped on receipt (origin-id dedupe), local
subscribers served directly with the record instance intact.

- **At-most-once is the contract, not a caveat.** Redis pub/sub has no
  replay, and this design *wants* none: push is latency, pull is
  correctness (C1) — the client's revalidation pull already **is** the
  replay mechanism. That is also why this is plain pub/sub and not Redis
  Streams: a Stream's persistence and consumer groups would deliver a
  guarantee nothing needs, at the cost of trimming policy and
  pending-entry bookkeeping.
- **Two dedicated connections.** Redis command-restricts a subscribing
  connection, so the bus dials a publisher and a subscriber from
  `redisUrl`. TLS (`rediss://`), auth, and db index all ride the url.
- **The broadcast channel is namespaced per deployment.** pg-notify gets
  isolation for free (NOTIFY is scoped to one Postgres database); Redis
  pub/sub is **instance-wide** — the db index does not partition it — so
  two deployments sharing one Redis (staging + prod on one ElastiCache,
  or two apps) would cross-deliver commit rumors and drive each other's
  dry-run/reload work. The channel is therefore
  `adrz_cable:<hash of database.url's host+port+dbname>` — same data,
  same channel; different database, isolated. Credentials and query
  params are excluded from the hash, but the **host and database name
  must match across processes** of one deployment (a per-region DB
  hostname split means split namespaces — see troubleshooting). A custom
  split rides `new RedisBus({ namespace })`.
- **Reconnects self-heal, gaps heal via pull.** Both connections
  reconnect with backoff (1s doubling, 30s cap); the subscriber
  re-SUBSCRIBEs itself on reconnect. Events published during a gap are
  **lost and logged loudly** — the ONE cross-process gap convention, and
  `pg-notify` follows it identically: while the connection is down, wire
  copies are **dropped** (loudly, throttled to a counted summary during a
  storm), never queued unboundedly and never shipped stale after
  reconnect. Clients on the gapped node stay eventually-fresh via pull;
  no subscription is RESET (RESET is a revocation signal, never a
  transport signal).
- **A boot-only loopback probe** publishes to itself and must hear it
  within 5s, or boot fails with a teaching error — this catches
  Redis-compatible proxies/serverless providers that accept commands but
  don't deliver pub/sub, and load balancers that route the two
  connections to different isolated instances. Like pg-notify's probe, it
  never re-runs on reconnect.
- **Pub/sub is instance-wide.** The db index in the url does not
  partition it (a "wrong DB" cannot silently mute it), `maxmemory`
  eviction never touches it (nothing is stored), and in cluster mode a
  PUBLISH reaches subscribers connected to any node. The silent failure
  modes are the two the probe catches.
- Requires `npm install ioredis` (a teaching error at boot says so if
  absent; ioredis over node-redis deliberately — its reconnect owns
  re-SUBSCRIBE, `retryStrategy` maps onto the house backoff, and
  `redis://`/`rediss://` urls carry TLS/auth/db with no option plumbing).
- **The scaffold selects this tier off an ambient `REDIS_URL`** — a
  deliberate, documented exception to the explicit-opt-in rule, with two
  edges the generated config warns about: a `REDIS_URL` attached for some
  *other* purpose activates the tier (the boot probe then refuses a
  non-pub/sub provider loudly), and a vanished `REDIS_URL` silently
  degrades the config to single-process `memory`. Boot always logs the
  resolved tier (`channels bus: …`); once production depends on redis,
  pin `bus: 'redis'` explicitly so a missing url becomes a boot refusal
  instead of a downgrade.

### `nats` (tier 3) — stub

A typed adapter stub whose constructor **throws at boot** with the frozen
interface contract. To use NATS today, implement `ChannelBus`
(publish / subscribe with `'prefix*'` support / close) over your client
and pass it directly: `attachChannels(server, { bus: myBus, … })`.

### How to switch

```ts
channels: { bus: 'redis', redisUrl: process.env.REDIS_URL }   // the multi-process tier
channels: { bus: 'pg-notify' }   // fallback: uses database.url for its dedicated session
```

That is the whole switch. Channel keys, frame building, epochs, and the
client are identical across tiers — the only change is which processes
hear about a commit. Nothing about correctness changes either way (pull
heals all).

## Ops

### Heartbeats vs proxy idle timeouts

The server pings every socket at `heartbeatMs` (default **25s**,
protocol-level ws ping) and terminates a connection after **2 missed
pongs**. 25s sits safely under the common proxy idle timeouts:
Cloudflare severs idle connections at 100s (fixed), AWS ALB and nginx
default to 60s. If connections drop on a fixed cadence in production,
suspect an intermediary with a shorter idle timeout than your heartbeat —
lower `heartbeatMs` or raise the proxy's timeout. Boot warns above 55s.

### Deploys and drains

`channels.close()` (call it on SIGTERM before exiting) sends close code
**1001** to every socket. Clients treat 1001 as "server draining":
fast reconnect with jitter — against the *new* process, where they mint a
fresh token, re-SUB with their cursors, and revalidate. A rolling deploy
therefore costs each client one reconnect and one cheap 304-style
validation, not a resync. No frames are queued for delivery across the
restart — none need to be (pull is correctness).

Close code **1013** means backpressure: that client could not drain its
socket buffer (>4MB queued) and was severed; reconnect + revalidation
heals it. Before the hard limit, at >1MB queued, `CHANGE` frames degrade
to `SIGNAL` (version tokens only — the client knows it is stale and
pulls).

### Revocation → RESET

Permission changes take effect within `revalidate` seconds (default 30),
on **both lanes**. Every frame for a subscription is gated on a door
pass; when the cached pass expires (or immediately, under `revalidate:
'always'`), *record* subscriptions reload the record through the door
with the subscriber's context — the reload is the re-check — and *index*
subscriptions re-run the index dry-run before the flush emits anything.
A failure sends a **RESET** frame (never a silent drop), bumps the
subscription's epoch, and retires the subscription server-side; the
client drops its state and re-subscribes, which re-runs the door dry-run
from scratch. The epoch filter means any frame from the old generation
still in flight is discarded by the client.

Destroy frames are gated the same way: a destroyed record cannot be
reloaded, so a destroy arriving on an **expired** pass downgrades to
RESET — the client's forced re-subscribe re-answers the destroy through
the door's own validate/tombstone fences instead of handing a
stale-authorized socket the pk + destroy-token pair directly.

On **scoped doors** (URL `@scope` or `scopeBy`), index events that arrive
without a record — which is *every* cross-process event on a multi-process
bus — additionally pass a per-pk dry-run through the door before either a
value slice or an ids-only `SIGNAL` reaches the socket: neither row values
nor pk/token/op metadata cross a tenant boundary.

**The bounded leak, stated rather than discovered:** inside the TTL, a
just-revoked subscriber can receive up to `revalidate` seconds of frames
for records they could already see. If that window is unacceptable, set
`revalidate: 'always'` in production and pay a door re-check per emit.
There is deliberately **no server-push admin kill switch** for a specific
principal's live subscriptions: revocation is discovered at the next
re-check, so the TTL *is* the bound. To sever a user immediately, drop
their sessions at your auth layer and restart the channels process (or
run `revalidate: 'always'`).

### Membership tags — what invalidates a live list

The list-invalidation `SIGNAL{tag}` is driven by the door's commit-ordered
membership counter, which bumps on: **lifecycle writes**
(create/destroy/undelete) and **scope-column value writes** (re-tenanting
a row is a membership change on both tenants' lists — the old tenant's
subs hear an ids-only membership hint door-wide). It does **not** bump
when a plain value write moves a row across a client-side index *filter*
(`filters:`/search params the door cannot see) — such a list is corrected
by the row's own `CHANGE` frame where the row stays visible, and heals on
the next refetch or reconnect otherwise (every reconnect re-ack
invalidates the list family regardless of tag equality — the gap is the
rumor). The compiled scope-intersection trim is the named follow-up that
makes filter-crossing precise.

### "Best-effort, no outbox" — what it means for you

- You never need to drain, replay, or reconcile the channel layer. There
  is nothing durable in it.
- Killing a channels process loses only latency. Every client converges
  on the next pull (reconnect, focus, subscribe, mutation response).
- Monitoring should watch connection counts and bus health, not delivery
  rates — there is no delivery SLA to violate, by design.
- Anything that *must* not be lost (jobs, emails, audit) does not belong
  on the bus. It carries rumors about committed rows, nothing else.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| WS connects, no frames ever arrive | The door isn't `wire: 'columnar'` (SUB was refused `BAD_CHANNEL` — check the client console) | Set `wire: 'columnar'` on the `@crud` config and pass that door's `buildRouter` result in `attachChannels({ routers })`. |
| No frames for one field/change | The silence rule: the changed columns don't intersect that door's `expose` mask (record lane = `get` projection, index lane = `index` projection) | Working as designed — add the field to `expose` if clients should see it live. |
| Multi-process: writes on one node never reach sockets on another | `bus: 'memory'` (single-process semantics) | Set `bus: 'redis'` (or the `'pg-notify'` fallback, or pass a custom `ChannelBus`). Clients were healing via pull all along. |
| Upgrade fails 403 | Origin not in `originAllowlist` (production), or non-localhost origin in dev with no allowlist | Add the exact origin (scheme + host + port) to `channels.originAllowlist`. |
| Upgrade fails 401 | Token expired (10s TTL), reused, or minted by a *different process* behind a non-sticky LB | Mint immediately before dialing; enable sticky sessions so `POST {path}/token` and the upgrade hit the same process. |
| Connections drop every N seconds (N ≈ 60–100) | A proxy idle timeout shorter than the heartbeat, or `heartbeatMs` raised past 55s (boot warned) | Keep `heartbeatMs` at the 25s default; check Cloudflare (100s fixed) / ALB / nginx (`proxy_read_timeout`) in the path. |
| Connections drop with close code 1013 | Backpressure: the client couldn't drain >4MB of queued frames (slow network / huge fan-in) | Nothing to fix server-side — reconnect heals. If chronic, the client is subscribed to far more than it can consume. |
| `pg-notify` boot fails: "self-NOTIFY probe heard nothing" | PgBouncer (or another pooler) in transaction-pooling mode between channels and Postgres | Point `database.url` (or the channels bus) at a direct Postgres URL or a session-mode pool. |
| `pg-notify` running but cross-process frames silent, no boot error | Bus was started against a different database/cluster than the writers | Both processes' `database.url` must reach the same Postgres — NOTIFY does not cross databases. |
| Commits slow, `pg_locks` shows waits on `class 1262 … database 0` | NOTIFY's global commit-order lock — the `pg-notify` tier is saturated | Move to `bus: 'redis'` — this saturation is exactly what the redis tier exists for. |
| `redis` boot fails: "loopback probe … heard nothing" | Redis unreachable (connection errors logged above the refusal), a Redis-compatible proxy/serverless provider without pub/sub support, or an LB routing the publisher and subscriber connections to different isolated instances | Point `redisUrl` at one real Redis endpoint. (Not the db index — pub/sub is instance-wide — and not `maxmemory` eviction, which never touches pub/sub.) |
| `redis` running but cross-process frames silent, no boot error | The processes' `redisUrl`s reach different Redis instances (per-region endpoints, a migration half-done) — or their `database.url`s name different **hosts/dbnames** for the same data, splitting the derived channel namespace | Every process must publish and subscribe on the same instance/cluster, and reach the database through the same host + dbname (credentials/params don't matter — the namespace hashes host+port+dbname only). Meanwhile clients were healing via pull. |
| Two deployments share one Redis and you *want* them isolated | Nothing to fix — the broadcast channel is namespaced per database (`adrz_cable:<hash>`), so different databases never cross-deliver | Sharing one Redis between staging and prod is safe by default; only identical database host+port+dbname would share a channel (and then they share the data too). |
| `redis` logs "connection error (reconnecting…)" bursts | A Redis restart, failover, or network blip — the reconnect gap | Nothing to drain or replay: missed events healed on the next pull; the subscriber re-SUBSCRIBEd itself. Chronic bursts mean unstable Redis, not a bus problem. |
| Boot throws "originAllowlist is required in production" | Serving channels in production without an Origin allowlist (CSWSH) | List your app origins under `environments.production.channels.originAllowlist`. |
| Boot throws "publishes frames to nowhere" | `role: 'publish-only'` with `bus: 'memory'` | Set a cross-process bus, or drop the role. |
| Stale permissions still streaming for up to 30s | The `revalidate` TTL — the documented bounded leak | Lower `revalidate` or set `'always'` if the window is unacceptable. |
| Upgrade fails 503 | The process is at `maxConnections` | Scale out (or raise the cap). The token was not consumed — the client retries with it. |
| SUB refused `SUB_LIMIT` / `RATE_LIMITED` | One socket holds `maxSubsPerConnection` live subs / is SUB-flooding past the refill rate | UNSUB what is no longer rendered; a legitimate app rarely needs hundreds of live subs on one tab. |
