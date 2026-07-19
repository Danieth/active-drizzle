/**
 * Contract probes — the forge-every-field suite, derived from metadata.
 * Generation is asserted exactly; the runner is exercised against
 * defaultIndex (real rejection machinery, mock relation).
 */
import { describe, it, expect, vi } from 'vitest'
import { controller, crud, mutation } from '../src/decorators.js'
import { buildContractProbes, runContractProbes } from '../src/contract-probes.js'
import { defaultIndex } from '../src/crud-handlers.js'

class Duck {}

@controller('/ducks')
@crud(Duck as any, {
  index: {
    filterable: ['stage', 'priority'],
    sortable: ['name'],
    chartable: ['stage'],
    measures: ['amount'],
    searchable: ['name'],
  },
  get: { expose: ['id', 'name', 'stage', 'ownerId'], abilities: true },
  update: { permit: ['name'] },
})
class DuckController {
  @mutation({ params: ['reason'], required: ['reason'] })
  async sendBack() {}
}

describe('buildContractProbes', () => {
  const probes = buildContractProbes(DuckController)

  it('derives the full hostile-input set from the config', () => {
    const names = probes.map(p => p.name)
    expect(names).toEqual([
      'undeclared filter key is rejected (never a silent no-op)',
      '$or branch with a non-allowlisted field is rejected',
      '$or cannot nest',
      '$or branch count is capped',
      'sort outside the sortable allowlist is rejected',
      'chart dimension outside chartable is rejected',
      'aggregate measure outside measures is rejected',
      'metric measure outside measures is rejected',
      "non-permitted field 'stage' must not mass-assign",
      "mutation 'sendBack' without required params is rejected",
    ])
  })

  it('permit-function controllers skip the static strip probe', () => {
    @controller('/dynamic')
    @crud(Duck as any, {
      index: {},
      get: { expose: ['id', 'name'] },
      update: { permit: () => ['name'] },
    })
    class DynController {}
    const names = buildContractProbes(DynController).map(p => p.name)
    expect(names.some(n => n.includes('mass-assign'))).toBe(false)
  })
})

describe('runContractProbes against the real defaultIndex machinery', () => {
  function makeRel() {
    const rel: any = {
      where: vi.fn(() => rel), whereAny: vi.fn(() => rel), order: vi.fn(() => rel),
      count: vi.fn(async () => 1), limit: vi.fn(() => rel), offset: vi.fn(() => rel),
      includes: vi.fn(() => rel), load: vi.fn(async () => [{ id: 1 }]),
      clone: () => rel, group: () => rel, search: vi.fn(() => rel),
    }
    return rel
  }
  const model: any = { name: 'Duck' }
  const config: any = {
    index: { filterable: ['stage'], sortable: ['name'], chartable: ['stage'], measures: ['amount'], searchable: ['name'] },
    get: { expose: ['id', 'name'] },
  }

  it('a compliant controller yields ZERO failures on its index probes', async () => {
    const probes = buildContractProbes(DuckController).filter(p => p.procedure === 'index')
    const failures = await runContractProbes(probes, (proc, input) =>
      defaultIndex(makeRel(), model, config, input as any))
    expect(failures).toEqual([])
  })

  it('a broken server (accepts everything) fails every reject probe', async () => {
    const probes = buildContractProbes(DuckController).filter(p => p.expect === 'reject' && p.procedure === 'index')
    const failures = await runContractProbes(probes, async () => ({ data: [] }))
    expect(failures.length).toBe(probes.length)
  })

  it('a strip probe fails only when the forged value ECHOES back', async () => {
    const probes = buildContractProbes(DuckController).filter(p => p.expect === 'strip')
    expect(probes).toHaveLength(1)
    const echoed = await runContractProbes(probes, async () => ({ record: { stage: '__ad_forged__' } }))
    expect(echoed).toHaveLength(1)
    const stripped = await runContractProbes(probes, async () => ({ record: { stage: 'draft' } }))
    expect(stripped).toEqual([])
  })
})
