# DESIGN — WS Channels: door-authorized, payload-carrying live updates

**Status:** design (Daniel's "creme de la creme" spec, 2026-07-19). Supersedes
the signal-only doctrine as the PRIMARY lane; signal-only survives as the
degraded mode and the untrusted-transport fallback.

---

## 0. The one-sentence design

A client subscribes to `[controller, id]`; the server authorizes by
**dry-running the controller's own GET**, then pushes **door-projected
change blobs** on every commit — and pushes **nothing** when the change,
seen through that controller's lens, amounts to nothing.

Everything hard is something we already have:

| Need | Already built |
|---|---|
| "may user U see record R through door D?" | the controller's read path (scoped relation + scopeBy + find) |
| "what changed in this save?" | `record.previousChanges` (field → [old, new]), alive at afterCommit |
| "never emit uncommitted state" | afterCommit already defers past transactions |
| "what may leave the server?" | the `expose` ceiling (static per controller) |
| "fold a partial into a live client" | `rehydrate()` three-way merge — partial records already work (only present keys merge) |
| "client is fine if the wire dies" | the entire coherence/poll/409 stack — the WS lane is an OPTIMIZATION over refetch |

## 1. The ActionCable map

ActionCable's decomposition is correct; we keep its shape and replace its
authorization with doors:

| ActionCable | Ours |
|---|---|
| `Connection` + `identified_by :current_user` (cookie auth at upgrade) | `identify(request) → ctx` — THE SAME context builder the HTTP router uses (`{ userId }` in the demo). App-provided, one function. |
| `Channel#subscribed` + `reject` | **subscribe = door dry-run**: run the controller's GET pipeline for `[resource, id]` under `ctx`. 404/403 → reject. Zero per-channel auth code — it's generated from the same metadata. |
| `stream_for(record)` | channel key `${controllerPath}:${id}` (and `${controllerPath}:index`, §6) |
| `broadcast` via adapter (redis/async/postgres) | `BroadcastBus` interface — in-memory default, Redis adapter is the after-5k move (§8) |
| AnyCable (socket layer in Go, gRPC back to Rails) | explicitly NOT a dependency; the bus interface is where such a thing would plug if ever needed |

## 2. Server half A — the connection

```ts
// app code (one function, mirrors the HTTP context builder):
createChannelServer(httpServer, {
  identify: (req) => ({ userId: Number(req.headers['x-user-id']) || undefined }),
  controllers: [DealController, CompanyController],
})
```

- WS upgrade on the SAME http server (`/cable`), `ws` package (tiny, boring,
  the ecosystem standard; no framework, no protocol invention).
- `identify` rejects → socket closed before any subscription exists.
- The connection holds `ctx` for its lifetime — exactly ActionCable's
  `current_user`.

## 3. Server half B — subscription = the door, dry-run

Client frame: `{ type: 'subscribe', channel: 'deals', id: 1, view: 'get' }`

The server runs **the controller's real read path** — scoped relation,
`scopeBy`, `@before` hooks, find — and:

- found → subscription accepted; the fresh envelope is returned AS the
  subscription confirmation (the client starts synchronized for free).
- not found / forbidden → `{ type: 'reject' }`. The client learns nothing
  it couldn't learn from a GET.

**No additional authorization code exists anywhere.** If the door changes
(new scopeBy, tightened permit), subscriptions tighten with it on the next
check — there is no second permission system to drift.

### Visibility revocation (the hard correctness rule)

A subscription authorized at T0 can become illegitimate at T1 (the loan
moves to another org). Rule: **authorization is re-verified on emission,
with a short TTL cache (default 30s), and a failed re-check DROPS the
subscription** (client receives `{ type: 'unsubscribed', reason: 'gone' }`
and treats it as a 404 → refetch → its own error surface).

- The re-check is the same door dry-run, batched per (controller, id) per
  emission — one query covers every subscriber of that channel whose door
  scope is context-independent; context-dependent doors (scopeBy reading
  ctx) re-check per distinct ctx-key.
- TTL trade-off is explicit and configurable: within the TTL a revoked
  viewer can receive at most TTL-seconds of updates to a record they could
  already have polled during the same window. `revalidate: 'always'` exists
  for the paranoid tier.

## 4. Server half C — the model declares, the emitter projects

```ts
@model('deals')
@broadcasts()                 // Daniel's @emit_changes_over_ws_to_controllers
export class Deal extends ApplicationRecord { … }
```

`@broadcasts()` registers an afterCommit hook (already transaction-safe):

1. `changes = record.previousChanges` (create → all fields; destroy → op only).
2. For each controller registered as serving this model:
   - `visible = changedFields ∩ expose` — **empty → NO frame.** ("This
     controller's version of the change amounts to nothing.")
   - serialize ONCE per (model, controller): `{ record: pick(record, visible ∪ {id}), version, op }`.
     Expose is static per controller, so one blob serves every subscriber
     of that controller's channels — per-user variation lives in door
     *membership* (checked in §3), never in field shape.
   - Daniel's economy note: when two controllers' get/index projections
     coincide, the registry detects equal expose sets and serializes once.
3. `bus.publish(channelKey, frame)` — fan-out to sockets is the bus's job.

The payload is exactly as trustworthy as a GET response: same door, same
ceiling, produced server-side. This is why payloads are now allowed where
signal-only was the rule — the old rule guarded *untrusted* transports,
and this transport is authorized and server-authoritative end to end.

## 5. The wire

```
client → { type: 'subscribe', channel, id, view }        // view: 'get' | 'index'
server → { type: 'confirmed', channel, id, envelope }    // fresh, synchronized start
server → { type: 'changed', channel, id, record: {…partial…}, version, op }
server → { type: 'unsubscribed', channel, id, reason }   // revoked | gone
client → { type: 'unsubscribe', channel, id }
both   → { type: 'ping' } / { type: 'pong' }             // 30s heartbeat
```

Frames carry the **version token** — the client's three-way merge applies
unchanged: stale frame → ignored (monotonicity guard), conflicting frame →
`elsewhere` + withheld token → the existing 409 story. The safety proof is
transport-independent; we built it that way on purpose.

## 6. Index channels (v1 semantics, deliberately coarse)

`{ channel: 'deals', view: 'index' }` — authorized by dry-running index
(page 0, perPage 1). Emission: every committed change to a record the door
serves publishes the same per-controller blob to the index channel; the
client folds it into cached lists it matches and **invalidates** the list
family otherwise (membership arithmetic — did this change move a record in
or out of MY filter set? — is explicitly not computed server-side in v1;
the refetch lane answers it). This is honest: index channels are a
freshness signal WITH a payload attached, not a replicated query.

## 7. Client half — and "1000% ok when it dies"

```ts
connectChannels(qc, coherenceEdges, { url: '/cable' })   // once, at startup
// generated hooks auto-subscribe: useDealEditForm(id, { live: true })
// surfaces: <Deals.Index live> — subscribes the index channel
```

Frame handling, in order:
1. an open form session for [resource, id] → `session.rehydrate(partial)`
   (merge, `elsewhere`, floater, 409 — all existing machinery);
2. else a cached detail/list query → patch or invalidate via the coherence
   keys;
3. else drop the frame.

Failure semantics — the consumer's contract:

| Event | Consequence |
|---|---|
| WS never connects | app == today: coherence refetch on local mutations, `poll` where configured. Nothing subscribes, nothing breaks. |
| WS drops mid-session | client reconnects w/ backoff; ON RECONNECT it invalidates every subscribed family (one refetch heals any missed window). No server-side replay state, no catch-up protocol. |
| frame lost | next frame's version still merges (tokens are absolute, not deltas — `record` carries values, not diffs of diffs); worst case the reconnect invalidation heals it. |
| server restarts | all sockets die → reconnect path above. Subscriptions are client-owned state, resent on connect. |

The reason this is cheap: **frames are absolute field values + a version,
never operational deltas** — losing any prefix of the stream is always
healed by one refetch. That single decision buys the whole "1000% ok".

## 8. Topology & the 5k budget

**v1: in-process.** The WS server rides the same Node process/HTTP server
as the API. 5k idle-ish connections ≈ tens of MB of socket state; emission
work is one serialization per (model, controller) per commit plus O(sub-
scribers) socket writes — Node does this comfortably. No second service,
no IPC, the afterCommit hook publishes to an in-memory bus that IS the
socket registry.

**After 5k / multi-process:** the ONLY thing that changes is the bus:
`BroadcastBus { publish(channel, frame); subscribe(channel, fn) }` —
in-memory today, Redis pub/sub adapter when the app outgrows one process
(publisher = afterCommit in any API process; subscriber = whichever
process holds the socket). This is exactly ActionCable's adapter seam, and
it is where an anycable-like mover would attach *if ever* — never as a
framework dependency.

**Not chosen, and why:** a separate socket service on day one (operational
cost before 5k users exist); anycable (a dependency owning our auth path);
SSE-per-channel (no client→server subscribe multiplexing); postgres
LISTEN/NOTIFY as the bus (8000-byte payload limit forces a refetch
indirection — viable fallback adapter, not the default).

## 9. Non-resource channels (the plug Daniel asked for)

The resource channels are a *generated specialization* of one generic layer:

```ts
server.channel('notifications', {
  authorize: (ctx, params) => Number(params.userId) === ctx.userId,
})
server.broadcastTo('notifications', { userId: 5 }, { kind: 'mention', … })
// client: subscribeChannel('notifications', { userId: 5 }, handler)
```

Notifications, presence, job progress — same connection, same auth object,
same bus, zero coupling to the resource machinery.

## 10. Build plan (phased, each shippable)

1. **Bus + server + generic channels** (`@active-drizzle/controller/ws` or
   a `channels` module): identify, subscribe protocol, heartbeat, generic
   `channel()`. Tests against an in-process socket pair.
2. **Door-authorized resource channels**: subscribe = GET dry-run,
   confirmation envelope, revocation-on-emit w/ TTL. Contract probes grow
   a "subscribe to a record outside your door → reject" probe.
3. **`@broadcasts()`**: previousChanges ∩ expose per controller, empty →
   silence (unit-tested exactly like the aggregate maths), once-per-
   controller serialization.
4. **Client**: `connectChannels`, form `live: true`, `<Index live>`,
   reconnect-invalidate. The demo's SSE lane is then deleted (superseded).
5. **Redis bus adapter** — only when someone actually approaches the
   ceiling. Not before.

**Explicitly not in v1:** operational deltas / CRDTs, server-side index
membership arithmetic (§6), presence (rides §9 later), catch-up replay,
any second service.
