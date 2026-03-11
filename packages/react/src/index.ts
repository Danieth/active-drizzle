// Client model + cache keys
export {
  ClientModel,
  modelCacheKeys,
  type PaginationMeta,
  type ModelIndexResult,
  type ModelCacheKeys,
} from './client-model.js'

// Hook factories
export {
  createModelHook,
  createSingletonHook,
  createSearchHook,
  type SearchState,
  type UseSearchReturn,
  type CrudHookConfig,
  type SingletonHookConfig,
  type UseCrudReturn,
} from './hooks.js'

// Error utilities
export {
  parseControllerError,
  applyFormErrors,
  type ParsedControllerError,
} from './errors.js'
