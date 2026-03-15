import { defineModelConcern } from '../define-model-concern.js'

export interface SluggableConfig {
  sourceField?: string
  slugField?: string
}

function generateSlug(text: string): string {
  if (!text) return ''
  return text
    .toString()
    .normalize('NFD') // split an accented letter in the base letter and the acent
    .replace(/[\u0300-\u036f]/g, '') // remove all previously split accents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 ]/g, '') // remove all chars not letters, numbers and spaces (to be replaced)
    .replace(/\s+/g, '-') // separator
}

export const Sluggable = defineModelConcern<SluggableConfig | void>({
  name: 'Sluggable',

  configure(config) {
    return {
      sourceField: config?.sourceField ?? 'title',
      slugField: config?.slugField ?? 'slug'
    }
  },

  callbacks: {
    beforeValidate: [
      function generateSlugBeforeValidate(this: any) {
        const config = (this.constructor as any).__concern_config?.Sluggable
        const source = config?.sourceField ?? 'title'
        const slugF = config?.slugField ?? 'slug'
        
        if (this[source] && !this[slugF]) {
          this[slugF] = generateSlug(this[source])
        }
      }
    ]
  }
})
