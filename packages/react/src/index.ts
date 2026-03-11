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

// UI components
export {
  ModelCombobox,
  SearchBar,
  IntersectionTrigger,
  ScopeToggle,
  type ComboboxOption,
  type ComboboxConfig,
  type ModelComboboxProps,
  type SearchBarProps,
  type IntersectionTriggerProps,
  type ScopeToggleProps,
} from './components.js'
