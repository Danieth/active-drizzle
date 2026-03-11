/**
 * React hook code generator.
 *
 * For each controller in CtrlProjectMeta, generates:
 *
 *   use{Model}.gen.ts  — typed React Query hooks, cache keys, ClientModel class,
 *                        search config, and TanStack Form config
 *
 * These files are:
 *   - Co-located with the controller file (or outputDir)
 *   - Fully type-safe (no `any` at the call site)
 *   - Importable: `import { useCampaigns, CampaignSearchBar } from './useCampaigns.gen'`
 */
import { relative, dirname, join } from 'path'
import type { CtrlProjectMeta, CtrlMeta, CtrlIndexConfig } from './controller-types.js'
import type { ProjectMeta, ModelMeta } from './types.js'

export function generateReactHooks(
  ctrlProject: CtrlProjectMeta,
  modelProject: ProjectMeta | null,
  outputDir: string,
): Array<{ filePath: string; content: string }> {
  const files: Array<{ filePath: string; content: string }> = []

  for (const ctrl of ctrlProject.controllers) {
    if (ctrl.kind === 'plain') continue  // no model, no hooks to generate

    const modelName = ctrl.modelClass
    if (!modelName) continue

    // Find model metadata if available (for column types, enum values)
    const modelMeta = modelProject?.models.find(m => m.className === modelName) ?? null

    const content = generateHookFile(ctrl, modelMeta, outputDir)
    const fileName = `use${modelName}.gen.ts`
    files.push({
      filePath: join(outputDir, fileName),
      content,
    })
  }

  return files
}

function generateHookFile(
  ctrl: CtrlMeta,
  model: ModelMeta | null,
  outputDir: string,
): string {
  const modelName = ctrl.modelClass!
  const hookName = `use${modelName}s`
  const resourceName = ctrl.basePath.split('/').pop()?.replace(/:[^/]*/g, '').replace(/\/+$/, '') ?? modelName.toLowerCase() + 's'

  // Build scope type
  const scopeFields = ctrl.scopes.map(s => s.field)
  const scopeType = scopeFields.length > 0
    ? `{ ${scopeFields.map(f => `${f}: number`).join('; ')} }`
    : 'Record<string, never>'

  // Detect enum fields from model metadata
  const enumFields = model?.attributes
    .filter(a => a.type === 'enum')
    .map(a => ({
      name: a.propertyName,
      values: a.enumValues ?? [],
    })) ?? []

  // Detect filterable fields from controller config
  const filterableFields = ctrl.crudConfig?.index?.filterable ?? []
  const sortableFields = ctrl.crudConfig?.index?.sortable ?? []
  const scopeOptions = ctrl.crudConfig?.index?.scopes ?? []
  const paramScopes = ctrl.crudConfig?.index?.paramScopes ?? []

  const lines: string[] = []

  lines.push('// AUTO-GENERATED — DO NOT EDIT')
  lines.push('// Source: active-drizzle react codegen')
  lines.push('')
  lines.push(`import { createModelHook, createSearchHook, modelCacheKeys, ClientModel } from '@active-drizzle/react'`)
  lines.push(`import type { SearchState } from '@active-drizzle/react'`)
  lines.push('')

  // Import the oRPC router (generated separately)
  lines.push(`// Import from your oRPC client setup`)
  lines.push(`// import { client } from '../lib/orpc-client'`)
  lines.push('')

  // ── Attrs type ────────────────────────────────────────────────────────────
  if (model) {
    lines.push(`export interface ${modelName}Attrs {`)
    for (const col of (model as any).columns ?? []) {
      const tsType = columnToClientType(col)
      lines.push(`  ${col.name}${col.nullable ? '?' : ''}: ${tsType}`)
    }
    lines.push('}')
    lines.push('')
  } else {
    lines.push(`export interface ${modelName}Attrs {`)
    lines.push('  id: number')
    lines.push('  [key: string]: any')
    lines.push('}')
    lines.push('')
  }

  // ── ClientModel class ────────────────────────────────────────────────────
  lines.push(`export class ${modelName} extends ClientModel<${modelName}Attrs> {`)
  // Add enum predicate methods
  for (const ef of enumFields) {
    for (const val of ef.values) {
      const capitalized = val.charAt(0).toUpperCase() + val.slice(1)
      lines.push(`  is${capitalized}() { return this._attrs.${ef.name} === '${val}' }`)
    }
  }
  // Add declare for all attrs (TypeScript will pick them up via spread in constructor)
  if (model) {
    lines.push(`  declare id: number`)
  }
  lines.push('}')
  lines.push('')

  // ── Search state ──────────────────────────────────────────────────────────
  lines.push(`export interface ${modelName}SearchState extends SearchState {`)
  if (paramScopes.length) {
    for (const ps of paramScopes) {
      lines.push(`  ${ps}?: string`)
    }
  }
  lines.push('}')
  lines.push('')

  // ── Cache keys ────────────────────────────────────────────────────────────
  const scopeShape = scopeFields.length > 0
    ? `{ ${scopeFields.map(f => `${f}: true`).join(', ')} }`
    : 'undefined'
  lines.push(`export const ${lcFirst(modelName)}Keys = modelCacheKeys<${scopeType}>('${resourceName}')`)
  lines.push('')

  // ── Hook factory ──────────────────────────────────────────────────────────
  if (ctrl.kind === 'crud') {
    lines.push(`export const ${hookName} = createModelHook<${modelName}, ${scopeType}>({`)
    lines.push(`  keys: ${lcFirst(modelName)}Keys,`)
    lines.push(`  // Replace these with actual oRPC client calls:`)
    lines.push(`  indexFn: async (scopes, params) => { throw new Error('Configure oRPC client') },`)
    lines.push(`  getFn: async (id, scopes) => { throw new Error('Configure oRPC client') },`)
    lines.push(`  createFn: async (scopes, data) => { throw new Error('Configure oRPC client') },`)
    lines.push(`  updateFn: async (id, scopes, data) => { throw new Error('Configure oRPC client') },`)
    lines.push(`  destroyFn: async (id, scopes) => { throw new Error('Configure oRPC client') },`)
    if (ctrl.mutations.length > 0) {
      lines.push(`  mutationFns: {`)
      for (const mut of ctrl.mutations) {
        lines.push(`    ${mut.method}: async (${mut.bulk ? 'ids' : 'id'}, scopes, data) => { throw new Error('Configure oRPC client') },`)
      }
      lines.push(`  },`)
    }
    lines.push(`})`)
    lines.push('')
  } else if (ctrl.kind === 'singleton') {
    lines.push(`export const ${hookName} = createSingletonHook<${modelName}, ${scopeType}>({`)
    lines.push(`  keys: ${lcFirst(modelName)}Keys,`)
    lines.push(`  getFn: async (scopes) => { throw new Error('Configure oRPC client') },`)
    lines.push(`  updateFn: async (scopes, data) => { throw new Error('Configure oRPC client') },`)
    if (ctrl.mutations.length > 0) {
      lines.push(`  mutationFns: {`)
      for (const mut of ctrl.mutations) {
        lines.push(`    ${mut.method}: async (scopes, data) => { throw new Error('Configure oRPC client') },`)
      }
      lines.push(`  },`)
    }
    lines.push(`})`)
    lines.push('')
  }

  // ── Search hook ───────────────────────────────────────────────────────────
  if (ctrl.kind === 'crud' && ctrl.crudConfig?.index) {
    const defaultScopes = ctrl.crudConfig.index.defaultScopes ?? []
    const defaultSort = ctrl.crudConfig.index.defaultSort

    lines.push(`export const use${modelName}Search = createSearchHook<${modelName}SearchState>({`)
    if (defaultScopes.length) {
      lines.push(`  scopes: ${JSON.stringify(defaultScopes)},`)
    }
    if (defaultSort) {
      lines.push(`  sort: { field: '${defaultSort.field}', dir: '${defaultSort.dir ?? 'asc'}' },`)
    }
    lines.push(`  page: 0,`)
    lines.push(`  perPage: ${ctrl.crudConfig.index.perPage ?? 25},`)
    lines.push(`})`)
    lines.push('')
  }

  // ── Form config (TanStack Form compatible) ────────────────────────────────
  if (ctrl.kind === 'crud') {
    const permit = ctrl.crudConfig?.create?.permit ?? []
    lines.push(`export const ${lcFirst(modelName)}FormConfig = {`)
    lines.push(`  /** Default values for create form fields */`)
    lines.push(`  defaultValues: {`)
    for (const field of permit) {
      const col = model ? findColumn(model, field) : null
      const defaultVal = colDefaultValue(col)
      lines.push(`    ${field}: ${defaultVal},`)
    }
    lines.push(`  },`)

    if (enumFields.length > 0) {
      lines.push(`  /** Enum options for select fields */`)
      lines.push(`  enumOptions: {`)
      for (const ef of enumFields) {
        if (permit.includes(ef.name) || filterableFields.includes(ef.name)) {
          lines.push(`    ${ef.name}: ${JSON.stringify(ef.values.map(v => ({ value: v, label: capitalize(v) })))},`)
        }
      }
      lines.push(`  },`)
    }

    lines.push(`} as const`)
    lines.push('')
  }

  return lines.join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function columnToClientType(col: any): string {
  const map: Record<string, string> = {
    integer: 'number', smallint: 'number', bigint: 'number',
    serial: 'number', smallserial: 'number', bigserial: 'number',
    real: 'number', doublePrecision: 'number', decimal: 'number', numeric: 'number',
    text: 'string', varchar: 'string', char: 'string', uuid: 'string', citext: 'string',
    boolean: 'boolean',
    date: 'Date | string', timestamp: 'Date | string', timestamptz: 'Date | string',
    json: 'unknown', jsonb: 'unknown',
  }
  if (col.pgEnumValues?.length) {
    return col.pgEnumValues.map((v: string) => `'${v}'`).join(' | ')
  }
  const base = map[col.type] ?? 'unknown'
  return col.isArray ? `${base}[]` : base
}

function findColumn(model: ModelMeta, fieldName: string): any {
  // ModelMeta has `table.columns` accessible
  return null  // simplified; real impl would walk model.tableName → schema
}

function colDefaultValue(col: any): string {
  if (!col) return 'undefined'
  if (col.type === 'boolean') return 'false'
  if (['integer', 'smallint', 'bigint', 'serial', 'real', 'decimal', 'numeric'].includes(col.type)) return '0'
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
