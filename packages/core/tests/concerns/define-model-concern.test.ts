import { describe, it, expect } from 'vitest'
import { defineModelConcern } from '../../src/concerns/define-model-concern.js'

describe('defineModelConcern', () => {
  it('creates a concern object without mutating any class', () => {
    const concern = defineModelConcern({
      name: 'TestConcern',
      methods: {
        foo() { return 'bar' },
      },
    })

    expect(concern.__type).toBe('model_concern')
    expect(concern.name).toBe('TestConcern')
    expect(typeof concern.def.methods?.foo).toBe('function')
  })

  it('preserves the provided definition exactly', () => {
    const fn = (q: any) => q
    const cb = () => {}

    const concern = defineModelConcern({
      name: 'Full',
      scopes: { active: fn },
      callbacks: { beforeSave: cb },
      pure: ['isTest'],
    })

    expect(concern.def.scopes?.active).toBe(fn)
    expect(concern.def.callbacks?.beforeSave).toBe(cb)
    expect(concern.def.pure).toEqual(['isTest'])
  })
})
