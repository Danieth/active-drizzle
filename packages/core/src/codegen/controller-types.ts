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
  /** Eager-load specs — bare names or nested objects ({ notes: ['author'] }); nesting preserved. */
  include?: Array<string | Record<string, any>>
  perPage?: number
  maxPerPage?: number
}

export interface CtrlWriteConfig {
  permit?: string[]
  restrict?: string[]
  autoSet?: Record<string, string>   // field → context key (string description)
}

export interface CtrlCrudConfig {
  /**
   * `wire` literal — the per-door transport flag ('columnar' | 'nested',
   * default 'nested'). ONE extracted source drives BOTH the runtime
   * serializer branch (usesColumnar reads the same config object) and the
   * generated hook bodies, so server shape and client consumption can never
   * disagree. Feeds the columnar-doors codegen gate (expose required,
   * hasMany-include ⇒ optimisticLock, STI-divergence refusal).
   */
  wire?: string
  /**
   * The explicit `access:` ceiling, extracted structurally ({ editable?,
   * viewable?, include?: { name: <node> } }). At runtime @crud desugars it
   * into expose/permit/include; codegen reads the SOURCE form — the columnar
   * gate checks includes against it (W7/W8) and the react generator derives
   * per-child field masks from it.
   */
  access?: Record<string, any>
  index?: CtrlIndexConfig
  create?: CtrlWriteConfig
  update?: Omit<CtrlWriteConfig, 'autoSet'> & {
    /**
     * `update.optimisticLock` literal — `true` (the model's locking column)
     * or a column-name string. Feeds the cross-IR versioned-models pass
     * (O2/O14): the opted-in model must carry a well-shaped integer lock
     * column and a non-reusable pk lineage.
     */
    optimisticLock?: boolean | string
  }
  get?: {
    /** Eager-load specs — bare names or nested objects; nesting preserved. */
    include?: Array<string | Record<string, any>>
    /** Serialization ceiling — when present it IS the client projection. */
    expose?: string[]
    /** Forms envelope enabled ({ record, abilities, can, version }). */
    abilities?: boolean
  }
}

export interface CtrlMutationMeta {
  method: string
  bulk: boolean
  kebabPath: string     // URL path segment
  /** Declared payload param names — the button becomes an implicit mini-form. */
  params?: string[]
  /** Params the server 422s on when missing/blank. */
  required?: string[]
  /** Human label for the generated button. */
  label?: string | null
  /** Whether an `if:` guard is declared (its verdict rides the envelope can map). */
  guarded?: boolean
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

export interface CtrlAttachmentMeta {
  name: string              // 'logo', 'documents'
  kind: 'one' | 'many'
  accepts?: string          // 'image/*'
  maxSize?: number          // bytes
  max?: number              // only for 'many'
  access: 'public' | 'private'
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

  /** Whether @attachable() is present */
  attachable?: boolean

  /** @frontendContext keys with their CHECKER-DERIVED return types
   *  (inherited concern keys included, parent-first). Feeds the generated
   *  AdFrontendCtx augmentation — ctx.userType is typed at every call site. */
  frontendContext?: Array<{ key: string; type: string; owner: string }>

  /** Attachment declarations from the model (hasOneAttachment / hasManyAttachments) */
  attachments?: CtrlAttachmentMeta[]
}

export interface CtrlProjectMeta {
  controllers: CtrlMeta[]
}
