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

// Upload hooks
export {
  useUploadFactory,
  useMultiUploadFactory,
  type UploadStatus,
  type UploadFileInfo,
  type AssetData,
  type CtrlAttachmentMeta,
  type UploadEndpoints,
  type UseUploadReturn,
  type UseUploadOptions,
  type MultiUploadSlot,
  type UseMultiUploadReturn,
  type UseMultiUploadOptions,
} from './upload.js'
