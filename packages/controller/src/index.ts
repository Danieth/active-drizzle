// Errors
export {
  HttpError,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  ValidationError,
  Conflict,
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
  rescue,
  attachable,
  inferControllerPath,
  type HookConfig,
  type ActionConfig,
  type RescueConfig,
} from './decorators.js'

// Config types
export type {
  SearchAdapter,
  CrudConfig,
  SingletonConfig,
  IndexConfig,
  WriteConfig,
  ScopeEntry,
  MutationEntry,
  ActionEntry,
  HookEntry,
  RescueEntry,
  AttachableConfig,
} from './metadata.js'

// Router
export { buildRouter, mergeRouters, type BuildResult, type RouteRecord } from './router.js'
export { buildContractProbes, runContractProbes, type ContractProbe, type ContractProbeFailure } from './contract-probes.js'

// Handlers (useful for custom overrides)
export {
  defaultIndex,
  defaultGet,
  defaultCreate,
  defaultUpdate,
  defaultDestroy,
  singletonFindOrCreate,
  convertFilterValue,
  buildRecordEnvelope,
  enforceMutationRules,
  buildSearchDoc,
  type RecordEnvelope,
  type IndexResult,
  type IndexParams,
  type PaginationResult,
} from './crud-handlers.js'
