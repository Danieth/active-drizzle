/**
 * computeCoherenceEdges — the statically-derived invalidation table
 * (DESIGN-cache-coherence §A + rev 5 write-effect edges).
 *
 * The BidCtrl case: mutating a proposal that TOUCHES its loan must
 * invalidate doors that embed LOANS (not proposals) — read edges alone
 * miss it; write-effect ∘ read composition catches it.
 */
import { describe, it, expect } from 'vitest'
import { computeCoherenceEdges } from '../../src/codegen/react-generator.js'
import type { CtrlProjectMeta } from '../../src/codegen/controller-types.js'
import type { ProjectMeta } from '../../src/codegen/types.js'

function model(className: string, tableName: string, associations: any[] = []): any {
  return { className, tableName, filePath: `/${className}.model.ts`, associations,
    enums: [], enumGroups: [], states: [], scopes: [], instanceMethods: [], fieldMeta: {} }
}
function assoc(kind: string, propertyName: string, resolvedTable: string, options: any = {}): any {
  return { kind, propertyName, resolvedTable, explicitTable: null, foreignKey: null,
    primaryKey: null, through: null, order: null, polymorphic: false,
    acceptsNested: Boolean(options.acceptsNested), options }
}
function ctrl(className: string, basePath: string, modelClass: string, include: any[] = []): any {
  return { className, basePath, modelClass, kind: 'crud', scopes: [], mutations: [], actions: [],
    filePath: `/${className}.ctrl.ts`,
    crudConfig: { get: { include, expose: ['id'], abilities: true }, update: { permit: [] } } }
}

const models = [
  model('Loan', 'loans', [
    assoc('hasMany', 'proposals', 'proposals', { counterCache: true }),
  ]),
  model('Proposal', 'proposals', [
    assoc('belongsTo', 'loan', 'loans', { touch: true }),
  ]),
  model('Bid', 'bids', [
    assoc('belongsTo', 'loan', 'loans'),
  ]),
]
const controllers = [
  ctrl('LoanController', '/loans', 'Loan', ['proposals']),
  ctrl('ProposalController', '/proposals', 'Proposal'),
  ctrl('BidController', '/bids', 'Bid', ['loan']),
]
const projectMeta = { schema: { tables: {}, filePath: '' }, models } as unknown as ProjectMeta
const ctrlProject = { controllers } as unknown as CtrlProjectMeta

describe('computeCoherenceEdges', () => {
  const edges = computeCoherenceEdges(ctrlProject, projectMeta)

  it('read edges: mutating a model invalidates its own doors AND embedding doors', () => {
    // proposals: own door + LoanController (includes proposals)
    expect(edges['proposals']).toContain('proposals')
    expect(edges['proposals']).toContain('loans')
  })

  it('WRITE-EFFECT transitivity (the BidCtrl case): proposal → touch loan → bids embed loans', () => {
    expect(edges['proposals']).toContain('bids')
  })

  it('counterCache is a write edge too: proposal mutations reach loan-embedding doors', () => {
    // (covered by touch above, but counterCache alone must also produce it)
    const cc = computeCoherenceEdges(
      { controllers } as any,
      { schema: { tables: {}, filePath: '' }, models: [
        model('Loan', 'loans', [assoc('hasMany', 'proposals', 'proposals', { counterCache: true })]),
        model('Proposal', 'proposals', [assoc('belongsTo', 'loan', 'loans')]),   // no touch
        model('Bid', 'bids', [assoc('belongsTo', 'loan', 'loans')]),
      ] } as any,
    )
    expect(cc['proposals']).toContain('bids')
  })

  it('no fabricated edges: loans mutations do NOT invalidate proposal-only doors', () => {
    // loans writes nothing toward proposals (no dependent/nested here),
    // and ProposalController embeds nothing loan-shaped
    expect(edges['loans']).not.toContain('proposals')
    expect(edges['loans']).toContain('loans')
    expect(edges['loans']).toContain('bids')     // bids embed loans
  })
})
