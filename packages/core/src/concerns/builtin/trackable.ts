import { defineModelConcern } from '../define-model-concern.js'

export interface TrackableConfig {
  createdByField?: string
  updatedByField?: string
  currentUserFn?: () => any
}

export const Trackable = defineModelConcern<TrackableConfig | void>({
  name: 'Trackable',

  configure(config) {
    return {
      createdByField: config?.createdByField ?? 'createdById',
      updatedByField: config?.updatedByField ?? 'updatedById',
      currentUserFn:  config?.currentUserFn ?? (() => null)
    }
  },

  callbacks: {
    beforeCreate: [
      async function trackCreatedBy(this: any) {
        const config = (this.constructor as any).__concern_config?.Trackable
        const createdByF = config?.createdByField ?? 'createdById'
        const updatedByF = config?.updatedByField ?? 'updatedById'
        const currentUser = await (config?.currentUserFn ?? (() => null))()
        if (currentUser) {
          if (!this[createdByF]) this[createdByF] = currentUser.id
          if (!this[updatedByF]) this[updatedByF] = currentUser.id
        }
      }
    ],
    beforeUpdate: [
      async function trackUpdatedBy(this: any) {
        const config = (this.constructor as any).__concern_config?.Trackable
        const updatedByF = config?.updatedByField ?? 'updatedById'
        const currentUser = await (config?.currentUserFn ?? (() => null))()
        if (currentUser) {
          this[updatedByF] = currentUser.id
        }
      }
    ]
  }
})
