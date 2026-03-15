import { describe, it, expect } from 'vitest'
import { Publishable } from '../../src/concerns/builtin/publishable.js'
import { include } from '../../src/concerns/include.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { model } from '../../src/runtime/decorators.js'

@model('posts')
@include(Publishable)
class Post extends ApplicationRecord {}

describe('Publishable concern', () => {
  it('defines the expected scopes', () => {
    expect(Publishable.def.scopes?.published).toBeDefined()
    expect(Publishable.def.scopes?.draft).toBeDefined()
    expect(Publishable.def.scopes?.scheduled).toBeDefined()
  })

  it('defines publish, unpublish, and schedule methods', () => {
    expect(Publishable.def.methods?.publish).toBeDefined()
    expect(Publishable.def.methods?.unpublish).toBeDefined()
    expect(Publishable.def.methods?.schedule).toBeDefined()
  })

  it('defines isPublished and isDraft getters', () => {
    expect(Publishable.def.getters?.isPublished).toBeDefined()
    expect(Publishable.def.getters?.isDraft).toBeDefined()
  })

  it('configures stateField falling back to "state"', () => {
    const c = Publishable.def.configure?.({})
    expect(c?.stateField).toBe('state')
    
    const custom = Publishable.def.configure?.({ stateField: 'status' })
    expect(custom?.stateField).toBe('status')
  })

  it('isPublished getter reads the state field', () => {
    const post = new Post({ state: 'published' })
    expect((post as any).isPublished).toBe(true)
    expect((post as any).isDraft).toBe(false)
  })

  it('isDraft getter reads the state field', () => {
    const post = new Post({ state: 'draft' })
    expect((post as any).isPublished).toBe(false)
    expect((post as any).isDraft).toBe(true)
  })
})
