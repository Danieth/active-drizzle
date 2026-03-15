import { describe, it, expect } from 'vitest'
import { Sluggable } from '../../src/concerns/builtin/sluggable.js'
import { include } from '../../src/concerns/include.js'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { model } from '../../src/runtime/decorators.js'

@model('articles')
@include(Sluggable)
class Article extends ApplicationRecord {}

@model('categories')
@include(Sluggable, { sourceField: 'name', slugField: 'urlName' })
class Category extends ApplicationRecord {}

describe('Sluggable concern', () => {
  it('supplies callbacks, name, and configuration', () => {
    expect(Sluggable.def.name).toBe('Sluggable')
    expect(Sluggable.def.callbacks?.beforeValidate).toBeDefined()
  })

  it('generates a slug from the default source field during validation', async () => {
    const article = new Article({ title: 'Hello World!' })
    await article.validate()
    expect((article as any).slug).toBe('hello-world')
  })

  it('does not overwrite an explicit slug', async () => {
    const article = new Article({ title: 'Hello World!', slug: 'custom-slug' })
    await article.validate()
    expect((article as any).slug).toBe('custom-slug')
  })

  it('uses configured fields for source and destination', async () => {
    const cat = new Category({ name: 'Décor & Furniture' })
    await cat.validate()
    expect((cat as any).urlName).toBe('decor-furniture')
  })
})
