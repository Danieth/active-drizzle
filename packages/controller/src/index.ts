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
  frontendContext,
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
  FrontendContextMap,
} from './metadata.js'

// Router
export { buildRouter, mergeRouters, type BuildResult, type RouteRecord } from './router.js'
export {
  normalizeProjection, sliceByProjection, nodeToIncludeSpecs, PROJECTION_NODE,
  type ProjectionNode, type NormalizedNode, type Access,
} from './projection.js'
export { buildContractProbes, runContractProbes, type ContractProbe, type ContractProbeFailure } from './contract-probes.js'

// Controller-concern system (documented in LLM-GUIDE — must be reachable)
export {
  defineControllerConcern,
  includeInController,
  Searchable,
  CONTROLLER_CONCERN_META,
  type ControllerConcernDef,
  type ControllerConcern,
  type ControllerConcernMeta,
  type SearchableConfig,
} from './concerns/index.js'

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
  buildColumnarRecordEnvelope,
  computeEnvelopeVerdicts,
  enforceMutationRules,
  buildSearchDoc,
  type RecordEnvelope,
  type IndexResult,
  type IndexParams,
  type PaginationResult,
} from './crud-handlers.js'

// Columnar wire (transport WS2 — the per-door flagged envelope)
export {
  usesColumnar,
  buildColumnarEnvelope,
  type ColumnarEnvelope,
  type ColumnarTableSection,
  type ColumnarMembership,
  type ColumnarExtras,
} from './columnar-envelope.js'

// Validation path (transport WS3 — A2′'s three-way endpoint, O10 server side)
export {
  defaultValidate,
  validatableMask,
  registerColumnarDoorTransport,
  columnarDoorRegistry,
  columnarDoorFor,
  columnarDoorsForTable,
  resetColumnarDoorRegistry,
  type ValidateInput,
  type ValidateResult,
  type ValidatableMask,
  type ColumnarDoorTransportEntry,
} from './validate-handler.js'

// Channels (transport WS4 — gateway, emitter, bus tiers)
export {
  MemoryBus,
  PgNotifyBus,
  RedisBus,
  NatsBus,
  createBus,
  pgBouncerTeachingError,
  type ChannelBus,
  type BusCommitEvent,
  type BusListener,
  type PgNotifyBusOptions,
} from './channels/bus.js'
export {
  startChannelEmitter,
  recordChannel,
  indexChannel,
  indexChannelsFor,
  scopeHashOf,
  changeIntersectsMask,
  frameIncludeNames,
  buildChangeSliceBytes,
  destroySliceBytes,
  sliceBytesFromEnvelope,
  type ChangeSlice,
} from './channels/emitter.js'
export {
  attachChannels,
  type AttachChannelsOptions,
  type ChannelsHandle,
} from './channels/gateway.js'

// Membership lane (transport WS3 — O5 counter tags, structure tokens, O15 splice)
export {
  doorIdOf,
  membershipTagOf,
  structureTokenOf,
  attachStructureToken,
  paramsHashOf,
  buildSplice,
  applySplice,
  type SpliceOp,
  type SpliceResult,
} from './membership-tags.js'
