// Validators — re-exported so generated controller Clients can import the
// Validates factories from the package they already depend on
export { Validates, isBlank } from '@active-drizzle/core/validators'

// Client model + cache keys
export {
  ClientModel,
  modelCacheKeys,
  recordOf,
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

// Forms — FormSession, presenter registry, callable field handles
export {
  FormSession,
  type Ability,
  type SessionStatus,
  type ServerEnvelope,
  type SubmitResult,
  type SubmitPayload,
  type FormSessionOptions,
} from './form-session.js'
export {
  registerPresenter,
  setDefaultPresenters,
  getPresenter,
  clearPresenters,
  resolvePresenter,
  type AdPresenterKinds,
  type PresenterNameFor,
  type PresenterProps,
  type PresenterDef,
  type PresenterBind,
  type ResolvedPresenter,
} from './presenters.js'
export {
  createFormHandle,
  type FormHandle,
  type FormHandleApi,
  type FieldComponent,
  type FieldProps,
  type TypedFieldProps,
  type TypedFieldComponent,
  type ArrayFieldHandle,
  type OneFieldHandle,
  type NestedFormHandle,
} from './form-handle.js'
export { NestedArrayManager, NestedOneManager, type NestedChild, type NestedTransport } from './nested.js'
export { useForm, useEditForm, useNewForm, type UseFormOptions } from './use-form.js'
export { useGeneratedForm, type UseGeneratedFormOptions } from './generated-form.js'

// Error utilities
export {
  parseControllerError,
  applyFormErrors,
  onClientError,
  reportClientError,
  handleControllerError,
  type ParsedControllerError,
  type ClientErrorHandler,
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
