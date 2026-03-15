import { describe, it, expect } from 'vitest'
import { Trackable } from '../../src/concerns/builtin/trackable.js'

describe('Trackable concern', () => {
  it('has a name of "Trackable"', () => {
    expect(Trackable.def.name).toBe('Trackable')
  })

  it('registers beforeCreate and beforeUpdate callbacks', () => {
    expect(Trackable.def.callbacks?.beforeCreate).toBeDefined()
    expect(Trackable.def.callbacks?.beforeUpdate).toBeDefined()
  })

  it('configures createdByField and updatedByField with defaults', () => {
    const config = Trackable.def.configure?.({})
    expect(config?.createdByField).toBe('createdById')
    expect(config?.updatedByField).toBe('updatedById')
  })

  it('allows overriding field names', () => {
    const config = Trackable.def.configure?.({ createdByField: 'authorId', updatedByField: 'editorId' })
    expect(config?.createdByField).toBe('authorId')
    expect(config?.updatedByField).toBe('editorId')
  })
})
