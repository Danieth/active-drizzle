/**
 * React hook code generator.
 *
 * For each controller, generates a `{ControllerName}.gen.ts` file containing:
 *
 *   ControllerClass object with two access patterns:
 *
 *   .use(scopes)  — returns an object of hook-calling functions for use inside
 *                   React components. GET @actions become useQuery wrappers;
 *                   everything else (CRUD mutations, @mutation, POST/PATCH/DELETE
 *                   @actions) becomes useMutation wrappers.
 *
 *   .with(scopes) — returns an object of plain async functions for use outside
 *                   React: server-side calls, event handlers, tests. The same
 *                   typed input/output as .use() but no React dependency.
 *
 * For CRUD/singleton controllers, also generates the typed read/write shapes:
 *   {Model}Attrs  — all columns + eager-loaded association types
 *   {Model}Write  — Pick<Attrs, permit list>
 *   {Model}Client — immutable ClientModel subclass with enum predicates
 *
 * For plain (model-free) controllers, only @action methods are generated — no
 * ClientModel, no attrs, no cache keys.
 *
 * Additionally generates:
 *   _client.ts  — one-time client wiring stub (never overwritten if it exists)
 *   index.ts    — barrel re-exporting all controller gen files
 */
import { join, relative } from 'path'
import { existsSync } from 'fs'
import pluralize from 'pluralize'
import type { CtrlProjectMeta, CtrlMeta, CtrlActionMeta } from './controller-types.js'
import type { ProjectMeta, ModelMeta, ColumnMeta } from './types.js'

// ── Public API ────────────────────────────────────────────────────────────────

export interface GeneratedReactFile {
  filePath: string
  content: string
  /** When true, skip writing if the file already exists (user-owned) */
  skipIfExists?: boolean
}

export function generateReactHooks(
  ctrlProject: CtrlProjectMeta,
  projectMeta: ProjectMeta | null,
  outputDir: string,
): GeneratedReactFile[] {
  const files: GeneratedReactFile[] = []

  for (const ctrl of ctrlProject.controllers) {
    const model = ctrl.modelClass
      ? (projectMeta?.models.find(m => m.className === ctrl.modelClass) ?? null)
      : null

    const content = generateControllerFile(ctrl, model, projectMeta, outputDir)
    const fileName = `${toFileName(ctrl.className)}.gen.ts`

    files.push({ filePath: join(outputDir, fileName), content })
  }

  // Barrel index — always regenerated
  files.push({
    filePath: join(outputDir, 'index.ts'),
    content: generateBarrel(ctrlProject, outputDir),
  })

  // Client stub — only written once
  files.push({
    filePath: join(outputDir, '_client.ts'),
    content: generateClientStub(),
    skipIfExists: true,
  })

  return files
}

// ── Per-controller file ───────────────────────────────────────────────────────

function generateControllerFile(
  ctrl: CtrlMeta,
  model: ModelMeta | null,
  projectMeta: ProjectMeta | null,
  outputDir: string,
): string {
  const L: string[] = []

  L.push('// AUTO-GENERATED — DO NOT EDIT')
  L.push('// Source: active-drizzle react codegen')
  L.push('')

  const isPlain = ctrl.kind === 'plain'

  // ── Imports ──────────────────────────────────────────────────────────────
  const needsQuery    = hasGetActions(ctrl) || ctrl.kind === 'crud'
  const needsMutation = hasMutationActions(ctrl) || ctrl.mutations.length > 0 || ctrl.kind === 'crud' || ctrl.kind === 'singleton'

  const rqImports: string[] = []
  if (needsQuery) rqImports.push('useQuery', 'useInfiniteQuery')
  if (needsMutation) rqImports.push('useMutation')

  if (rqImports.length) {
    L.push(`import { ${[...new Set(rqImports)].join(', ')} } from '@tanstack/react-query'`)
  }

  if (!isPlain) {
    L.push(`import { ClientModel, modelCacheKeys } from '@active-drizzle/react'`)
    L.push(`import type { SearchState } from '@active-drizzle/react'`)
  }

  L.push(`import { client } from './_client'`)

  // Cross-model association imports (for includes)
  if (!isPlain && model && projectMeta) {
    const allIncludes = new Set([
      ...(ctrl.crudConfig?.get?.include ?? []),
      ...(ctrl.crudConfig?.index?.include ?? []),
    ])
    const assocImports = resolveAssocImports(allIncludes, model, projectMeta)
    for (const { attrsType } of assocImports.filter(a => a.attrsType !== 'Record<string, any>')) {
      const srcModel = attrsType.replace(/Attrs$/, '')
      if (srcModel !== ctrl.modelClass) {
        L.push(`import type { ${attrsType} } from './${toFileName(`${srcModel}Controller`)}.gen'`)
      }
    }
  }

  L.push('')

  // ── Model types (CRUD/singleton only) ────────────────────────────────────
  if (!isPlain && model && projectMeta) {
    const modelName = ctrl.modelClass!
    const columns   = projectMeta.schema.tables[model.tableName]?.columns ?? []

    const enumByProp = new Map<string, string>()
    for (const e of model.enums) {
      enumByProp.set(e.propertyName, Object.keys(e.values).map(k => `'${k}'`).join(' | '))
    }

    const allIncludes = new Set([
      ...(ctrl.crudConfig?.get?.include ?? []),
      ...(ctrl.crudConfig?.index?.include ?? []),
    ])
    const assocImports = resolveAssocImports(allIncludes, model, projectMeta)

    // TAttrs
    L.push(`/** All fields the backend may return — columns + eager-loaded associations. */`)
    L.push(`export interface ${modelName}Attrs {`)
    if (columns.length > 0) {
      for (const col of columns) {
        const ts = columnToClientType(col, enumByProp)
        L.push(`  ${col.name}${col.nullable ? '?' : ''}: ${ts}`)
      }
    } else {
      L.push('  id: number')
      L.push('  [key: string]: any')
    }
    if (assocImports.length) {
      L.push('')
      L.push('  // Eager-loaded associations')
      for (const ai of assocImports) {
        const shape = ai.isArray ? `${ai.attrsType}[]` : ai.attrsType
        L.push(`  ${ai.assocName}?: ${shape}`)
      }
    }
    L.push('}')
    L.push('')

    // TWrite
    const createPermit = ctrl.crudConfig?.create?.permit ?? []
    const updatePermit = ctrl.crudConfig?.update?.permit ?? ctrl.crudConfig?.create?.permit ?? []
    const writableFields = [...new Set([...createPermit, ...updatePermit])]

    if (writableFields.length > 0) {
      L.push(`/** Only permit-listed fields — attempting .set() with any other key is a compile error. */`)
      L.push(`export type ${modelName}Write = Pick<${modelName}Attrs, ${writableFields.map(f => `'${f}'`).join(' | ')}>`)
    } else {
      L.push(`export type ${modelName}Write = Record<string, never>`)
    }
    L.push('')

    // ClientModel subclass
    L.push(`export class ${modelName}Client extends ClientModel<${modelName}Attrs, ${modelName}Write> {`)
    if (columns.length > 0) {
      for (const col of columns) {
        const ts = columnToClientType(col, enumByProp)
        L.push(`  declare ${col.name}${col.nullable ? '?' : ''}: ${ts}`)
      }
    } else {
      L.push('  declare id: number')
    }
    if (assocImports.length) {
      L.push('')
      for (const ai of assocImports) {
        const shape = ai.isArray ? `${ai.attrsType}[]` : ai.attrsType
        L.push(`  declare ${ai.assocName}?: ${shape}`)
      }
    }
    if (model.enums.length) {
      L.push('')
      for (const e of model.enums) {
        for (const label of Object.keys(e.values)) {
          L.push(`  ${lcFirst(e.propertyName)}Is${capitalize(label)}() { return this.${e.propertyName} === '${label}' }`)
        }
      }
    }
    L.push('}')
    L.push('')

    // Search state
    const paramScopes = ctrl.crudConfig?.index?.paramScopes ?? []
    L.push(`export interface ${modelName}SearchState extends SearchState {`)
    for (const ps of paramScopes) L.push(`  ${ps}?: string`)
    L.push('}')
    L.push('')

    // Cache keys
    const scopeFields = ctrl.scopes.map(s => s.field)
    const scopeType   = scopeType_fromFields(scopeFields)
    const resourceName = ctrl.basePath.split('/').pop()?.replace(/:[^/]*/g, '').replace(/\/+$/, '')
      ?? pluralize(lcFirst(ctrl.modelClass!))
    L.push(`export const ${lcFirst(ctrl.modelClass!)}Keys = modelCacheKeys<${scopeType}>('${resourceName}')`)
    L.push('')
  }

  // ── Controller object ─────────────────────────────────────────────────────
  const exportName  = ctrl.className
  const scopeFields = ctrl.scopes.map(s => s.field)
  const scopeType   = scopeType_fromFields(scopeFields)
  const scopeParam  = `scopes: ${scopeType}`
  const clientKey   = toClientKey(ctrl)

  L.push(`export const ${exportName} = {`)

  // ── .use() ────────────────────────────────────────────────────────────────
  L.push(`  /**`)
  L.push(`   * Call inside a React component to get hook-returning functions.`)
  L.push(`   * Destructure once: const ctrl = ${exportName}.use(scopes)`)
  L.push(`   */`)
  L.push(`  use: (${scopeParam}) => ({`)
  emitUse(L, ctrl, clientKey)
  L.push(`  }),`)
  L.push('')

  // ── .with() ───────────────────────────────────────────────────────────────
  L.push(`  /**`)
  L.push(`   * Call outside React for direct async calls — event handlers, SSR, tests.`)
  L.push(`   */`)
  L.push(`  with: (${scopeParam}) => ({`)
  emitWith(L, ctrl, clientKey)
  L.push(`  }),`)
  L.push(`}`)
  L.push('')

  return L.join('\n')
}

// ── .use() body ───────────────────────────────────────────────────────────────

function emitUse(L: string[], ctrl: CtrlMeta, clientKey: string): void {
  const modelName  = ctrl.modelClass
  const scopeSpread = ctrl.scopes.length > 0 ? '...scopes, ' : ''

  if (ctrl.kind === 'crud' && modelName) {
    // CRUD queries
    L.push(`    /** Paginated list query. Pass search state from use${modelName}Search(). */`)
    L.push(`    index: (params?: ${modelName}SearchState) => useQuery({`)
    L.push(`      queryKey: ${lcFirst(modelName)}Keys.list(scopes, params),`)
    L.push(`      queryFn:  () => client.${clientKey}.index({ ${scopeSpread}...params }),`)
    L.push(`    }),`)
    L.push(`    /** Infinite-scroll list query. */`)
    L.push(`    infiniteIndex: (params?: Omit<${modelName}SearchState, 'page'>) => useInfiniteQuery({`)
    L.push(`      queryKey:       ${lcFirst(modelName)}Keys.list(scopes, params),`)
    L.push(`      queryFn:        ({ pageParam = 0 }) => client.${clientKey}.index({ ${scopeSpread}...params, page: pageParam as number }),`)
    L.push(`      initialPageParam: 0,`)
    L.push(`      getNextPageParam: (last: any) => last?.pagination?.hasMore ? (last.pagination.page + 1) : undefined,`)
    L.push(`    }),`)
    L.push(`    /** Single-record query. Pass null/undefined to skip fetching. */`)
    L.push(`    get: (id: number | string | null | undefined) => useQuery({`)
    L.push(`      queryKey: ${lcFirst(modelName)}Keys.detail(id ?? 0, scopes),`)
    L.push(`      queryFn:  () => client.${clientKey}.get({ ${scopeSpread}id }),`)
    L.push(`      enabled:  id != null,`)
    L.push(`    }),`)
    // CRUD mutations
    L.push(`    create:  () => useMutation({ mutationFn: (data: ${modelName}Write) => client.${clientKey}.create({ ${scopeSpread}data }) }),`)
    L.push(`    update:  () => useMutation({ mutationFn: ({ id, ...data }: { id: number | string } & Partial<${modelName}Write>) => client.${clientKey}.update({ ${scopeSpread}id, data }) }),`)
    L.push(`    destroy: () => useMutation({ mutationFn: (id: number | string) => client.${clientKey}.destroy({ ${scopeSpread}id }) }),`)
  }

  if (ctrl.kind === 'singleton' && modelName) {
    L.push(`    get:    () => useQuery({ queryKey: ${lcFirst(modelName)}Keys.singleton(scopes), queryFn: () => client.${clientKey}.get({ ${scopeSpread} }) }),`)
    L.push(`    update: () => useMutation({ mutationFn: (data: ${modelName}Write) => client.${clientKey}.update({ ${scopeSpread}data }) }),`)
  }

  // @mutation — always useMutation
  for (const mut of ctrl.mutations) {
    if (mut.bulk) {
      L.push(`    ${mut.method}: () => useMutation({ mutationFn: (ids: (number | string)[]) => client.${clientKey}.${mut.method}({ ${scopeSpread}ids }) }),`)
    } else {
      L.push(`    ${mut.method}: () => useMutation({ mutationFn: (id: number | string) => client.${clientKey}.${mut.method}({ ${scopeSpread}id }) }),`)
    }
  }

  // @action — GET → useQuery, everything else → useMutation
  for (const act of ctrl.actions) {
    const actionKey = toActionClientKey(act, clientKey)
    if (act.httpMethod === 'GET') {
      const qk = `[...${lcFirst(modelName ?? 'controller')}Keys?.root(scopes) ?? [], '${act.method}']`
      L.push(`    ${act.method}: () => useQuery({ queryKey: ${qk}, queryFn: () => client.${actionKey}({ ${scopeSpread} }) }),`)
    } else {
      const inputArg = act.inputType ? `(data: ${act.inputType})` : `(data?: Record<string, unknown>)`
      L.push(`    ${act.method}: () => useMutation({ mutationFn: ${inputArg} => client.${actionKey}({ ${scopeSpread}data }) }),`)
    }
  }
}

// ── .with() body ──────────────────────────────────────────────────────────────

function emitWith(L: string[], ctrl: CtrlMeta, clientKey: string): void {
  const modelName  = ctrl.modelClass
  const scopeSpread = ctrl.scopes.length > 0 ? '...scopes, ' : ''

  if (ctrl.kind === 'crud' && modelName) {
    L.push(`    index:   (params?: ${modelName}SearchState) => client.${clientKey}.index({ ${scopeSpread}...params }),`)
    L.push(`    get:     (id: number | string) => client.${clientKey}.get({ ${scopeSpread}id }),`)
    L.push(`    create:  (data: ${modelName}Write) => client.${clientKey}.create({ ${scopeSpread}data }),`)
    L.push(`    update:  (id: number | string, data: Partial<${modelName}Write>) => client.${clientKey}.update({ ${scopeSpread}id, data }),`)
    L.push(`    destroy: (id: number | string) => client.${clientKey}.destroy({ ${scopeSpread}id }),`)
  }

  if (ctrl.kind === 'singleton' && modelName) {
    L.push(`    get:    () => client.${clientKey}.get({ ${scopeSpread} }),`)
    L.push(`    update: (data: ${modelName}Write) => client.${clientKey}.update({ ${scopeSpread}data }),`)
  }

  // @mutation
  for (const mut of ctrl.mutations) {
    if (mut.bulk) {
      L.push(`    ${mut.method}: (ids: (number | string)[]) => client.${clientKey}.${mut.method}({ ${scopeSpread}ids }),`)
    } else {
      L.push(`    ${mut.method}: (id: number | string) => client.${clientKey}.${mut.method}({ ${scopeSpread}id }),`)
    }
  }

  // @action
  for (const act of ctrl.actions) {
    const actionKey = toActionClientKey(act, clientKey)
    if (act.inputType) {
      L.push(`    ${act.method}: (data: ${act.inputType}) => client.${actionKey}({ ${scopeSpread}data }),`)
    } else {
      L.push(`    ${act.method}: (data?: Record<string, unknown>) => client.${actionKey}({ ${scopeSpread}...data }),`)
    }
  }
}

// ── Barrel index ──────────────────────────────────────────────────────────────

function generateBarrel(ctrlProject: CtrlProjectMeta, _outputDir: string): string {
  const L: string[] = ['// AUTO-GENERATED — DO NOT EDIT', '']
  for (const ctrl of ctrlProject.controllers) {
    L.push(`export * from './${toFileName(ctrl.className)}.gen'`)
  }
  return L.join('\n') + '\n'
}

// ── _client.ts stub ───────────────────────────────────────────────────────────

function generateClientStub(): string {
  return `/**
 * Configure your oRPC client here.
 *
 * This file is written once and never overwritten by codegen.
 *
 * Example setup with @orpc/client:
 *
 *   import { createORPCClient } from '@orpc/client'
 *   import { RPCLink } from '@orpc/client/fetch'
 *   import type { AppRouter } from '../server/_routes.gen'
 *
 *   export const client = createORPCClient<AppRouter>(
 *     new RPCLink({ url: '/api/rpc' })
 *   )
 *
 * The type of AppRouter is inferred from _routes.gen.ts (generated alongside
 * your controller files by the active-drizzle Vite plugin).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const client: any = null
`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert controller class name to file name segment, e.g. CampaignController → campaign */
function toFileName(className: string): string {
  return lcFirst(className.replace(/Controller$/, ''))
}

/**
 * Derive the dotted client key for a controller's CRUD procedures.
 * CampaignController → client.campaigns
 * TeamSettingsController → client.teamSettings
 */
function toClientKey(ctrl: CtrlMeta): string {
  const base = ctrl.className.replace(/Controller$/, '')
  if (ctrl.kind === 'crud' && ctrl.modelClass) {
    return pluralize(lcFirst(ctrl.modelClass))
  }
  return lcFirst(base)
}

/**
 * Derive the dotted client key for an @action procedure.
 * e.g. UploadController.getUploadUrl → client.upload.getUploadUrl
 */
function toActionClientKey(act: CtrlActionMeta, baseKey: string): string {
  return `${baseKey}.${act.method}`
}

function hasGetActions(ctrl: CtrlMeta): boolean {
  return ctrl.actions.some(a => a.httpMethod === 'GET')
}

function hasMutationActions(ctrl: CtrlMeta): boolean {
  return ctrl.actions.some(a => a.httpMethod !== 'GET')
}

function scopeType_fromFields(fields: string[]): string {
  if (fields.length === 0) return 'Record<string, never>'
  return `{ ${fields.map(f => `${f}: number`).join('; ')} }`
}

interface AssocImport { assocName: string; attrsType: string; isArray: boolean }

function resolveAssocImports(
  includes: Set<string>,
  model: ModelMeta,
  projectMeta: ProjectMeta,
): AssocImport[] {
  return [...includes].map(name => {
    const assoc = model.associations.find(a => a.propertyName === name)
    if (!assoc) return { assocName: name, attrsType: 'Record<string, any>', isArray: false }

    const targetModel = projectMeta.models.find(m => m.tableName === assoc.resolvedTable)
    const attrsType = targetModel
      ? `${targetModel.className}Attrs`
      : capitalize(pluralize.singular(assoc.resolvedTable ?? name)) + 'Attrs'

    const isArray = assoc.kind === 'hasMany' || assoc.kind === 'habtm'
    return { assocName: name, attrsType, isArray }
  })
}

function columnToClientType(col: ColumnMeta, enumByProp: Map<string, string>): string {
  const enumUnion = enumByProp.get(col.name)
  if (enumUnion) return col.isArray ? `(${enumUnion})[]` : enumUnion
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
    date: 'string', timestamp: 'string', timestamptz: 'string', time: 'string', interval: 'string',
    json: 'unknown', jsonb: 'unknown',
    bytea: 'Buffer',
    inet: 'string', cidr: 'string', macaddr: 'string', macaddr8: 'string',
    tsvector: 'string', tsquery: 'string', bit: 'string', varbit: 'string',
    xml: 'string', money: 'string', oid: 'number',
    vector: 'number[]',
    point: '{ x: number; y: number }',
  }
  const base = map[col.type] ?? 'unknown'
  return col.isArray ? `${base}[]` : base
}

function lcFirst(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1) }
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }
