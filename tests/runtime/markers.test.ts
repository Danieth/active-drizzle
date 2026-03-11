/**
 * Markers tests — verifies the plain objects returned by belongsTo(),
 * hasMany(), etc. are correct. These are the simplest tests in the
 * whole project because markers are pure factory functions.
 *
 * Once we implement the runtime, these stay green and we add more.
 */

import { describe, it, expect } from 'vitest'
import {
  belongsTo,
  hasMany,
  hasOne,
  habtm,
  defineEnum,
  enumGroup,
} from '../../src/runtime/markers.js'

describe('belongsTo()', () => {
  it('creates a BelongsToMarker with no args', () => {
    const marker = belongsTo()
    expect(marker._type).toBe('belongsTo')
    expect(marker.table).toBeUndefined()
    expect(marker.options).toEqual({})
  })

  it('creates a BelongsToMarker with explicit table', () => {
    const marker = belongsTo('users')
    expect(marker.table).toBe('users')
  })

  it('creates a BelongsToMarker with foreignKey option', () => {
    const marker = belongsTo('users', { foreignKey: 'creatorId' })
    expect(marker.options.foreignKey).toBe('creatorId')
  })

  it('creates a BelongsToMarker with polymorphic option', () => {
    const marker = belongsTo(undefined, { polymorphic: true })
    expect(marker.options.polymorphic).toBe(true)
  })

  it('creates a BelongsToMarker with touch option', () => {
    const marker = belongsTo('posts', { touch: true })
    expect(marker.options.touch).toBe(true)
  })
})

describe('hasMany()', () => {
  it('creates a HasManyMarker with no args', () => {
    const marker = hasMany()
    expect(marker._type).toBe('hasMany')
    expect(marker.table).toBeUndefined()
    expect(marker.options).toEqual({})
  })

  it('creates a HasManyMarker with through option', () => {
    const marker = hasMany('responses', { through: 'templates' })
    expect(marker.options.through).toBe('templates')
  })

  it('creates a HasManyMarker with order option', () => {
    const marker = hasMany('items', { order: { index: 'asc' } })
    expect(marker.options.order).toEqual({ index: 'asc' })
  })

  it('creates a HasManyMarker with dependent option', () => {
    const marker = hasMany('comments', { dependent: 'destroy' })
    expect(marker.options.dependent).toBe('destroy')
  })

  it('creates a HasManyMarker with counterCache option', () => {
    const marker = hasMany('comments', { counterCache: true })
    expect(marker.options.counterCache).toBe(true)
  })

  it('accepts an options object as the first argument (no table name)', () => {
    // hasMany({ counterCache: true }) — shorthand when table is inferred from prop name
    const marker = hasMany({ counterCache: true, dependent: 'destroy' })
    expect(marker._type).toBe('hasMany')
    expect(marker.table).toBeUndefined()
    expect(marker.options).toEqual({ counterCache: true, dependent: 'destroy' })
  })
})

describe('hasOne()', () => {
  it('creates a HasOneMarker', () => {
    const marker = hasOne()
    expect(marker._type).toBe('hasOne')
  })

  it('creates a HasOneMarker with foreignKey', () => {
    const marker = hasOne('profiles', { foreignKey: 'userId' })
    expect(marker.table).toBe('profiles')
    expect(marker.options.foreignKey).toBe('userId')
  })

  it('accepts an options object as the first argument (no table name)', () => {
    // hasOne({ foreignKey: 'ownerId' }) — shorthand when table is inferred
    const marker = hasOne({ foreignKey: 'ownerId' })
    expect(marker._type).toBe('hasOne')
    expect(marker.table).toBeUndefined()
    expect(marker.options.foreignKey).toBe('ownerId')
  })
})

describe('habtm()', () => {
  it('creates a HabtmMarker', () => {
    const marker = habtm('bandwidth_phone_numbers')
    expect(marker._type).toBe('habtm')
    expect(marker.table).toBe('bandwidth_phone_numbers')
  })

  it('creates a HabtmMarker with explicit joinTable', () => {
    const marker = habtm('bandwidth_phone_numbers', { joinTable: 'bwpn_text_sends' })
    expect(marker.options.joinTable).toBe('bwpn_text_sends')
  })
})

describe('defineEnum()', () => {
  it('creates an EnumDefinition', () => {
    const def = defineEnum({ jpg: 116, png: 125, gif: 111 })
    expect(def._type).toBe('enum')
    expect(def.values).toEqual({ jpg: 116, png: 125, gif: 111 })
  })

  it('preserves all values exactly', () => {
    const values = { draft: 0, scheduled: 1, sending: 2, sent: 3, failed: 4 }
    const def = defineEnum(values)
    expect(def.values).toEqual(values)
  })
})

describe('enumGroup()', () => {
  it('creates an EnumGroupDefinition', () => {
    const group = enumGroup('assetType', [100, 199])
    expect(group._type).toBe('enumGroup')
    expect(group.enumField).toBe('assetType')
    expect(group.range).toEqual([100, 199])
  })

  it('stores both range endpoints', () => {
    const group = enumGroup('status', [0, 99])
    expect(group.range[0]).toBe(0)
    expect(group.range[1]).toBe(99)
  })
})
