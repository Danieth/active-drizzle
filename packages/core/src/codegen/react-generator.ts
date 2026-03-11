/**
 * React hook code generator.
 *
 * For each controller in CtrlProjectMeta, generates:
 *
 *   use{Model}.gen.ts  — typed React Query hooks, cache keys, and a ClientModel
 *                        subclass that is fully type-safe in two dimensions:
 *
 *   1. READ safety  — TAttrs is derived from the Drizzle schema columns PLUS any
 *                     associations the controller eager-loads via `include: [...]`.
 *                     Enum columns are typed with string-literal unions (not raw
 *                     integers) because Attr.enum translates values at the ORM layer.
 *
 *   2. WRITE safety — TWrite is a Pick<TAttrs, permittedFields> derived from the
 *                     controller's `create` and `update` permit lists. Calling
 *                     `.set({ id: 99 })` or `.set({ createdAt: new Date() })` is a
 *                     compile-time error — those fields are not in the permit list.
 *
 *   3. INCLUDE types — When a controller says `get: { include: ['creator'] }`, the
 *                      generator looks up the 'creator' association on the model,
 *                      finds its target model (e.g. User), and imports + references
 *                      `UserAttrs` in the generated CampaignAttrs interface. This
 *                      means `campaign.creator?.email` is fully typed.
 */
import { join } from 'path'
import pluralize from 'pluralize'
import type { CtrlProjectMeta, CtrlMeta } from './controller-types.js'
import type { ProjectMeta, ModelMeta, AssociationMeta, ColumnMeta } from './types.js'

export function generateReactHooks(
  ctrlProject: CtrlProjectMeta,
  projectMeta: ProjectMeta | null,
  outputDir: string,
): Array<{ filePath: string; content: string }> {
  const files: Array<{ filePath: string; content: string }> = []

  for (const ctrl of ctrlProject.controllers) {
    if (ctrl.kind === 'plain' || !ctrl.modelClass) continue

    const model = projectMeta?.models.find(m => m.className === ctrl.modelClass) ?? null
    const content = generateHookFile(ctrl, model, projectMeta, outputDir)

    files.push({
      filePath: join(outputDir, `use${ctrl.modelClass}.gen.ts`),
      content,
    })
  }

  return files
}

// ── Main file generator ───────────────────────────────────────────────────────

function generateHookFile(
  ctrl: CtrlMeta,
  model: ModelMeta | null,
  projectMeta: ProjectMeta | null,
  _outputDir: string,
): string {
  const modelName  = ctrl.modelClass!
  const hookName   = `use${modelName}s`
  const resourceName = ctrl.basePath.split('/').pop()?.replace(/:[^/]*/g, '').replace(/\/+$/, '')
    ?? pluralize(lcFirst(modelName))

  // ── Columns from schema ───────────────────────────────────────────────────
  const columns: ColumnMeta[] = model && projectMeta
    ? (projectMeta.schema.tables[model.tableName]?.columns ?? [])
    : []

  // ── Enum map: propertyName → string-literal union (e.g. "'draft' | 'active'") ──
  const enumByProp = new Map<string, string>()
  if (model) {
    for (const e of model.enums) {
      const union = Object.keys(e.values).map(k => `'${k}'`).join(' | ')
      enumByProp.set(e.propertyName, union)
    }
  }

  // ── Scope fields (from @scope decorators) ────────────────────────────────
  const scopeFields = ctrl.scopes.map(s => s.field)
  const scopeType   = scopeFields.length > 0
    ? `{ ${scopeFields.map(f => `${f}: number`).join('; ')} }`
    : 'Record<string, never>'

  // ── Collect all includes across every CRUD operation ─────────────────────
  // Union of get + index includes so TAttrs covers all possible server shapes.
  const allIncludes = new Set<string>([
    ...(ctrl.crudConfig?.get?.include ?? []),
    ...(ctrl.crudConfig?.index?.include ?? []),
  ])

  // ── Resolve each include to its target model ─────────────────────────────
  // For `include: ['creator']`:
  //   1. find `creator` in model.associations
  //   2. get resolvedTable → 'users'
  //   3. find the ModelMeta with tableName === 'users' → className 'User'
  //   4. emit `import type { UserAttrs } from './useUser.gen'`
  //   5. emit `creator?: UserAttrs` in CampaignAttrs
  //
  // For hasMany the shape is an array: `posts?: PostAttrs[]`
  const assocImports: Array<{ assocName: string; attrsType: string; isArray: boolean }> = []

  for (const includeName of allIncludes) {
    const assoc = model?.associations.find(a => a.propertyName === includeName) ?? null
    if (!assoc) {
      assocImports.push({ assocName: includeName, attrsType: 'Record<string, any>', isArray: false })
      continue
    }

    const targetModelClass = resolveAssocModel(assoc, projectMeta)
    const isArray = assoc.kind === 'hasMany' || assoc.kind === 'habtm'

    if (targetModelClass) {
      assocImports.push({
        assocName:  includeName,
        attrsType:  `${targetModelClass}Attrs`,
        isArray,
      })
    } else {
      assocImports.push({ assocName: includeName, attrsType: 'Record<string, any>', isArray })
    }
  }

  // Distinct model classes that need an import (exclude self)
  const externalAttrsTypes = [...new Set(
    assocImports
      .map(a => a.attrsType)
      .filter(t => t !== 'Record<string, any>' && t !== `${modelName}Attrs`),
  )]

  // ── Permit lists → TWrite ─────────────────────────────────────────────────
  const createPermit = ctrl.crudConfig?.create?.permit ?? []
  const updatePermit = ctrl.crudConfig?.update?.permit ?? []
  const writableFields = [...new Set([...createPermit, ...updatePermit])]

  // ── Lines buffer ──────────────────────────────────────────────────────────
  const L: string[] = []

  L.push('// AUTO-GENERATED — DO NOT EDIT')
  L.push('// Source: active-drizzle react codegen')
  L.push('')
  L.push(`import { createModelHook, createSearchHook, modelCacheKeys, ClientModel } from '@active-drizzle/react'`)
  L.push(`import type { SearchState } from '@active-drizzle/react'`)

  // Cross-model association imports
  for (const attrsType of externalAttrsTypes) {
    const srcModel = attrsType.replace(/Attrs$/, '')
    L.push(`import type { ${attrsType} } from './use${srcModel}.gen'`)
  }

  L.push('')
  L.push('// Replace with your actual oRPC client:')
  L.push("// import { client } from '../lib/orpc-client'")
  L.push('')

  // ── TAttrs interface ──────────────────────────────────────────────────────
  L.push('/**')
  L.push(' * All fields the backend may return for this model.')
  L.push(' * Columns are typed from the Drizzle schema; enum columns use string labels')
  L.push(' * (not raw integers) because Attr.enum translates at the ORM layer.')
  if (allIncludes.size) {
    L.push(` * Association fields (marked optional) come from include: [${[...allIncludes].map(i => `'${i}'`).join(', ')}].`)
  }
  L.push(' */')
  L.push(`export interface ${modelName}Attrs {`)

  if (columns.length > 0) {
    for (const col of columns) {
      const tsType = columnToClientType(col, enumByProp)
      L.push(`  ${col.name}${col.nullable ? '?' : ''}: ${tsType}`)
    }
  } else {
    // No schema metadata available — minimal placeholder
    L.push('  id: number')
    L.push('  [key: string]: any')
  }

  // Eager-loaded association fields
  if (assocImports.length) {
    L.push('')
    L.push('  // Eager-loaded associations (from controller include config)')
    for (const ai of assocImports) {
      const shape = ai.isArray ? `${ai.attrsType}[]` : ai.attrsType
      L.push(`  ${ai.assocName}?: ${shape}`)
    }
  }

  L.push('}')
  L.push('')

  // ── TWrite type ───────────────────────────────────────────────────────────
  if (writableFields.length > 0) {
    L.push('/**')
    L.push(' * Only the fields the backend accepts for create/update.')
    L.push(' * Derived from the controller permit list — attempting to `.set()` any')
    L.push(' * other field (id, createdAt, scope fields, etc.) is a compile-time error.')
    L.push(' */')
    L.push(`export type ${modelName}Write = Pick<${modelName}Attrs, ${writableFields.map(f => `'${f}'`).join(' | ')}>`)
    L.push('')
  } else {
    // No permit list — write type is empty (read-only model)
    L.push(`export type ${modelName}Write = Record<string, never>`)
    L.push('')
  }

  // ── ClientModel subclass ──────────────────────────────────────────────────
  L.push(`export class ${modelName}Client extends ClientModel<${modelName}Attrs, ${modelName}Write> {`)

  // Declare all columns so TypeScript sees them (they're set via Object.assign in constructor)
  if (columns.length > 0) {
    L.push('  // Column declarations — TypeScript visibility for Object.assign in constructor')
    for (const col of columns) {
      const tsType = columnToClientType(col, enumByProp)
      L.push(`  declare ${col.name}${col.nullable ? '?' : ''}: ${tsType}`)
    }
  } else {
    L.push('  declare id: number')
  }

  // Declare association fields
  if (assocImports.length) {
    L.push('')
    L.push('  // Association declarations')
    for (const ai of assocImports) {
      const shape = ai.isArray ? `${ai.attrsType}[]` : ai.attrsType
      L.push(`  declare ${ai.assocName}?: ${shape}`)
    }
  }

  // Enum predicate methods
  if (model?.enums.length) {
    L.push('')
    L.push('  // Enum predicates')
    for (const e of model.enums) {
      for (const label of Object.keys(e.values)) {
        L.push(`  ${lcFirst(e.propertyName)}Is${capitalize(label)}() { return this.${e.propertyName} === '${label}' }`)
      }
    }
  }

  L.push('}')
  L.push('')

  // ── Search state interface ────────────────────────────────────────────────
  const paramScopes  = ctrl.crudConfig?.index?.paramScopes ?? []
  const sortables    = ctrl.crudConfig?.index?.sortable ?? []

  L.push(`export interface ${modelName}SearchState extends SearchState {`)
  for (const ps of paramScopes) {
    L.push(`  ${ps}?: string`)
  }
  L.push('}')
  L.push('')

  // ── Cache keys ────────────────────────────────────────────────────────────
  L.push(`export const ${lcFirst(modelName)}Keys = modelCacheKeys<${scopeType}>('${resourceName}')`)
  L.push('')

  // ── Hook factory ──────────────────────────────────────────────────────────
  if (ctrl.kind === 'crud') {
    L.push(`export const ${hookName} = createModelHook<${modelName}Client, ${scopeType}>({`)
    L.push(`  keys: ${lcFirst(modelName)}Keys,`)
    L.push(`  // Wire to your oRPC client (replace the throw stubs):`)
    L.push(`  indexFn:   async (scopes, params)    => { throw new Error('Configure oRPC client') },`)
    L.push(`  getFn:     async (id, scopes)         => { throw new Error('Configure oRPC client') },`)
    L.push(`  createFn:  async (scopes, data)       => { throw new Error('Configure oRPC client') },`)
    L.push(`  updateFn:  async (id, scopes, data)   => { throw new Error('Configure oRPC client') },`)
    L.push(`  destroyFn: async (id, scopes)         => { throw new Error('Configure oRPC client') },`)
    if (ctrl.mutations.length > 0) {
      L.push(`  mutationFns: {`)
      for (const mut of ctrl.mutations) {
        const args = mut.bulk ? 'ids, scopes, data' : 'id, scopes, data'
        L.push(`    ${mut.method}: async (${args}) => { throw new Error('Configure oRPC client') },`)
      }
      L.push(`  },`)
    }
    L.push(`})`)
    L.push('')
  } else if (ctrl.kind === 'singleton') {
    L.push(`export const ${hookName} = createSingletonHook<${modelName}Client, ${scopeType}>({`)
    L.push(`  keys: ${lcFirst(modelName)}Keys,`)
    L.push(`  getFn:    async (scopes)       => { throw new Error('Configure oRPC client') },`)
    L.push(`  updateFn: async (scopes, data) => { throw new Error('Configure oRPC client') },`)
    if (ctrl.mutations.length > 0) {
      L.push(`  mutationFns: {`)
      for (const mut of ctrl.mutations) {
        L.push(`    ${mut.method}: async (scopes, data) => { throw new Error('Configure oRPC client') },`)
      }
      L.push(`  },`)
    }
    L.push(`})`)
    L.push('')
  }

  // ── Search hook ───────────────────────────────────────────────────────────
  if (ctrl.kind === 'crud' && ctrl.crudConfig?.index) {
    const idx         = ctrl.crudConfig.index
    const defaultScopes = idx.defaultScopes ?? []
    const defaultSort   = idx.defaultSort

    L.push(`export const use${modelName}Search = createSearchHook<${modelName}SearchState>({`)
    if (defaultScopes.length) L.push(`  scopes: ${JSON.stringify(defaultScopes)},`)
    if (defaultSort) {
      L.push(`  sort: { field: '${defaultSort.field}', dir: '${defaultSort.dir ?? 'asc'}' },`)
    }
    L.push(`  page: 0,`)
    L.push(`  perPage: ${idx.perPage ?? 25},`)
    L.push(`})`)
    L.push('')
  }

  // ── Form config (TanStack Form compatible) ────────────────────────────────
  if (ctrl.kind === 'crud' && createPermit.length > 0) {
    L.push(`/**`)
    L.push(` * Default values and enum options for TanStack Form.`)
    L.push(` * Pass to useForm({ ...${lcFirst(modelName)}FormConfig, onSubmit: ... })`)
    L.push(` */`)
    L.push(`export const ${lcFirst(modelName)}FormConfig = {`)
    L.push(`  defaultValues: {`)
    for (const field of createPermit) {
      const col = columns.find(c => c.name === field) ?? null
      L.push(`    ${field}: ${colDefaultValue(col, enumByProp.get(field))},`)
    }
    L.push(`  } satisfies Partial<${modelName}Write>,`)

    const enumPermitFields = createPermit.filter(f => enumByProp.has(f))
    if (enumPermitFields.length > 0) {
      L.push(`  enumOptions: {`)
      for (const field of enumPermitFields) {
        const enumVal = model?.enums.find(e => e.propertyName === field)
        if (enumVal) {
          const options = Object.keys(enumVal.values).map(k => ({ value: k, label: capitalize(k) }))
          L.push(`    ${field}: ${JSON.stringify(options)} as const,`)
        }
      }
      L.push(`  },`)
    }

    L.push(`} as const`)
    L.push('')
  }

  return L.join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Given an AssociationMeta, find the target model class name.
 * Strategy:
 *  1. Look for a ModelMeta whose tableName matches the resolved table.
 *  2. Fall back to singularize + capitalize the table name.
 */
function resolveAssocModel(
  assoc: AssociationMeta,
  projectMeta: ProjectMeta | null,
): string | null {
  const table = assoc.resolvedTable
  if (!table) return null

  // Direct match in known models
  const model = projectMeta?.models.find(m => m.tableName === table)
  if (model) return model.className

  // Heuristic: singularize the table name and capitalize
  try {
    return capitalize(pluralize.singular(table))
  } catch {
    return capitalize(table.replace(/s$/, ''))
  }
}

/**
 * Convert a schema ColumnMeta to a TypeScript type string.
 * Enum columns use their string-label union (from Attr.enum) rather than the
 * raw integer type that Drizzle sees in the schema.
 */
function columnToClientType(col: ColumnMeta, enumByProp: Map<string, string>): string {
  // Attr.enum overrides the raw schema type
  const enumUnion = enumByProp.get(col.name)
  if (enumUnion) return col.isArray ? `(${enumUnion})[]` : enumUnion

  // pgEnum (native Postgres enum column)
  if (col.pgEnumValues?.length) {
    const union = col.pgEnumValues.map(v => `'${v}'`).join(' | ')
    return col.isArray ? `(${union})[]` : union
  }

  const map: Record<string, string> = {
    integer: 'number', smallint: 'number', bigint: 'number',
    serial: 'number', smallserial: 'number', bigserial: 'number',
    real: 'number', doublePrecision: 'number', decimal: 'string', numeric: 'string',
    text: 'string', varchar: 'string', char: 'string', uuid: 'string', citext: 'string',
    boolean: 'boolean',
    date: 'string', timestamp: 'string', timestamptz: 'string',
    time: 'string', interval: 'string',
    json: 'unknown', jsonb: 'unknown',
    bytea: 'Buffer',
    inet: 'string', cidr: 'string', macaddr: 'string', macaddr8: 'string',
    tsvector: 'string', tsquery: 'string',
    bit: 'string', varbit: 'string',
    xml: 'string', money: 'string', oid: 'number',
    vector: 'number[]',
    point: '{ x: number; y: number }',
  }

  const base = map[col.type] ?? 'unknown'
  return col.isArray ? `${base}[]` : base
}

function colDefaultValue(col: ColumnMeta | null, enumUnion?: string): string {
  if (!col) return 'undefined'
  if (enumUnion) {
    // First enum label as default
    const first = enumUnion.split('|')[0]?.trim().replace(/'/g, '')
    return first ? `'${first}'` : 'undefined'
  }
  if (col.type === 'boolean') return 'false'
  if (['integer', 'smallint', 'bigint', 'serial', 'smallserial', 'bigserial',
       'real', 'doublePrecision'].includes(col.type)) return 'undefined'
  if (['text', 'varchar', 'char', 'uuid', 'citext'].includes(col.type)) return "''"
  if (['json', 'jsonb'].includes(col.type)) return 'null'
  return 'undefined'
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
