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
