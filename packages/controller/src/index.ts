// Errors
export {
  HttpError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  ValidationError,
  toValidationError,
  serializeError,
} from './errors.js'

// Base class
export { ActiveController } from './base.js'

// Decorators
export {
  controller,
  scope,
  crud,
  singleton,
  mutation,
  action,
  before,
  after,
  inferControllerPath,
  type HookConfig,
} from './decorators.js'

// Config types
export type {
  CrudConfig,
  SingletonConfig,
  IndexConfig,
  WriteConfig,
  ScopeEntry,
  MutationEntry,
  ActionEntry,
  HookEntry,
} from './metadata.js'

// Router
export { buildRouter, mergeRouters, type BuildResult, type RouteRecord } from './router.js'

// Handlers (useful for custom overrides)
export {
  defaultIndex,
  defaultGet,
  defaultCreate,
  defaultUpdate,
  defaultDestroy,
  singletonFindOrCreate,
  convertFilterValue,
  type IndexResult,
  type IndexParams,
  type PaginationResult,
} from './crud-handlers.js'
