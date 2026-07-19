/**
 * The aggregate MATHS: facets (opt-in ∩ ceiling, disjunctive exclusion),
 * chart (allowlists, real sums, measure codecs), metric, options (expose
 * ceiling, narrowing, cap), emptyReason — computed against an in-memory
 * relation with the REAL chainable semantics (where mutates, group clones)
 * so the numbers themselves are asserted, not just the plumbing.
 */
import { describe, it, expect } from 'vitest'
import { defaultIndex } from '../src/crud-handlers.js'
import { BadRequest } from '../src/errors.js'

const ROWS = [
  { id: 1, name: 'Acme',    stage: 'draft',     priority: 'high',   amount: 4800000 },
  { id: 2, name: 'Globex',  stage: 'draft',     priority: 'medium', amount: 1250000 },
  { id: 3, name: 'Initech', stage: 'submitted', priority: 'low',    amount: 990000 },
  { id: 4, name: 'Umbrella', stage: 'won',      priority: 'high',   amount: 2000000 },
]

/** In-memory Relation mirroring the shipped semantics: where/limit MUTATE
 *  in place, group/clone CLONE — the exact mix defaultIndex must survive. */
class MiniRel {
  rows: any[]
  preds: Array<(r: any) => boolean> = []
  groupField: string | null = null
  limitN: number | null = null
  offsetN = 0
  constructor(rows: any[]) { this.rows = rows }
  clone(): MiniRel {
    const c = new MiniRel(this.rows)
    c.preds = [...this.preds]; c.groupField = this.groupField
    c.limitN = this.limitN; c.offsetN = this.offsetN
    return c
  }
  where(cond: Record<string, any>): this {
    for (const [k, v] of Object.entries(cond)) {
      this.preds.push(Array.isArray(v) ? (r) => v.includes(r[k]) : (r) => r[k] === v)
    }
    return this
  }
  whereAny(branches: Array<Record<string, any>>): this {
    this.preds.push((r) => branches.some(b => Object.entries(b).every(([k, v]) => r[k] === v)))
    return this
  }
  search(q: string, fields: string[]): this {
    this.preds.push((r) => fields.some(f => String(r[f] ?? '').toLowerCase().includes(q.toLowerCase())))
    return this
  }
  group(f: string): MiniRel { const c = this.clone(); c.groupField = f; return c }
  order(): this { return this }
  limit(n: number): this { this.limitN = n; return this }
  offset(n: number): this { this.offsetN = n; return this }
  includes(): this { return this }
  private current(): any[] { return this.rows.filter(r => this.preds.every(p => p(r))) }
  private grouped(): Map<string, any[]> {
    const m = new Map<string, any[]>()
    for (const r of this.current()) {
      const k = String(r[this.groupField!])
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return m
  }
  async count(): Promise<any> {
    if (!this.groupField) return this.current().length
    return Object.fromEntries([...this.grouped()].map(([k, rs]) => [k, rs.length]))
  }
  async sum(f: string): Promise<any> {
    if (!this.groupField) return this.current().reduce((t, r) => t + r[f], 0)
    return Object.fromEntries([...this.grouped()].map(([k, rs]) => [k, rs.reduce((t, r) => t + r[f], 0)]))
  }
  async average(f: string): Promise<any> {
    const rs = this.current()
    if (!this.groupField) return rs.length ? rs.reduce((t, r) => t + r[f], 0) / rs.length : null
    return Object.fromEntries([...this.grouped()].map(([k, g]) => [k, g.reduce((t, r) => t + r[f], 0) / g.length]))
  }
  async load(): Promise<any[]> {
    const rs = this.current().slice(this.offsetN, this.limitN != null ? this.offsetN + this.limitN : undefined)
    return rs
  }
}

// money-style codec on the measure field — the maths must run values through it
const model: any = { name: 'Deal', amount: { get: (v: number) => (v / 100).toFixed(2) } }

const CONFIG: any = {
  index: {
    filterable: ['stage', 'priority'],
    facets: true,
    chartable: ['stage'],
    measures: ['amount'],
    searchable: ['name'],
    defaultSort: { field: 'name', dir: 'asc' },
  },
  get: { expose: ['id', 'name', 'stage', 'amount'] },
}

const run = (params: any, config: any = CONFIG, rows: any[] = ROWS) =>
  defaultIndex(new MiniRel(rows), model, config, params)

describe('facets — opt-in ∩ ceiling', () => {
  it('NOT requested → no facets computed (the default is free)', async () => {
    const res = await run({})
    expect(res.facets).toBeUndefined()
  })

  it('facets: true → every allowed field, real counts, label keys', async () => {
    const res = await run({ facets: true })
    expect(res.facets).toEqual({
      stage: { draft: 2, submitted: 1, won: 1 },
      priority: { high: 2, medium: 1, low: 1 },
    })
  })

  it('a request subset narrows; outside the ceiling rejects', async () => {
    const res = await run({ facets: ['stage'] })
    expect(Object.keys(res.facets!)).toEqual(['stage'])
    await expect(run({ facets: ['amount'] })).rejects.toBeInstanceOf(BadRequest)
  })

  it('requested against a config with NO facets ceiling rejects', async () => {
    const cfg = { ...CONFIG, index: { ...CONFIG.index, facets: undefined } }
    await expect(run({ facets: true }, cfg)).rejects.toBeInstanceOf(BadRequest)
  })

  it('DISJUNCTIVE: a field ignores its OWN filter but honors the others', async () => {
    const res = await run({ facets: true, filters: { priority: 'high' } })
    // stage counts live under priority=high → Acme(draft) + Umbrella(won)
    expect(res.facets!.stage).toEqual({ draft: 1, won: 1 })
    // priority counts EXCLUDE their own filter → the full picture survives
    expect(res.facets!.priority).toEqual({ high: 2, medium: 1, low: 1 })
    // and the row page itself is narrowed
    expect(res.data.map((r: any) => r.name)).toEqual(['Acme', 'Umbrella'])
  })

  it('search narrows facet counts too (q is part of the pipeline)', async () => {
    const res = await run({ facets: ['stage'], q: 'acme' })
    expect(res.facets!.stage).toEqual({ draft: 1 })
  })
})

describe('chart / metric — allowlists + real arithmetic + codecs', () => {
  it('sum:amount groups correctly AND runs the measure codec (cents → dollars)', async () => {
    const res = await run({ perPage: 0, chart: { x: 'stage', y: 'sum:amount' } })
    expect(res.chart).toEqual([
      { x: 'draft', y: '60500.00' },       // (4800000+1250000)/100, codec'd
      { x: 'submitted', y: '9900.00' },
      { x: 'won', y: '20000.00' },
    ])
    expect(res.data).toEqual([])           // perPage: 0 skipped the row query
  })

  it('chart respects the live narrowing', async () => {
    const res = await run({ perPage: 0, chart: { x: 'stage' }, filters: { priority: 'high' } })
    expect(res.chart).toEqual([{ x: 'draft', y: 1 }, { x: 'won', y: 1 }])
  })

  it('forged x / forged measure / unknown spec all reject', async () => {
    await expect(run({ chart: { x: 'priority' } })).rejects.toBeInstanceOf(BadRequest)     // not chartable
    await expect(run({ chart: { x: 'stage', y: 'sum:id' } })).rejects.toBeInstanceOf(BadRequest)
    await expect(run({ chart: { x: 'stage', y: 'median:amount' } })).rejects.toBeInstanceOf(BadRequest)
    await expect(run({ metric: 'sum:secret' })).rejects.toBeInstanceOf(BadRequest)
  })

  it('metric returns a codec-run SCALAR over the narrowing', async () => {
    expect((await run({ perPage: 0, metric: 'count' })).metric).toBe(4)
    expect((await run({ perPage: 0, metric: 'sum:amount', q: 'globex' })).metric).toBe('12500.00')
    expect((await run({ perPage: 0, metric: 'avg:amount', filters: { priority: 'high' } })).metric).toBe('34000.00')
  })
})

describe('options — the picker feed under the expose ceiling', () => {
  it('projects the narrowed set to [{ value, label }]', async () => {
    const res = await run({ options: { value: 'id', label: 'name' }, q: 'acme' })
    expect(res.options).toEqual([{ value: 1, label: 'Acme' }])
  })

  it('fields outside expose reject; id is always projectable', async () => {
    await expect(run({ options: { value: 'id', label: 'priority' } })).rejects.toBeInstanceOf(BadRequest)
    const ok = await run({ options: { value: 'id', label: 'stage' } })
    expect(ok.options).toHaveLength(4)
  })

  it('caps at perPage (bounded by maxPerPage), default 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `n${i}`, stage: 'draft', priority: 'low', amount: 0 }))
    const res = await run({ options: { value: 'id', label: 'name' } }, CONFIG, many)
    expect(res.options).toHaveLength(50)
    const capped = await run({ options: { value: 'id', label: 'name' }, perPage: 3 }, CONFIG, many)
    expect(capped.options).toHaveLength(3)
  })
})

describe('emptyReason — an empty page knows why', () => {
  it("narrowing excluded everything → 'no-matches'", async () => {
    const res = await run({ filters: { stage: 'lost' } })
    expect(res.data).toEqual([])
    expect(res.emptyReason).toBe('no-matches')
  })

  it("the door scope is genuinely empty → 'no-records'", async () => {
    const res = await run({}, CONFIG, [])
    expect(res.emptyReason).toBe('no-records')
    const filtered = await run({ filters: { stage: 'lost' } }, CONFIG, [])
    expect(filtered.emptyReason).toBe('no-records')   // nothing to match anyway
  })

  it('a non-empty page carries NO emptyReason', async () => {
    const res = await run({})
    expect(res.emptyReason).toBeUndefined()
  })
})
