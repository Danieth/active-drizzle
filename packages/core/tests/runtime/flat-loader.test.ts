/**
 * Flat include loading — refusal surface (the teaching errors) and include
 * normalization. The happy-path loading behavior (batched queries, order
 * clauses, query counts, serializer parity) is pinned end-to-end in
 * packages/controller/tests/columnar-parity.test.ts against real Postgres.
 */
import { describe, it, expect } from 'vitest'
import {
  ApplicationRecord,
  MODEL_REGISTRY,
  model as modelDecorator,
  hasMany,
  belongsTo,
  habtm,
} from '../../src/runtime/index.js'
import {
  normalizeIncludeSpecs,
  resolveIncludableAssociation,
} from '../../src/runtime/flat-loader.js'
import { resolveWireAssociation } from '../../src/runtime/application-record.js'

Object.keys(MODEL_REGISTRY).forEach(k => delete (MODEL_REGISTRY as any)[k])

@modelDecorator('fl_users')
class FlUser extends ApplicationRecord {}
void FlUser

@modelDecorator('fl_notes')
class FlNote extends ApplicationRecord {
  static author = belongsTo('fl_users', { foreignKey: 'authorId' })
}
void FlNote

@modelDecorator('fl_loans')
class FlLoan extends ApplicationRecord {
  static notes    = hasMany('fl_notes', { order: { position: 'asc' } })
  static tags     = habtm('fl_loan_tags')
  static comments = hasMany('fl_notes', { through: 'fl_note_links' })
  static owner    = belongsTo({ polymorphic: true })
  static broker   = belongsTo('fl_users', { foreignKey: 'brokerId' })
}

describe('normalizeIncludeSpecs', () => {
  it('lowers strings and nested objects, preserving grandchildren', () => {
    expect(normalizeIncludeSpecs(['notes', { notes: ['author'] }], 'Loan')).toEqual([
      { name: 'notes', children: [] },
      { name: 'notes', children: ['author'] },
    ])
  })

  it('refuses raw drizzle configs with a teaching error naming the alternatives', () => {
    expect(() => normalizeIncludeSpecs([{ notes: { where: {}, limit: 5 } }], 'Loan'))
      .toThrow(/raw drizzle config.*wire: 'nested'/s)
  })
})

describe('resolveWireAssociation', () => {
  it('resolves the identity space, fk, pk, and ids key', () => {
    expect(resolveWireAssociation(FlLoan, 'notes')).toMatchObject({
      kind: 'hasMany',
      targetTable: 'fl_notes',
      foreignKey: 'fl_loanId',
      primaryKey: 'id',
      idsKey: 'noteIds',
    })
    expect(resolveWireAssociation(FlLoan, 'broker')).toMatchObject({
      kind: 'belongsTo',
      targetTable: 'fl_users',
      foreignKey: 'brokerId',
    })
  })

  it('returns null for non-associations and polymorphic belongsTo', () => {
    expect(resolveWireAssociation(FlLoan, 'nope')).toBeNull()
    expect(resolveWireAssociation(FlLoan, 'owner')).toBeNull()
  })
})

describe('resolveIncludableAssociation — the columnar refusals teach', () => {
  it('habtm: give it its own door (or the ids column)', () => {
    expect(() => resolveIncludableAssociation(FlLoan, 'tags'))
      .toThrow(/habtm.*own paged door.*tagIds/s)
  })

  it('hasMany-through: join-table batching is a later phase', () => {
    expect(() => resolveIncludableAssociation(FlLoan, 'comments'))
      .toThrow(/hasMany-through.*own paged door/s)
  })

  it('polymorphic belongsTo: no fixed identity space', () => {
    expect(() => resolveIncludableAssociation(FlLoan, 'owner'))
      .toThrow(/POLYMORPHIC.*no fixed identity space/s)
  })

  it('an unregistered target names the import-for-side-effects fix', () => {
    expect(() => resolveIncludableAssociation(FlLoan, 'ghosts'))
      .toThrow(/does not resolve to an\s+association/s)
  })
})
