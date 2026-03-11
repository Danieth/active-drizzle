/**
 * IR types for the controller codegen.
 * Describes what the controller extractor reads from .ctrl.ts files.
 */

export interface CtrlScopeMeta {
  field: string          // 'teamId'
  resource: string       // 'teams'
  paramName: string      // 'teamId'
}

export interface CtrlIndexConfig {
  scopes?: string[]
  defaultScopes?: string[]
  paramScopes?: string[]
  sortable?: string[]
  defaultSort?: { field: string; dir: 'asc' | 'desc' }
  filterable?: string[]
  include?: string[]
  perPage?: number
  maxPerPage?: number
}

export interface CtrlWriteConfig {
  permit?: string[]
  restrict?: string[]
  autoSet?: Record<string, string>   // field → context key (string description)
}

export interface CtrlCrudConfig {
  index?: CtrlIndexConfig
  create?: CtrlWriteConfig
  update?: Omit<CtrlWriteConfig, 'autoSet'>
  get?: { include?: string[] }
}

export interface CtrlMutationMeta {
  method: string
  bulk: boolean
  kebabPath: string     // URL path segment
}

export interface CtrlActionMeta {
  method: string
  httpMethod: string
  path?: string
  /**
   * If true, the route includes /:id and the record is auto-loaded by id,
   * then passed as the first argument — mirrors @mutation behavior.
   */
  load: boolean
  /**
   * TypeScript type text of the method's first parameter.
   * Extracted from ts-morph — used to type the `.with()` caller and the
   * `useMutation` / `useQuery` input in `.use()`.
   * null when the method has no parameters or the type couldn't be inferred.
   */
  inputType: string | null
  /**
   * Unwrapped return type text (Promise<T> → T).
   * Used to type the return value of `.with()` callers.
   * null when the return type couldn't be extracted.
   */
  outputType: string | null
}

export interface CtrlMeta {
  /** Absolute file path */
  filePath: string

  /** Class name (e.g. CampaignController) */
  className: string

  /** Inferred URL path (e.g. /campaigns) */
  basePath: string

  /** Parent class (e.g. TeamController — used for before hook inheritance) */
  parentClass?: string

  /** @scope decorators (outermost first) */
  scopes: CtrlScopeMeta[]

  /** Is this a @crud or @singleton controller? */
  kind: 'crud' | 'singleton' | 'plain'

  /** The model class name referenced in @crud or @singleton */
  modelClass?: string

  /** CRUD config (if kind === 'crud') */
  crudConfig?: CtrlCrudConfig

  /** Mutations defined with @mutation */
  mutations: CtrlMutationMeta[]

  /** Actions defined with @action */
  actions: CtrlActionMeta[]
}

export interface CtrlProjectMeta {
  controllers: CtrlMeta[]
}
