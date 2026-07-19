/**
 * Regression: `static name = Attr.string(...)` shadows the class's built-in
 * `.name` with an Attr config object. Static fields initialize before class
 * decorators run, so @model used to register such classes under the key
 * "[object Object]" — colliding across models and silently breaking every
 * class-name-based lookup: STI subclass resolution, polymorphic belongsTo,
 * and association inference fallbacks.
 *
 * These tests pin the fix: the declared class name is recovered (from the
 * class source text) and stamped as `_activeDrizzleClassName`, and all
 * lookups go through modelClassName().
 */

import { describe, it, expect } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot, MODEL_REGISTRY } from '../../src/runtime/boot.js'
import { Relation } from '../../src/runtime/relation.js'
import { model } from '../../src/runtime/decorators.js'
import { belongsTo } from '../../src/runtime/markers.js'
import { Attr } from '../../src/runtime/attr.js'
import { modelClassName } from '../../src/runtime/class-name.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeTable(cols: string[]): Record<string, any> {
  const t: Record<string, any> = {}
  for (const c of cols) t[c] = { columnName: c, _name: c }
  return t
}

function makeDb(rowsByTable: Record<string, any[]>) {
  const findManyFor = (table: string) => async (_cfg: any) => rowsByTable[table] ?? []
  const query: Record<string, any> = {}
  for (const table of Object.keys(rowsByTable)) {
    query[table] = { findMany: findManyFor(table) }
  }
  const chainMock: any = {
    from: () => chainMock,
    where: () => chainMock,
    orderBy: () => chainMock,
    limit: () => chainMock,
    offset: () => chainMock,
    then: (res: any) => res([]),
  }
  return { query, select: () => chainMock, transaction: (cb: any) => cb({}) } as any
}

// ── Models under test — every one shadows `.name` with an Attr ───────────────

const schema = {
  shadow_users: fakeTable(['id', 'name']),
  shadow_notes: fakeTable(['id', 'name', 'notableId', 'notableType']),
  shadow_messages: fakeTable(['id', 'type', 'name']),
}

@model('shadow_users')
class ShadowUser extends ApplicationRecord {
  static name = Attr.string()
}

@model('shadow_notes')
class ShadowNote extends ApplicationRecord {
  static name = Attr.string()
  static notable = belongsTo({ polymorphic: true })
}

@model('shadow_messages')
class ShadowMessage extends ApplicationRecord {
  static name = Attr.string()
}

@model('shadow_messages')
class ShadowEmail extends ShadowMessage {
  static stiType = 'ShadowEmail'
}

@model('shadow_messages')
class ShadowSms extends ShadowMessage {
  static stiType = 'ShadowSms'
}

// ── modelClassName() ─────────────────────────────────────────────────────────

describe('modelClassName', () => {
  it('returns .name when nothing shadows it', () => {
    class Plain {}
    expect(modelClassName(Plain)).toBe('Plain')
  })

  it('recovers the declared name when static name = Attr shadows it', () => {
    class Sneaky {
      static name = Attr.string()
    }
    expect(typeof (Sneaky as any).name).not.toBe('string')
    expect(modelClassName(Sneaky)).toBe('Sneaky')
  })

  it('prefers the name stamped by @model', () => {
    expect(modelClassName(ShadowUser)).toBe('ShadowUser')
    expect((ShadowUser as any)._activeDrizzleClassName).toBe('ShadowUser')
  })

  it('does not let a subclass inherit the parent stamp', () => {
    class Child extends ShadowUser {}
    expect(modelClassName(Child)).toBe('Child')
  })

  it('returns "" for non-functions', () => {
    expect(modelClassName(null)).toBe('')
    expect(modelClassName({ name: 'x' })).toBe('')
  })
})

// ── Registration ─────────────────────────────────────────────────────────────

describe('@model registration with a shadowed name', () => {
  it('registers under the declared class name, not "[object Object]"', () => {
    expect(MODEL_REGISTRY['ShadowUser']).toBe(ShadowUser)
    expect(MODEL_REGISTRY['ShadowNote']).toBe(ShadowNote)
    expect(MODEL_REGISTRY['ShadowEmail']).toBe(ShadowEmail)
    expect(MODEL_REGISTRY['ShadowSms']).toBe(ShadowSms)
    expect(MODEL_REGISTRY['[object Object]']).toBeUndefined()
  })

  it('honors an explicit className option', () => {
    @model('shadow_customs', { className: 'RenamedModel' })
    class Irrelevant extends ApplicationRecord {
      static name = Attr.string()
    }
    expect(MODEL_REGISTRY['RenamedModel']).toBe(Irrelevant)
    expect(modelClassName(Irrelevant)).toBe('RenamedModel')
  })

  it('tableName does not crash on a shadowed undecorated class', () => {
    class Loose extends ApplicationRecord {
      static name = Attr.string()
    }
    expect((Loose as any).tableName).toBe('loose')
  })
})

// ── STI resolution ───────────────────────────────────────────────────────────

describe('STI with shadowed names', () => {
  it('instantiates the right subclass for each row when querying the parent', async () => {
    const rows = [
      { id: 1, type: 'ShadowEmail', name: 'e' },
      { id: 2, type: 'ShadowSms', name: 's' },
      { id: 3, type: null, name: 'base' },
    ]
    boot(makeDb({ shadow_messages: rows }), schema)

    const results = await new Relation(ShadowMessage).load()

    expect(results[0]).toBeInstanceOf(ShadowEmail)
    expect(results[1]).toBeInstanceOf(ShadowSms)
    expect(results[2]).toBeInstanceOf(ShadowMessage)
  })
})

// ── Polymorphic belongsTo ────────────────────────────────────────────────────

describe('polymorphic belongsTo with a shadowed owner class', () => {
  it('resolves <prop>Type = declared class name to the right model', async () => {
    boot(makeDb({ shadow_users: [{ id: 7, name: 'Dana' }] }), schema)

    const note = new ShadowNote({ id: 1, notableId: 7, notableType: 'ShadowUser' }, false)
    const notable = await (note as any).notable

    expect(notable).toBeInstanceOf(ShadowUser)
    expect(notable._attributes.id).toBe(7)
  })
})
