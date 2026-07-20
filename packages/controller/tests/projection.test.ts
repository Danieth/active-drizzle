/**
 * The projection tree, P1 (DESIGN-projections.md): normalization,
 * decorator desugar, and the recursive read-slice — including THE case
 * that motivated the design: a grandchild include serving only a slice
 * of its fields ("on my sentiments nested include I am only getting a
 * slice of the attributes").
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeProjection, sliceByProjection, nodeToIncludeSpecs, PROJECTION_NODE,
} from '../src/projection.js'
import { controller, crud } from '../src/decorators.js'
import { getCrudMeta } from '../src/metadata.js'
import { buildRecordEnvelope } from '../src/crud-handlers.js'

// The DRY declaration: two arrays + the rule (editable is implicitly
// viewable), recursive through include.
const FORM = {
  editable: ['name', 'amount'],
  viewable: ['stage'],
  include: {
    notes: {
      editable: ['body'],
      viewable: ['position'],
      include: {
        sentiments: { editable: ['score'], viewable: ['label'] },
      },
    },
  },
} as const

describe('normalizeProjection', () => {
  it('editable is IMPLICITLY viewable — declared once, never repeated', () => {
    const n = normalizeProjection({ form: FORM })
    // 'name'/'amount' appear only in editable, yet they are visible
    expect([...(n.fields as Set<string>)].sort()).toEqual(['amount', 'name', 'stage'])
    expect([...n.edit].sort()).toEqual(['amount', 'name'])
    expect(n.explicit).toBe(true)
    const sentiments = n.include['notes']!.include['sentiments']!
    expect([...(sentiments.fields as Set<string>)].sort()).toEqual(['label', 'score'])
    expect([...sentiments.edit]).toEqual(['score'])
  })

  it('viewable-only and editable-only nodes are both legal', () => {
    const viewOnly = normalizeProjection({ form: { viewable: ['a', 'b'] } })
    expect([...(viewOnly.fields as Set<string>)].sort()).toEqual(['a', 'b'])
    expect([...viewOnly.edit]).toEqual([])
    const editOnly = normalizeProjection({ form: { editable: ['a'] } })
    expect([...(editOnly.fields as Set<string>)]).toEqual(['a'])
    expect([...editOnly.edit]).toEqual(['a'])
  })

  it('legacy expose/permit/include desugars losslessly (non-explicit, * children)', () => {
    const n = normalizeProjection({
      get: { expose: ['name', 'stage'], include: [{ notes: ['reactions'] }, 'brief'] },
      update: { permit: ['name'] },
    })
    expect(n.explicit).toBeUndefined()
    expect([...(n.fields as Set<string>)].sort()).toEqual(['name', 'stage'])
    expect([...n.edit]).toEqual(['name'])
    expect(n.include['notes']!.fields).toBe('*')
    expect(n.include['notes']!.include['reactions']!.fields).toBe('*')
    expect(n.include['brief']!.fields).toBe('*')
  })

  it('a node with neither array throws a teaching error naming the shape', () => {
    expect(() => normalizeProjection({ form: {} }))
      .toThrow(/editable and\/or viewable arrays/)
    expect(() => normalizeProjection({ form: { viewable: ['a'], include: { notes: {} } } }))
      .toThrow(/'notes'[\s\S]*editable and\/or viewable/)
  })
})

describe('@crud desugar — form: populates every legacy reader', () => {
  @controller('/loans')
  @crud(class Loan {} as any, { form: FORM as any })
  class LoanController {}

  it('expose/permit/include derived; node stashed; abilities on', () => {
    const cfg: any = getCrudMeta(LoanController)!.config
    expect(cfg.get.expose.sort()).toEqual(['amount', 'name', 'stage'])
    expect(cfg.get.abilities).toBe(true)
    expect(cfg.update.permit.sort()).toEqual(['amount', 'name'])
    expect(cfg.create.permit.sort()).toEqual(['amount', 'name'])
    expect(cfg.get.include).toEqual([{ notes: ['sentiments'] }])
    expect(cfg[PROJECTION_NODE].explicit).toBe(true)
  })
})

describe('sliceByProjection — the eternal problem, read half', () => {
  const node = normalizeProjection({ form: FORM })
  const RECORD = {
    id: 1, name: 'Acme loan', amount: '500.00', stage: 'draft',
    secretMargin: 0.44,                                    // root secret
    notes: [
      { id: 7, body: 'call notes', position: 0, authorSsn: 'xxx',   // child secret
        sentiments: [
          { id: 70, label: 'positive', score: 0.9, rawVector: [1, 2, 3] },  // grandchild secret
        ] },
      { id: 8, body: 'b', position: 1, authorSsn: 'yyy', sentiments: [] },
    ],
  }

  it('slices EVERY level: root secret, child secret, grandchild secret all gone', () => {
    const out = sliceByProjection(RECORD, node)
    expect(out).toEqual({
      id: 1, name: 'Acme loan', amount: '500.00', stage: 'draft',
      notes: [
        { id: 7, body: 'call notes', position: 0,
          sentiments: [{ id: 70, label: 'positive', score: 0.9 }] },
        { id: 8, body: 'b', position: 1, sentiments: [] },
      ],
    })
  })

  it('null/absent children and star nodes pass through', () => {
    const legacy = normalizeProjection({ get: { include: ['notes'] } })
    const data = { id: 1, anything: true, notes: [{ id: 7, whatever: 1 }] }
    expect(sliceByProjection(data, legacy)).toEqual(data)   // '*' everywhere = identity
    expect(sliceByProjection({ id: 1, name: 'x', notes: null }, node))
      .toEqual({ id: 1, name: 'x', notes: null })
  })

  it('nodeToIncludeSpecs round-trips the tree for the eager loader', () => {
    expect(nodeToIncludeSpecs(node)).toEqual([{ notes: ['sentiments'] }])
  })
})

describe('end-to-end: the envelope serves the sliced graph', () => {
  it('a form-declared door envelope carries sliced children at every depth', () => {
    @controller('/loans2')
    @crud(class Loan2 {} as any, { form: FORM as any })
    class Loan2Controller {}
    const cfg: any = getCrudMeta(Loan2Controller)!.config

    const record = {
      id: 1, name: 'n', amount: '5', stage: 'draft', secretMargin: 1,
      notes: [{ id: 7, body: 'b', position: 0, authorSsn: 'x',
        sentiments: [{ id: 70, label: 'pos', score: 1, rawVector: [] }] }],
      toJSON({ only }: { only: string[] }) {
        const o: any = {}
        for (const k of only) if (k in this) o[k] = (this as any)[k]
        return o
      },
    }
    const env = buildRecordEnvelope(record, { name: 'Loan2' } as any, cfg, {}, {})
    expect(env.record).toEqual({
      id: 1, name: 'n', amount: '5', stage: 'draft',
      notes: [{ id: 7, body: 'b', position: 0,
        sentiments: [{ id: 70, label: 'pos', score: 1 }] }],
    })
    // and the abilities derived from the SAME tree (root level, P1)
    expect(env.abilities).toMatchObject({ name: 'edit', amount: 'edit', stage: 'view' })
  })
})
