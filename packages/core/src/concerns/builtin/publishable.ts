import { defineModelConcern } from '../define-model-concern.js'

export interface PublishableConfig {
  stateField?: string
  publishedAtField?: string
}

export const Publishable = defineModelConcern<PublishableConfig | void>({
  name: 'Publishable',

  configure(config) {
    return {
      stateField: config?.stateField ?? 'state',
      publishedAtField: config?.publishedAtField ?? 'publishedAt'
    }
  },

  scopes: {
    published(this: any) {
      const f = this.__concern_config?.Publishable?.stateField ?? 'state'
      return this.where({ [f]: 'published' })
    },
    draft(this: any) {
      const f = this.__concern_config?.Publishable?.stateField ?? 'state'
      return this.where({ [f]: 'draft' })
    },
    scheduled(this: any) {
      const f = this.__concern_config?.Publishable?.stateField ?? 'state'
      return this.where({ [f]: 'scheduled' })
    }
  },

  methods: {
    async publish(this: any) {
      const config = (this.constructor as any).__concern_config?.Publishable
      const stateF = config?.stateField ?? 'state'
      const publishedAtF = config?.publishedAtField ?? 'publishedAt'
      
      this[stateF] = 'published'
      this[publishedAtF] = new Date()
      return await this.save()
    },

    async unpublish(this: any) {
      const config = (this.constructor as any).__concern_config?.Publishable
      const stateF = config?.stateField ?? 'state'
      const publishedAtF = config?.publishedAtField ?? 'publishedAt'
      
      this[stateF] = 'draft'
      this[publishedAtF] = null
      return await this.save()
    },

    async schedule(this: any, at: Date) {
      const config = (this.constructor as any).__concern_config?.Publishable
      const stateF = config?.stateField ?? 'state'
      
      this[stateF] = 'scheduled'
      this['scheduledAt'] = at
      return await this.save()
    }
  },

  getters: {
    isPublished(this: any): boolean {
      const f = (this.constructor as any).__concern_config?.Publishable?.stateField ?? 'state'
      return this[f] === 'published'
    },
    isDraft(this: any): boolean {
      const f = (this.constructor as any).__concern_config?.Publishable?.stateField ?? 'state'
      return this[f] === 'draft'
    }
  }
})
