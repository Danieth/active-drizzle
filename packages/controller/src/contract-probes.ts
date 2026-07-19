/**
 * Contract probes — the security suite the metadata already implies.
 *
 * Every allowlist in a controller (`filterable`, `sortable`, `chartable`,
 * `measures`, `permit`, mutation `params`/`required`) is a CONTRACT: input
 * outside it must be rejected or stripped. We hand-wrote exactly these
 * curl probes twice this weekend; this module derives them from the same
 * metadata, so the forge-every-field suite writes itself and can never
 * fall behind the config.
 *
 * Usage (any test runner, any transport):
 *
 *   const probes = buildContractProbes(DealController)
 *   const failures = await runContractProbes(probes, (proc, input) =>
 *     callMyRouter(proc, input))          // throw on 4xx, resolve on 2xx
 *   expect(failures).toEqual([])
 *
 * Probes are transport-agnostic: `call` throwing = rejection; resolving =
 * acceptance. `expect: 'strip'` probes accept EITHER outcome except a
 * successful echo of the forged value.
 */
import { getCrudMeta, getMutations } from './metadata.js'

export interface ContractProbe {
  name: string
  procedure: string
  input: Record<string, any>
  /** 'reject': the call MUST fail (4xx). 'strip': the call may succeed,
   *  but the forged field must not come back holding the forged value. */
  expect: 'reject' | 'strip'
  forgedField?: string
  forgedValue?: unknown
}

const FORGED = '__ad_forged__'

export function buildContractProbes(
  ControllerClass: any,
  opts: { recordId?: number } = {},
): ContractProbe[] {
  const crud = getCrudMeta(ControllerClass)
  if (!crud) return []
  const config: any = crud.config
  const idx = config.index ?? {}
  const id = opts.recordId ?? 1
  const probes: ContractProbe[] = []
  const filterable: string[] = idx.filterable ?? []
  const firstFilter = filterable[0]

  // ── index: every filter/sort/aggregate key is an allowlist ───────────────
  probes.push({
    name: 'undeclared filter key is rejected (never a silent no-op)',
    procedure: 'index', input: { filters: { [FORGED]: 1 } }, expect: 'reject',
  })
  probes.push({
    name: '$or branch with a non-allowlisted field is rejected',
    procedure: 'index', input: { filters: { $or: [{ [FORGED]: 1 }] } }, expect: 'reject',
  })
  if (firstFilter) {
    probes.push({
      name: '$or cannot nest',
      procedure: 'index', input: { filters: { $or: [{ [firstFilter]: { $or: [] } }] } }, expect: 'reject',
    })
    probes.push({
      name: '$or branch count is capped',
      procedure: 'index',
      input: { filters: { $or: Array.from({ length: 11 }, () => ({ [firstFilter]: 1 })) } },
      expect: 'reject',
    })
  }
  probes.push({
    name: 'sort outside the sortable allowlist is rejected',
    procedure: 'index', input: { sort: { field: FORGED, dir: 'asc' } }, expect: 'reject',
  })
  if (idx.chartable?.length) {
    probes.push({
      name: 'chart dimension outside chartable is rejected',
      procedure: 'index', input: { perPage: 0, chart: { x: FORGED } }, expect: 'reject',
    })
    probes.push({
      name: 'aggregate measure outside measures is rejected',
      procedure: 'index', input: { perPage: 0, chart: { x: idx.chartable[0], y: `sum:${FORGED}` } }, expect: 'reject',
    })
  }
  if (idx.measures?.length || idx.chartable?.length) {
    probes.push({
      name: 'metric measure outside measures is rejected',
      procedure: 'index', input: { perPage: 0, metric: `sum:${FORGED}` }, expect: 'reject',
    })
  }
  if (config.get?.expose?.length) {
    probes.push({
      name: 'options projection outside expose is rejected',
      procedure: 'index', input: { options: { value: 'id', label: FORGED } }, expect: 'reject',
    })
  }
  if (!idx.searchable?.length && !idx.search) {
    probes.push({
      name: 'q on a non-searchable index is rejected',
      procedure: 'index', input: { q: 'x' }, expect: 'reject',
    })
  }

  // ── update: expose-but-not-permitted fields must strip ───────────────────
  // Only STATIC permits are statically derivable; a permit FUNCTION is
  // record/role-aware — probe those in your own tests with real contexts.
  const permit = config.update?.permit
  const expose: string[] = config.get?.expose ?? []
  if (Array.isArray(permit)) {
    const readOnly = expose.filter(f => f !== 'id' && !permit.includes(f))
    if (readOnly.length) {
      probes.push({
        name: `non-permitted field '${readOnly[0]}' must not mass-assign`,
        procedure: 'update',
        input: { id, data: { [readOnly[0]!]: FORGED } },
        expect: 'strip', forgedField: readOnly[0]!, forgedValue: FORGED,
      })
    }
  }

  // ── mutations: required params + payload allowlists ──────────────────────
  for (const mut of getMutations(ControllerClass)) {
    if (mut.bulk) continue
    if (mut.required?.length) {
      probes.push({
        name: `mutation '${mut.method}' without required params is rejected`,
        procedure: mut.method, input: { id, data: {} }, expect: 'reject',
      })
    }
  }

  return probes
}

export interface ContractProbeFailure {
  probe: ContractProbe
  reason: string
}

/**
 * Run probes through YOUR transport. `call` must throw/reject on 4xx and
 * resolve with the response body on 2xx. Returns FAILURES only — an empty
 * array is a passing contract.
 */
export async function runContractProbes(
  probes: ContractProbe[],
  call: (procedure: string, input: Record<string, any>) => Promise<any>,
): Promise<ContractProbeFailure[]> {
  const failures: ContractProbeFailure[] = []
  for (const probe of probes) {
    try {
      const res = await call(probe.procedure, probe.input)
      if (probe.expect === 'reject') {
        failures.push({ probe, reason: 'expected a rejection, but the call succeeded' })
      } else if (probe.forgedField) {
        const pick = (body: any): unknown => body && typeof body === 'object'
          ? ((body as any).record?.[probe.forgedField!] ?? (body as any)[probe.forgedField!])
          : undefined
        if (pick(res) === probe.forgedValue) {
          failures.push({ probe, reason: `forged value ECHOED on '${probe.forgedField}'` })
          continue
        }
        // The echo can lie — re-GET and check PERSISTENCE (a server that
        // strips the response but writes the row must still fail)
        if (probe.input['id'] != null) {
          try {
            const fresh = await call('get', { id: probe.input['id'] })
            if (pick(fresh) === probe.forgedValue) {
              failures.push({ probe, reason: `forged value PERSISTED on '${probe.forgedField}' (echo was clean)` })
            }
          } catch { /* no readable get — echo verdict stands */ }
        }
      }
    } catch {
      // rejection — correct for 'reject', acceptable (stricter) for 'strip'
    }
  }
  return failures
}
