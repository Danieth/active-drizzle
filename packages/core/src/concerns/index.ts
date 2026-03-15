// Factory
export { defineModelConcern } from './define-model-concern.js'
export type { ModelConcernDef, ModelConcern } from './define-model-concern.js'

// @include decorator for models
export { include, CONCERN_META } from './include.js'
export type { ConcernMeta } from './include.js'

// Built-in model concerns
export { SoftDeletable }   from './builtin/soft-deletable.js'
export { Sluggable }       from './builtin/sluggable.js'
export { Publishable }     from './builtin/publishable.js'
export { Trackable }       from './builtin/trackable.js'

export type { SoftDeletableConfig } from './builtin/soft-deletable.js'
export type { SluggableConfig }     from './builtin/sluggable.js'
export type { PublishableConfig }   from './builtin/publishable.js'
export type { TrackableConfig }     from './builtin/trackable.js'
