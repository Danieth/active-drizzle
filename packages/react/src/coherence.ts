/**
 * Cache coherence — the client fan-out engine (DESIGN-cache-coherence §A).
 *
 * ONE source-blind entry point: every "entity changed" event — from a local
 * mutation today, a WebSocket signal tomorrow, a poller if desperate —
 * flows through applyEntityChange, which fans invalidation across every
 * query-key family the statically-generated edge table says can be
 * affected. The table is MODEL-keyed (table names) and maps to the
 * query-key ROOTS (client keys) of every door that either serves that
 * model or embeds it through includes — composed through the write-effect
 * graph (counterCache / touch / dependent / nested), so a proposal
 * mutation that touches its loan invalidates the doors that embed LOANS
 * too, transitively.
 *
 * Invalidation is prefix-based: modelCacheKeys roots every key with the
 * resource name, so one invalidateQueries per family covers all scopes,
 * lists, details, and searches under it. React Query dedupes/batches the
 * refetches; live forms absorb them through rehydrate().
 */
/**
 * STRUCTURAL query-client type — deliberately NOT @tanstack's QueryClient:
 * the consumer app holds its own copy of query-core, and the nominal
 * `#private` field makes cross-copy QueryClient assignments a type error.
 * All we ever call is invalidateQueries.
 */
export interface QueryClientLike {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<unknown> | void
}

export interface CoherenceEdges {
  /** mutated model (table name) → query-key roots (client keys) to invalidate. */
  invalidates: Record<string, readonly string[]>
}

export interface EntityChange {
  /** The mutated MODEL's table name (the canonical entity identity). */
  resource: string
  op?: 'create' | 'update' | 'destroy'
  id?: number | string
}

export function applyEntityChange(
  qc: QueryClientLike,
  edges: CoherenceEdges | null | undefined,
  ev: EntityChange,
): void {
  const families = new Set<string>(edges?.invalidates?.[ev.resource] ?? [ev.resource])
  for (const family of families) {
    qc.invalidateQueries({ queryKey: [family] })
  }
}

// ── Live signals — the transport PLUG (DESIGN-cache-coherence §WS) ──────────
//
// The framework never owns the wire. Whatever pushes — WebSocket, SSE, a
// BroadcastChannel from another tab — the contract is SIGNAL-ONLY:
// { resource, op }. No payloads are trusted or applied; a signal only
// triggers the same coherence fan-out a local mutation does, the refetch
// carries the truth, and open forms absorb it through the three-way merge
// (dirty fields survive, true conflicts surface `elsewhere` + withhold the
// version token). Safety is transport-independent by construction.

export interface LiveSignal {
  resource: string
  op?: 'create' | 'update' | 'destroy'
}

/**
 * Wire any push source into the coherence engine. `subscribe` registers a
 * signal callback and returns an unsubscribe — the shape of every event
 * emitter ever. Returns the disconnect function.
 *
 *   const off = connectLiveSignals(qc, coherenceEdges, (on) => {
 *     socket.on('entity', on); return () => socket.off('entity', on)
 *   })
 */
export function connectLiveSignals(
  qc: QueryClientLike,
  edges: CoherenceEdges,
  subscribe: (onSignal: (s: LiveSignal) => void) => () => void,
): () => void {
  return subscribe((s) => {
    if (!s || typeof s.resource !== 'string' || !s.resource) return
    const op = s.op === 'create' || s.op === 'destroy' ? s.op : 'update'
    applyEntityChange(qc, edges, { resource: s.resource, op })
  })
}

/**
 * The zero-config flavor: an SSE endpoint that emits JSON LiveSignals.
 * Reconnects are EventSource's own; malformed frames are ignored.
 *
 *   useEffect(() => connectEventSource(qc, coherenceEdges, '/live'), [])
 */
export function connectEventSource(
  qc: QueryClientLike,
  edges: CoherenceEdges,
  url: string,
): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const es = new EventSource(url)
  const off = connectLiveSignals(qc, edges, (on) => {
    const handler = (e: MessageEvent) => {
      try { on(JSON.parse(e.data)) } catch { /* malformed frame — ignore */ }
    }
    es.addEventListener('message', handler)
    return () => es.removeEventListener('message', handler)
  })
  return () => { off(); es.close() }
}
