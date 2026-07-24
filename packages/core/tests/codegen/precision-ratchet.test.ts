/**
 * THE PRECISION RATCHET (Daniel: "elimination of unknown and any — our
 * tests ensure we are rock solid"). Three locks:
 *   1. COLUMN_TS_TYPE is exhaustive by `satisfies` (a new ColumnType
 *      member fails COMPILE until mapped) — this suite locks the VALUES:
 *      'unknown' only ever for the EXACT allowlist; adding one fails here.
 *   2. The silent fallthrough is dead: an unmapped type THROWS teaching.
 *   3. Ranges (the audit's type-lie 1b) are typed for real.
 */
import { describe, it, expect } from 'vitest'
import { COLUMN_TS_TYPE, columnToTsType } from '../../src/codegen/generator.js'

/** The DELIBERATE unknowns — each has a reason; growing this list is a
 *  design decision made in review, never an accident. */
const UNKNOWN_ALLOWLIST = new Set([
  'json', 'jsonb',      // arbitrary by nature; Attr.json narrows
  'geometry',           // PostGIS — shape depends on the geometry arg
  'unknown',            // the extractor's own fallback marker
  'array',              // legacy bare .array() — 'unknown[]'
])

describe('the precision ratchet', () => {
  it("'unknown' appears ONLY on the allowlist — the ratchet", () => {
    const offenders = Object.entries(COLUMN_TS_TYPE)
      .filter(([, ts]) => ts.includes('unknown'))
      .map(([col]) => col)
      .filter(col => !UNKNOWN_ALLOWLIST.has(col))
    expect(offenders).toEqual([])
    // and the allowlist is EXACT — an entry that stops being unknown gets
    // removed from the list (the ratchet tightens, never loosens)
    for (const col of UNKNOWN_ALLOWLIST) {
      expect((COLUMN_TS_TYPE as any)[col]).toContain('unknown')
    }
  })

  it("no 'any' anywhere in emitted column types", () => {
    for (const [col, ts] of Object.entries(COLUMN_TS_TYPE)) {
      expect(ts, `column type '${col}'`).not.toMatch(/\bany\b/)
    }
  })

  it('ranges are typed for real now (audit finding 1b, closed)', () => {
    for (const r of ['int4range', 'numrange', 'tstzrange', 'nummultirange']) {
      expect((COLUMN_TS_TYPE as any)[r]).toBe('string')   // raw driver repr — honest
    }
    expect(columnToTsType({ name: 'seats', type: 'int4range', nullable: true } as any))
      .toBe('string | null')
  })

  it('an unrecognized type THROWS teaching — silent unknown is dead', () => {
    expect(() => columnToTsType({ name: 'weird', type: 'hyperloglog', nullable: false } as any))
      .toThrow(/'weird'[\s\S]*'hyperloglog'[\s\S]*ColumnType \+[\s\S]*not an option anymore/)
  })

  it('pgEnum still emits the literal union', () => {
    expect(columnToTsType({ name: 'role', type: 'pgEnum', nullable: false, pgEnumValues: ['admin', 'member'] } as any))
      .toBe(`'admin' | 'member'`)
  })
})
