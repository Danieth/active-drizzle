/**
 * COMPILE-TIME assertions for the red-squiggle machinery (ModelFieldNames):
 * every `@ts-expect-error` line FAILS THE TYPECHECK if the squiggle ever
 * stops firing. Run via `npm run test:types` (tsc --noEmit over this file).
 *
 * Not part of the vitest suite — there is nothing to run; the compiler is
 * the test runner.
 */
import { crud } from '../src/decorators.js'
import type { ModelFieldNames } from '../src/metadata.js'

// A "generated-augmentation-shaped" model: typed columns + methods.
class Deal {
  id!: number
  name!: string
  amount!: string
  stage!: 'draft' | 'submitted' | 'won'
  save!: () => Promise<boolean>
  isDraft!: () => boolean
}

// ── ModelFieldNames extracts columns, drops methods ──────────────────────────
type F = ModelFieldNames<typeof Deal>
const ok: F = 'name'
// @ts-expect-error — methods are not fields
const bad1: F = 'save'
// @ts-expect-error — typo'd field
const bad2: F = 'naem'
void ok; void bad1; void bad2

// ── the vice: typo'd config keys are COMPILE errors ──────────────────────────
crud(Deal, {
  index: {
    sortable: ['name', 'amount'],
    searchable: ['name'],
    facets: ['stage'],
    measures: ['amount'],
    defaultSort: { field: 'name', dir: 'asc' },
    search: { fields: { name: 'A', amount: 'B' } },
    // named filters stay UNCONSTRAINED — product concepts, not columns
    filters: { bigDeals: { apply: (rel: any) => rel } },
  },
  get: { expose: ['name', 'stage'] },
  update: { permit: ['name'] },
  create: { permit: (_ctx, _ctrl) => ['name', 'amount'], autoSet: { amount: () => '0' } },
})

crud(Deal, {
  // @ts-expect-error — 'naem' is not a Deal field
  index: { sortable: ['naem'] },
})

crud(Deal, {
  // @ts-expect-error — methods never reach an allowlist
  get: { expose: ['save'] },
})

crud(Deal, {
  // @ts-expect-error — permit is vice-gripped too
  update: { permit: ['stgae'] },
})

crud(Deal, {
  // @ts-expect-error — even the FUNCTION form's return is checked
  update: { permit: () => ['not-a-field'] },
})

crud(Deal, {
  // @ts-expect-error — autoSet keys are fields
  create: { autoSet: { organizatoinId: () => 1 } },
})

crud(Deal, {
  // @ts-expect-error — search weights key on real columns
  index: { search: { fields: { naem: 'A' } } },
})

// ── graceful degradation: untyped models stay permissive ─────────────────────
crud(class Untyped {} as any, {
  index: { sortable: ['anything', 'goes'] },   // F widens to string — no errors
  update: { permit: ['whatever'] },
})
