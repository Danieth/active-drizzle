// Factory
export { defineControllerConcern } from './define-controller-concern.js'
export type { ControllerConcernDef, ControllerConcern } from './define-controller-concern.js'

// @includeInController decorator
export { includeInController, CONTROLLER_CONCERN_META } from './include-in-controller.js'
export type { ControllerConcernMeta } from './include-in-controller.js'

// Built-in controller concerns
export { Searchable } from './builtin/searchable.js'

export type { SearchableConfig } from './builtin/searchable.js'
