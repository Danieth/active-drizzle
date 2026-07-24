export * from './runtime/index.js'
// Concerns — the WHOLE system rides the main entry: the `include` decorator
// alone is useless without the builtins and defineModelConcern (previously
// only reachable via a subpath the package exports map didn't even expose)
export * from './concerns/index.js'
export * from './storage/storage.js'
export { AssetService, type CreateFromServiceInput } from './services/asset-service.js'
export { runAssetCleanup, type AssetCleanupOptions } from './tasks/asset-cleanup-task.js'
export {
  defineConfig, loadConfig, resolveConfig, mergeConfig, resetConfig,
  type TrailsConfig, type TrailsConfigFile, type ChannelsConfig,
} from './config.js'
export { processAsset, type ProcessResult } from './tasks/asset-process-task.js'
export { scaffoldPresenterTree, collectKindsInUse, type ScaffoldResult, type KindUsage } from './codegen/presenter-scaffold.js'
