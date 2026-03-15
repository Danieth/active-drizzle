import { sql } from 'drizzle-orm'
import { defineModelConcern } from '../define-model-concern.js'
import type { Relation } from '../../runtime/relation.js'

export interface SoftDeletableConfig {
  columnName?: string
}

export const SoftDeletable = defineModelConcern<SoftDeletableConfig | void>({
  name: 'SoftDeletable',

  configure(config) {
    if (!config) config = {}
    if (!config.columnName) config.columnName = 'deletedAt'
    return config
  },

  defaultScope(q: Relation) {
    const colUrl = (this as any).__concern_config?.SoftDeletable?.columnName ?? 'deletedAt'
    return q.where({ [colUrl]: null })
  },

  scopes: {
    withDeleted(this: any) {
      return this.unscoped('SoftDeletable')
    },
    
    onlyDeleted(this: any) {
      const colName = this.__concern_config?.SoftDeletable?.columnName ?? 'deletedAt'
      return this.unscoped('SoftDeletable').where({ [colName]: sql`is not null` })
    }
  },

  methods: {
    async restore(this: any) {
      const colName = (this.constructor as any).__concern_config?.SoftDeletable?.columnName ?? 'deletedAt'
      this[colName] = null
      return await this.save()
    }
  },

  getters: {
    isDeleted(this: any): boolean {
      const colName = (this.constructor as any).__concern_config?.SoftDeletable?.columnName ?? 'deletedAt'
      return this[colName] !== null && this[colName] !== undefined
    }
  },

  overrides: {
    destroy: 'soft'
  },
  
  pure: ['isDeleted']
})
