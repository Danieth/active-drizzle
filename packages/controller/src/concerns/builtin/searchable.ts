import { defineControllerConcern } from '../define-controller-concern.js'

export interface SearchableConfig {
  fields?: string[]
  paramName?: string
  minLength?: number
}

export const Searchable = defineControllerConcern<SearchableConfig | void>({
  name: 'Searchable',

  configure(config) {
    return {
      fields:    config?.fields    ?? ['title', 'name'],
      paramName: config?.paramName ?? 'q',
      minLength: config?.minLength ?? 1,
    }
  },

  before: [
    {
      method: 'applySearchScope',
      fn: async function applySearchScope(this: any) {
        const config = (this.constructor as any).__concern_config?.Searchable
        const paramName = config?.paramName ?? 'q'
        const minLength = config?.minLength ?? 1
        const searchFields = config?.fields ?? ['title', 'name']

        const query = (this.ctx?.input ?? this.input ?? {})[paramName]
        if (!query || query.length < minLength) return

        if (this.relation) {
          this.relation = this.relation.search(query, searchFields)
        }
      },
      only: ['index']
    }
  ],
})
