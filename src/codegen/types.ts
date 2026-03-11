/**
 * Shared types describing the intermediate representation (IR) that
 * the extractor produces and the validator/generator consume.
 *
 * The IR is a plain-data description of what the codegen found in your
 * model files — fully serializable, easy to snapshot-test.
 */

export type ColumnType =
  // Integers
  | 'integer' | 'smallint' | 'bigint'
  | 'serial'  | 'smallserial' | 'bigserial'
  // Floats / decimals
  | 'real' | 'doublePrecision' | 'decimal' | 'numeric'
  // Strings
  | 'text' | 'varchar' | 'char' | 'citext' | 'uuid'
  // Boolean
  | 'boolean'
  // Date / time
  | 'date' | 'timestamp' | 'timestamptz' | 'time' | 'interval'
  // JSON
  | 'json' | 'jsonb'
  // Binary
  | 'bytea'
  // Network
  | 'inet' | 'cidr' | 'macaddr' | 'macaddr8'
  // Full-text search
  | 'tsvector' | 'tsquery'
  // Bit strings
  | 'bit' | 'varbit'
  // Misc
  | 'xml' | 'money' | 'oid'
  // Geometry (PostGIS / Drizzle-geometry)
  | 'point' | 'line' | 'lseg' | 'box' | 'path' | 'polygon' | 'circle' | 'geometry'
  // pgvector extension
  | 'vector'
  // Native Postgres enum (pgEnum column)
  | 'pgEnum'
  // Fallbacks
  | 'array'   // legacy: bare .array() with no base type detected
  | 'unknown'

export type ColumnMeta = {
  name: string            // camelCase (from Drizzle schema)
  dbName: string          // snake_case (actual db column)
  type: ColumnType
  nullable: boolean
  hasDefault: boolean
  primaryKey: boolean
  /** True when .array() is chained — the TypeScript type becomes T[]. */
  isArray: boolean
  /**
   * True for generatedAlwaysAsIdentity() / generatedByDefaultAsIdentity() columns.
   * These are never included in Create/Update types — the database assigns them.
   */
  isGenerated: boolean
  /**
   * For type === 'pgEnum': the string literal values of the Postgres enum.
   * e.g. pgEnum('role', ['admin', 'user']) → ['admin', 'user']
   * null for all other column types.
   */
  pgEnumValues: string[] | null
}

export type TableMeta = {
  name: string          // e.g. 'assets'
  columns: ColumnMeta[]
}

/** Everything the extractor finds about a schema file */
export type SchemaMeta = {
  tables: Record<string, TableMeta>  // keyed by table name
  filePath: string
}

export type AssociationKind = 'belongsTo' | 'hasMany' | 'hasOne' | 'habtm'

export type AssociationMeta = {
  kind: AssociationKind
  propertyName: string          // e.g. 'business'
  resolvedTable: string | null  // e.g. 'businesses' (null = unresolved)
  explicitTable: string | null  // explicit first arg if provided
  foreignKey: string | null
  primaryKey: string | null
  through: string | null
  order: Record<string, 'asc' | 'desc'> | null
  polymorphic: boolean
  acceptsNested: boolean        // generates ${name}Attributes in Create/Update types
  options: Record<string, unknown>
}

export type EnumMeta = {
  propertyName: string          // e.g. 'assetType'
  values: Record<string, number>
}

export type EnumGroupMeta = {
  propertyName: string          // e.g. 'images'
  enumField: string             // e.g. 'assetType'
  range: [number, number]
}

export type ScopeMeta = {
  name: string
  parameters: Array<{ name: string; type: string }>
  isZeroArg: boolean
  isComputed: boolean   // @computed — returns data, not a Relation
  thisRefs: string[]    // `this.X` identifiers found in body, for validator cross-check
}

export type HookMeta = {
  decorator: string             // e.g. 'beforeSave'
  methodName: string
  condition: string | null
  on: 'create' | 'update' | null
}

export type InstanceMethodMeta = {
  name: string
  returnType: string
  parameters: Array<{ name: string; type: string }>
  isServerOnly: boolean
  isValidation: boolean
  body?: string         // method body text (e.g. "{ return this.x + 1 }") — undefined if server-only
}

/** Everything the extractor finds about a single model file */
export type ModelMeta = {
  className: string             // e.g. 'Asset'
  tableName: string             // from @model('assets')
  filePath: string
  extendsClass: string          // 'ApplicationRecord' or another model name
  isSti: boolean                // true if extendsClass !== 'ApplicationRecord'
  stiParent: string | null
  associations: AssociationMeta[]
  enums: EnumMeta[]
  enumGroups: EnumGroupMeta[]
  scopes: ScopeMeta[]
  hooks: HookMeta[]
  instanceMethods: InstanceMethodMeta[]
  propertyValidations: Record<string, string> // propertyName -> validation function source
  propertyDefaults: Record<string, string>    // propertyName -> default value source (JS expression)
  attrSetReturnTypes: Record<string, string>  // propertyName -> inferred return type of set() fn (e.g. 'number', 'string')
}

/** The full picture: schema + all models, ready for validation + generation */
export type ProjectMeta = {
  schema: SchemaMeta
  models: ModelMeta[]
}

/** An error or warning emitted by the validator */
export type DiagnosticSeverity = 'error' | 'warning'

export type Diagnostic = {
  severity: DiagnosticSeverity
  modelFile: string
  message: string
  suggestion?: string
}
