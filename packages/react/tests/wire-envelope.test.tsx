/**
 * Columnar wire envelope — client-half contract (transport WS2).
 *
 * mergeEnvelope is the ONE decoder for the server's ONE serializer
 * (buildColumnarEnvelope): these tests pin the k/v/r zip → Rule M merge
 * threading (versions via merge opts, never as cells), the touched→floor
 * destroy lane, the PURE nested recomposition (RecordEnvelope / IndexResult
 * shapes — P6), `_key` stitching from meta.nestedKeys, and the live
 * store-materialized projection (useProjectedRows — the one documented P6
 * deviation: rows update as fresher merges land).
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, act } from '@testing-library/react'
import { EntityStore, lastSeenOf, isGone, visibleFields } from '../src/entity-store.js'
import {
  mergeEnvelope,
  mergeRecordEnvelope,
  mergeIndexEnvelope,
  useProjectedRows,
  type WireSpec,
  type WireEnvelope,
} from '../src/wire-envelope.js'

/** Await the store's coalesced notification flush (one per microtask). */
const flush = () => new Promise<void>(r => queueMicrotask(r))

/** A store with the kinds a flagged door's _entities.gen would register. */
function makeStore(): EntityStore {
  const s = new EntityStore()
  s.registerFieldKinds('loans', { noteIds: 'pkArray' })
  s.registerFieldKinds('notes', {})
  s.registerFieldKinds('users', {})
  return s
}

/** The get-tree spec codegen emits for loans → notes → author. */
const loanSpec: WireSpec = {
  table: 'loans',
  pk: 'id',
  includes: [
    {
      name: 'notes', table: 'notes', kind: 'hasMany', fk: 'loanId', idsColumn: 'noteIds',
      includes: [{ name: 'author', table: 'users', kind: 'belongsTo', fk: 'authorId' }],
    },
  ],
}

/** A representative 2-level show envelope: one loan, two notes, one author. */
function showEnvelope(): WireEnvelope {
  return {
    membership: { pks: [1] },
    entities: {
      loans: {
        k: ['id', 'title', 'stage', 'brokerId', 'noteIds'],
        v: [7],
        r: [[1, 'Bridge loan', 'review', 9, [11, 12]]],
      },
      notes: {
        k: ['id', 'body', 'loanId', 'authorId'],
        v: [3, 4],
        r: [[11, 'first', 1, 21], [12, 'second', 1, 21]],
      },
      users: {
        k: ['id', 'name'],
        v: [null],
        r: [[21, 'Dana']],
      },
    },
    version: '7',
    abilities: { title: 'edit' },
    can: { update: true },
    ctx: { tz: 'UTC' },
  }
}

describe('mergeEnvelope', () => {
  it('zips k/v/r per table into per-row version-threaded merges (M1)', () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())

    const loan = s.get('loans', 1)!
    expect(visibleFields(loan)).toEqual({ id: 1, title: 'Bridge loan', stage: 'review', brokerId: 9, noteIds: [11, 12] })
    expect(lastSeenOf(loan, 'title')).toBe(7)

    const note = s.get('notes', 12)!
    expect(visibleFields(note)).toEqual({ id: 12, body: 'second', loanId: 1, authorId: 21 })
    expect(lastSeenOf(note, 'body')).toBe(4)

    // v[i] = null → the untracked arrival-order lane (renders, never current)
    const user = s.get('users', 21)!
    expect(visibleFields(user)).toEqual({ id: 21, name: 'Dana' })
    expect(lastSeenOf(user, 'name')).toBeNull()
  })

  it('a stale envelope never regresses a fresher cell (per-field join)', () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope()) // title at token 7
    mergeEnvelope(s, {
      membership: { pks: [1] },
      entities: { loans: { k: ['id', 'title'], v: [5], r: [[1, 'OLD title']] } },
    })
    expect(visibleFields(s.get('loans', 1)!)['title']).toBe('Bridge loan')

    mergeEnvelope(s, {
      membership: { pks: [1] },
      entities: { loans: { k: ['id', 'title'], v: [8], r: [[1, 'NEW title']] } },
    })
    expect(visibleFields(s.get('loans', 1)!)['title']).toBe('NEW title')
  })

  it('touched destroy with a token raises the floor (M2 — no resurrection)', () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    mergeEnvelope(s, { touched: [{ resource: 'loans', id: 1, op: 'destroy', version: 9 }] })
    expect(isGone(s.get('loans', 1)!)).toBe(true)

    // A late pre-destroy payload cannot resurrect (T2)
    mergeEnvelope(s, {
      membership: { pks: [1] },
      entities: { loans: { k: ['id', 'title'], v: [8], r: [[1, 'zombie']] } },
    })
    expect(isGone(s.get('loans', 1)!)).toBe(true)
  })

  it('touched destroy with version null takes the legacy remove() lane', () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    mergeEnvelope(s, { touched: [{ resource: 'users', id: 21, op: 'destroy', version: null }] })
    expect(s.get('users', 21)).toBeUndefined()
    // No floor was invented — a later payload re-admits (today's semantics)
    mergeEnvelope(s, {
      membership: { pks: [21] },
      entities: { users: { k: ['id', 'name'], v: [null], r: [[21, 'Dana']] } },
    })
    expect(visibleFields(s.get('users', 21)!)['name']).toBe('Dana')
  })

  it('ignores non-envelope shapes without throwing', () => {
    const s = makeStore()
    expect(() => {
      mergeEnvelope(s, null)
      mergeEnvelope(s, undefined)
      mergeEnvelope(s, { success: true } as any)
    }).not.toThrow()
    expect(s.size).toBe(0)
  })
})

describe('mergeRecordEnvelope', () => {
  it('recomposes the nested RecordEnvelope shape — P6, FormSession untouched', () => {
    const s = makeStore()
    const env = showEnvelope()
    const out = mergeRecordEnvelope(s, env, loanSpec)

    expect(out.record).toEqual({
      id: 1, title: 'Bridge loan', stage: 'review', brokerId: 9,
      notes: [
        { id: 11, body: 'first', loanId: 1, authorId: 21, author: { id: 21, name: 'Dana' } },
        { id: 12, body: 'second', loanId: 1, authorId: 21, author: { id: 21, name: 'Dana' } },
      ],
    })
    // idsColumn is wire linkage, not a nested-lane field
    expect('noteIds' in out.record).toBe(false)
    // verdict passengers ride through verbatim
    expect(out.version).toBe('7')
    expect(out.abilities).toEqual({ title: 'edit' })
    expect(out.can).toEqual({ update: true })
    expect(out.ctx).toEqual({ tz: 'UTC' })
    // …and the store learned every row on the way through
    expect(visibleFields(s.get('notes', 11)!)['body']).toBe('first')
  })

  it('stitches _key from meta.nestedKeys (created-row adoption)', () => {
    const s = makeStore()
    const env = showEnvelope()
    env.meta = { nestedKeys: { notes: { '12': 'k_temp42' } } }
    const out = mergeRecordEnvelope(s, env, loanSpec)
    expect(out.record.notes[1]._key).toBe('k_temp42')
    expect(out.record.notes[0]._key).toBeUndefined()
    // a transport passenger — NEVER a merged cell
    expect('_key' in visibleFields(s.get('notes', 12)!)).toBe(false)
  })

  it('recomposes hasOne through the child-side FK', () => {
    const s = makeStore()
    const spec: WireSpec = {
      table: 'loans', pk: 'id',
      includes: [{ name: 'appraisal', table: 'appraisals', kind: 'hasOne', fk: 'loanId' }],
    }
    const out = mergeRecordEnvelope(s, {
      membership: { pks: [1] },
      entities: {
        loans: { k: ['id', 'title'], v: [2], r: [[1, 'Bridge loan']] },
        appraisals: { k: ['id', 'loanId', 'value'], v: [5], r: [[31, 1, '250000.00']] },
      },
    }, spec)
    expect(out.record.appraisal).toEqual({ id: 31, loanId: 1, value: '250000.00' })
  })

  it('passes non-envelope responses through unchanged', () => {
    const s = makeStore()
    const plain = { id: 1, title: 'not columnar' }
    expect(mergeRecordEnvelope(s, plain, loanSpec)).toBe(plain)
    expect(mergeRecordEnvelope(s, null, loanSpec)).toBeNull()
  })
})

describe('mergeIndexEnvelope', () => {
  it('recomposes the nested IndexResult shape in membership order', () => {
    const s = makeStore()
    const env: WireEnvelope = {
      membership: {
        pks: [2, 1],
        pagination: { page: 0, hasMore: false },
        facets: { stage: { review: 2 } },
      },
      entities: {
        loans: { k: ['id', 'title'], v: [7, 6], r: [[1, 'A'], [2, 'B']] },
      },
      ctx: { tz: 'UTC' },
    }
    const out = mergeIndexEnvelope(s, env, { table: 'loans', pk: 'id', includes: [] })
    expect(out).toEqual({
      data: [{ id: 2, title: 'B' }, { id: 1, title: 'A' }],
      pagination: { page: 0, hasMore: false },
      facets: { stage: { review: 2 } },
      ctx: { tz: 'UTC' },
    })
    expect(lastSeenOf(s.get('loans', 2)!, 'title')).toBe(6)
  })

  it('applies the index include tree to every row', () => {
    const s = makeStore()
    const env = showEnvelope()
    const out = mergeIndexEnvelope(s, env, loanSpec)
    expect(out.data).toHaveLength(1)
    expect(out.data[0].notes.map((n: any) => n.id)).toEqual([11, 12])
    expect('noteIds' in out.data[0]).toBe(false)
  })

  it('passes non-envelope responses through unchanged', () => {
    const s = makeStore()
    const plain = { data: [], pagination: { page: 0 } }
    expect(mergeIndexEnvelope(s, plain, loanSpec)).toBe(plain)
  })
})

describe('useProjectedRows', () => {
  const FIELDS = ['id', 'title', 'stage', 'noteIds']

  function Probe({ store, pks, spec }: { store: EntityStore; pks: Array<number | string>; spec?: WireSpec }) {
    const rows = useProjectedRows('loans', pks, FIELDS, spec, store)
    return <pre data-testid="out">{JSON.stringify(rows)}</pre>
  }

  const readOut = (container: HTMLElement): any =>
    JSON.parse(container.querySelector('[data-testid="out"]')!.textContent!)

  it('materializes door-masked rows, parallel to pks (missing pk → null slot)', async () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    // secret is OUTSIDE this door's mask — union storage, per-door projection
    s.merge('loans', 1, { secret: 'other-door' }, { version: 7 })
    await flush() // drain the coalesced notify queued by setup merges
    const { container } = render(<Probe store={s} pks={[1, 999]} />)
    const rows = readOut(container)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 1, title: 'Bridge loan', stage: 'review', noteIds: [11, 12] })
    expect(rows[1] ?? null).toBeNull() // undefined serializes to null
  })

  it('re-nests hasMany + belongsTo per spec, removing the idsColumn', async () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    await flush()
    const { container } = render(<Probe store={s} pks={[1]} spec={loanSpec} />)
    const [row] = readOut(container)
    expect(row.noteIds).toBeUndefined()
    expect(row.notes.map((n: any) => n.id)).toEqual([11, 12])
    expect(row.notes[0].author).toEqual({ id: 21, name: 'Dana' })
  })

  it('masks CHILD rows to the spec\'s per-child fields (§3a corollary — an access-ceiling door never renders another door\'s columns)', async () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    // a WIDER door merged a column this door never received on its own wire
    s.merge('notes', 11, { internalComment: 'admin eyes only' }, { version: 3 })
    s.merge('users', 21, { email: 'dana@secret.example' })
    await flush()
    const maskedSpec: WireSpec = {
      table: 'loans', pk: 'id',
      includes: [{
        name: 'notes', table: 'notes', kind: 'hasMany', fk: 'loanId', idsColumn: 'noteIds',
        fields: ['id', 'body'],
        includes: [{ name: 'author', table: 'users', kind: 'belongsTo', fk: 'authorId', fields: ['id', 'name'] }],
      }],
    }
    const { container } = render(<Probe store={s} pks={[1]} spec={maskedSpec} />)
    const [row] = readOut(container)
    expect(row.notes[0]).toEqual({ id: 11, body: 'first', author: { id: 21, name: 'Dana' } })
    expect('internalComment' in row.notes[0]).toBe(false)
    expect('email' in row.notes[0].author).toBe(false)
    // a spec WITHOUT child fields keeps legacy whole-row children
    const { container: c2 } = render(<Probe store={s} pks={[1]} spec={loanSpec} />)
    expect(readOut(c2)[0].notes[0].internalComment).toBe('admin eyes only')
  })

  it('rows update LIVE as fresher merges land (the documented P6 deviation)', async () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    await flush()
    const { container } = render(<Probe store={s} pks={[1]} spec={loanSpec} />)
    expect(readOut(container)[0].title).toBe('Bridge loan')

    await act(async () => {
      s.merge('loans', 1, { title: 'Renamed' }, { version: 8 })
      await flush()
    })
    expect(readOut(container)[0].title).toBe('Renamed')

    // a CHILD merge re-renders too — the projection subscribed to it
    await act(async () => {
      s.merge('notes', 11, { body: 'edited elsewhere' }, { version: 9 })
      await flush()
    })
    expect(readOut(container)[0].notes[0].body).toBe('edited elsewhere')

    // stale merges change nothing (M1 holds under the projection)
    await act(async () => {
      s.merge('loans', 1, { title: 'zombie' }, { version: 5 })
      await flush()
    })
    expect(readOut(container)[0].title).toBe('Renamed')
  })

  it('a destroyed record drops to an empty slot; a destroyed child drops from its list', async () => {
    const s = makeStore()
    mergeEnvelope(s, showEnvelope())
    await flush()
    const { container } = render(<Probe store={s} pks={[1]} spec={loanSpec} />)
    expect(readOut(container)[0].notes).toHaveLength(2)

    await act(async () => {
      s.destroy('notes', 11, 10)
      await flush()
    })
    expect(readOut(container)[0].notes.map((n: any) => n.id)).toEqual([12])

    await act(async () => {
      s.destroy('loans', 1, 10)
      await flush()
    })
    expect(readOut(container)[0] ?? null).toBeNull()
  })

  it('subscriptions pin projected rows against LRU eviction', async () => {
    const s = new EntityStore({ capacity: 2 })
    s.registerFieldKinds('loans', { noteIds: 'pkArray' })
    s.merge('loans', 1, { id: 1, title: 'keep', stage: 'x', noteIds: [] }, { version: 1 })
    await flush()
    render(<Probe store={s} pks={[1]} />)
    await act(async () => { await flush() })
    // flood the store past capacity — the mounted key survives
    await act(async () => {
      for (let i = 100; i < 110; i++) s.merge('loans', i, { id: i, title: `t${i}` }, { version: 1 })
      await flush()
    })
    expect(s.get('loans', 1)).toBeDefined()
  })
})
