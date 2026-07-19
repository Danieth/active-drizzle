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
import type { CtrlProjectMeta, CtrlMeta, CtrlActionMeta, CtrlAttachmentMeta } from './controller-types.js'
import type { ProjectMeta, ModelMeta, ColumnMeta } from './types.js'
import { depsFitProjection } from './validation-deps.js'
import { renderFieldMeta } from './generator.js'

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

  // Client namespaces that actually exist — an instant nested write only
  // ships when the child resource has a controller to hit
  const controllerKeys = new Set(ctrlProject.controllers.map(toClientKey))

  for (const ctrl of ctrlProject.controllers) {
    const model = ctrl.modelClass
      ? (projectMeta?.models.find(m => m.className === ctrl.modelClass) ?? null)
      : null

    const content = generateControllerFile(ctrl, model, projectMeta, outputDir, controllerKeys)
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
  controllerKeys: Set<string> = new Set(),
): string {
  const L: string[] = []
  // Instant nested resources discovered while rendering meta — the hook wires
  // a transport for each (child controller's create/update/destroy)
  const instantResources = new Set<string>()

  L.push('// AUTO-GENERATED — DO NOT EDIT')
  L.push('// Source: active-drizzle react codegen')
  L.push('')

  const isPlain = ctrl.kind === 'plain'

  // ── Imports ──────────────────────────────────────────────────────────────
  const needsQuery    = hasGetActions(ctrl) || ctrl.kind === 'crud'
  const needsMutation = hasMutationActions(ctrl) || ctrl.mutations.length > 0 || ctrl.kind === 'crud' || ctrl.kind === 'singleton' || ctrl.attachable

  // Forms envelope → typed handle + wired useEditForm/useNewForm
  const envelopeEnabled = ctrl.kind === 'crud'
    && Boolean(ctrl.crudConfig?.get?.abilities)
    && Boolean(ctrl.crudConfig?.get?.expose?.length)

  const rqImports: string[] = []
  if (needsQuery) rqImports.push('useQuery', 'useInfiniteQuery')
  if (needsMutation) rqImports.push('useMutation')
  if (envelopeEnabled) rqImports.push('useQueryClient')

  if (rqImports.length) {
    L.push(`import { ${[...new Set(rqImports)].join(', ')} } from '@tanstack/react-query'`)
  }


  // Which property validators ship to THIS client — projection-scoped AND
  // free of foreign identifiers — and whether any reference the Validates
  // factories (import emitted below, precisely when used)
  const earlyCreatePermit = ctrl.crudConfig?.create?.permit ?? []
  const earlyUpdatePermit = ctrl.crudConfig?.update?.permit ?? earlyCreatePermit
  const earlyProjection = model
    ? controllerProjectionFields(ctrl, model, [...new Set([...earlyCreatePermit, ...earlyUpdatePermit])])
    : new Set<string>()
  const shippablePropValidations = model
    ? Object.entries(model.propertyValidations ?? {}).filter(([prop]) =>
        earlyProjection.has(prop) &&
        (model.propertyValidationAnalysis?.[prop]?.foreignRefs?.length ?? 0) === 0,
      )
    : []
  // Every nested model reachable transitively (grandchildren included) — a
  // deep child that ships a Validates rule still needs the import emitted
  const nestedChildModels = collectNestedModelsDeep(model, projectMeta)
  const needsValidates = shippablePropValidations.some(
    ([prop]) => model?.propertyValidationAnalysis?.[prop]?.usesValidates,
  ) || nestedChildModels.some(cm =>
    Object.keys(cm.propertyValidations ?? {}).some(p =>
      cm.propertyValidationAnalysis?.[p]?.usesValidates &&
      (cm.propertyValidationAnalysis?.[p]?.foreignRefs?.length ?? 0) === 0,
    ),
  )

  if (!isPlain) {
    const adImports = ['ClientModel', 'modelCacheKeys']
    const adTypeImports = ['SearchState']
    if (envelopeEnabled) {
      adImports.push('useGeneratedForm', 'parseControllerError')
      adTypeImports.push('FormHandleApi', 'TypedFieldComponent', 'SubmitResult')
    }
    if (needsValidates) adImports.push('Validates')
    L.push(`import { ${adImports.join(', ')} } from '@active-drizzle/react'`)
    L.push(`import type { ${adTypeImports.join(', ')} } from '@active-drizzle/react'`)
  }

  if (ctrl.attachable) {
    L.push(`import { useUploadFactory, useMultiUploadFactory } from '@active-drizzle/react'`)
    L.push(`import type { UseUploadOptions, UseMultiUploadOptions, CtrlAttachmentMeta as AttachmentMeta } from '@active-drizzle/react'`)
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
    // Attr.state fields hydrate as LABELS over the wire, exactly like enums —
    // without this, `stage` would be typed number while runtime yields 'draft'
    // (the class of bug this framework exists to prevent, in its own output)
    for (const st of model.states ?? []) {
      enumByProp.set(st.propertyName, Object.keys(st.values).map(k => `'${k}'`).join(' | '))
    }

    const allIncludes = new Set([
      ...(ctrl.crudConfig?.get?.include ?? []),
      ...(ctrl.crudConfig?.index?.include ?? []),
    ])
    const assocImports = resolveAssocImports(allIncludes, model, projectMeta)

    // habtm `<singular>Ids` — Rails' collection_singular_ids as a wire key.
    // Only keys the controller actually exposes or statically permits type
    // through; the runtime permit governs regardless.
    const habtmIdsCandidates = model.associations
      .filter(a => a.kind === 'habtm')
      .map(a => ({ idsKey: `${singularize(a.propertyName)}Ids`, assoc: a }))
    const habtmScope = new Set([
      ...(ctrl.crudConfig?.get?.expose ?? []),
      ...(ctrl.crudConfig?.create?.permit ?? []),
      ...(ctrl.crudConfig?.update?.permit ?? []),
    ])
    const habtmIdsInScope = habtmIdsCandidates.filter(({ idsKey }) => habtmScope.has(idsKey))

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
    if (habtmIdsInScope.length) {
      L.push('')
      L.push('  // habtm id sets — assigning one on save REPLACES the join rows')
      for (const { idsKey } of habtmIdsInScope) {
        L.push(`  ${idsKey}?: number[]`)
      }
    }
    L.push('}')
    L.push('')

    // TWrite
    const createPermit = ctrl.crudConfig?.create?.permit ?? []
    const updatePermit = ctrl.crudConfig?.update?.permit ?? ctrl.crudConfig?.create?.permit ?? []
    let writableFields = [...new Set([...createPermit, ...updatePermit])]
    // Every permit dynamic (record-aware fns extract as undefined) → the
    // static Write TYPE falls back to expose minus the never-writable columns.
    // Compile-time convenience only: the runtime permit still strips.
    if (writableFields.length === 0 && ctrl.crudConfig?.get?.expose?.length) {
      const NEVER_WRITABLE = new Set(['id', 'createdAt', 'updatedAt'])
      writableFields = ctrl.crudConfig.get.expose.filter(f => !NEVER_WRITABLE.has(f))
    }

    // Separate regular fields from attachment fields and nested-attribute
    // entries — `notesAttributes` in a permit is a WRITE SURFACE for the
    // association, not a column, so it types as a nested rows array
    const attachmentNames = new Set((ctrl.attachments ?? []).map(a => a.name))
    const nestedAttrNames = new Set(
      model.associations
        .filter(a => a.acceptsNested)
        .map(a => `${a.propertyName}Attributes`),
    )
    const regularWritable = writableFields.filter(f => !attachmentNames.has(f) && !nestedAttrNames.has(f))
    const attachableWritable = writableFields.filter(f => attachmentNames.has(f))
    const nestedWritable = writableFields.filter(f => nestedAttrNames.has(f))

    if (regularWritable.length > 0 || attachableWritable.length > 0 || nestedWritable.length > 0) {
      L.push(`/** Only permit-listed fields — attempting .set() with any other key is a compile error. */`)
      const parts: string[] = []
      if (regularWritable.length > 0) {
        parts.push(`Pick<${modelName}Attrs, ${regularWritable.map(f => `'${f}'`).join(' | ')}>`)
      }
      // Add attachment asset ID fields
      const attachParts: string[] = []
      for (const name of attachableWritable) {
        const att = (ctrl.attachments ?? []).find(a => a.name === name)
        if (att?.kind === 'one') {
          attachParts.push(`${name}AssetId?: number | null`)
        } else {
          attachParts.push(`${name}AssetIds?: number[]`)
        }
      }
      for (const name of nestedWritable) {
        attachParts.push(`${name}?: Array<Record<string, any> & { id?: number; _destroy?: boolean; _key?: string }>`)
      }
      if (regularWritable.length > 0 && attachParts.length > 0) {
        L.push(`export type ${modelName}Write = ${parts[0]} & { ${attachParts.join('; ')} }`)
      } else if (attachParts.length > 0) {
        L.push(`export type ${modelName}Write = { ${attachParts.join('; ')} }`)
      } else {
        L.push(`export type ${modelName}Write = ${parts[0]}`)
      }
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
    if (habtmIdsInScope.length) {
      L.push('')
      for (const { idsKey } of habtmIdsInScope) {
        L.push(`  declare ${idsKey}?: number[]`)
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

    // Presentational meta — filtered to THIS controller's projection;
    // predicates ship only when their deps fit it.
    const stateProjection = controllerProjectionFields(ctrl, model, writableFields)
    {
      // Attachments are first-class fields: their meta carries the upload
      // contract (accepts/maxSize/access) so an upload presenter can render
      // a correct dropzone from meta alone
      const attachmentEntries = (ctrl.attachments ?? []).map(att => {
        const parts = [
          `kind: '${att.kind === 'many' ? 'attachmentMany' : 'attachmentOne'}'`,
          `accepts: ${att.accepts ? `'${att.accepts}'` : 'undefined'}`,
          `maxSize: ${att.maxSize ?? 'undefined'}`,
          `access: '${att.access}'`,
          ...(att.kind === 'many' && att.max ? [`max: ${att.max}`] : []),
        ]
        return `    ${att.name}: { ${parts.join(', ')} },`
      })
      // acceptsNested associations become nested form arrays: kind 'nested'
      // with the child model's field meta inlined, plus orderBy for DnD when
      // the association declares an order — <deal.notes>{note => …} just works
      const nestedEntries: string[] = []
      // Fail-closed gate: a nested form ships only when the controller can
      // actually ACCEPT the writes. A dynamic (record-aware) permit extracts
      // as undefined → emit, the runtime abilities mask governs. Both permits
      // statically known and neither containing `<assoc>Attributes` → the
      // server would strip every nested write, so emitting an editable array
      // would be a lie — skip it and say so at build time.
      const staticCreatePermit = ctrl.crudConfig?.create?.permit
      const staticUpdatePermit = ctrl.crudConfig?.update?.permit
      const anyPermitDynamic =
        (ctrl.crudConfig?.create !== undefined && staticCreatePermit === undefined) ||
        (ctrl.crudConfig?.update !== undefined && staticUpdatePermit === undefined)
      for (const assoc of model.associations) {
        if (!assoc.acceptsNested) continue
        const attrsKey = `${assoc.propertyName}Attributes`
        const staticallyPermitted =
          (staticCreatePermit ?? []).includes(attrsKey) || (staticUpdatePermit ?? []).includes(attrsKey)
        if (!staticallyPermitted && !anyPermitDynamic) {
          console.warn(
            `[active-drizzle codegen] ${model.className}.${assoc.propertyName} accepts nested `
            + `attributes but ${ctrl.className}'s permit never includes '${attrsKey}' — the server `
            + `would strip every nested write, so the nested form was NOT generated. `
            + `Add '${attrsKey}' to the permit to enable it.`,
          )
          continue
        }
        // Recursive: the entry inlines the child's fields AND any grandchild
        // nested arrays, to arbitrary depth (cycle-guarded by table name)
        const entry = renderNestedMetaEntry(assoc, model.tableName, projectMeta, new Set([model.tableName]),
          { controllerKeys, sink: instantResources })
        if (entry) nestedEntries.push(`    ${entry},`)
      }
      // belongsTo sugar: <deal.owner> is the FK field wearing the
      // association's name. kind 'ref' meta carries the fk; the runtime
      // aliases value/write/mask/errors to that column. WHICH directory the
      // picker reads stays a call-site choice (props={{ from: Controller }})
      // — a model has no canonical controller, so codegen names none.
      const refEntries: string[] = []
      for (const assoc of model.associations) {
        if (assoc.kind !== 'belongsTo' || assoc.polymorphic) continue
        const fk = assoc.foreignKey ?? `${assoc.propertyName}Id`
        if (!stateProjection.has(fk)) continue
        const label = capitalize(assoc.propertyName.replace(/([A-Z])/g, ' $1'))
        refEntries.push(`    ${assoc.propertyName}: { kind: 'ref', fk: '${fk}', label: ${JSON.stringify(label)} },`)
      }
      // habtm: <deal.owners> is the `<singular>Ids` set wearing the
      // association's name — same aliasing, plural (kind 'refMany')
      for (const { idsKey, assoc } of habtmIdsInScope) {
        if (!stateProjection.has(idsKey)) continue
        const label = capitalize(assoc.propertyName.replace(/([A-Z])/g, ' $1'))
        refEntries.push(`    ${assoc.propertyName}: { kind: 'refMany', ids: '${idsKey}', label: ${JSON.stringify(label)} },`)
      }
      // Every field the typed handle declares gets a meta entry — a handle
      // field whose meta lookup comes up empty would promise presenters the
      // runtime can't resolve (id/ownerId/updatedAt etc. get their kind here)
      const colTypesForMeta = new Map(
        (projectMeta?.schema.tables[model.tableName]?.columns ?? []).map(c => [c.name, c.type as string]),
      )
      const covered = new Set([
        ...Object.keys(model.fieldMeta ?? {}),
        ...(ctrl.attachments ?? []).map(a => a.name),
        ...model.associations.filter(a => a.acceptsNested).map(a => a.propertyName),
      ])
      const bareColumnEntries = [...stateProjection]
        .filter(f => !covered.has(f) && colTypesForMeta.has(f))
        .sort()
        .map(f => `    ${f}: { kind: '${fieldKind(f, model, colTypesForMeta)}' },`)
      const metaSource = renderFieldMeta(model, stateProjection, [...attachmentEntries, ...nestedEntries, ...refEntries, ...bareColumnEntries])
      if (metaSource) {
        L.push('')
        L.push(`  static fieldMeta = ${metaSource} as const`)
      }
    }

    // Attr.state: per-label predicates + can(event). Guards ship only when
    // provable AND their deps fit THIS controller's projection — otherwise
    // can() fail-closes to false (the server's abilities/can map is truth).
    if ((model.states ?? []).length) {
      L.push('')
      for (const st of model.states ?? []) {
        for (const label of Object.keys(st.values)) {
          L.push(`  ${lcFirst(st.propertyName)}Is${capitalize(label)}() { return this.${st.propertyName} === '${label}' }`)
        }
      }
      const stateTransitions = (model.states ?? []).flatMap(st => st.transitions.map(t => ({ st, t })))
      if (stateTransitions.length) {
        L.push(`  can(event: string): boolean {`)
        for (const { st, t } of stateTransitions) {
          const fromCheck = t.from === '*'
            ? 'true'
            : `(${JSON.stringify(t.from)} as readonly string[]).includes(String((this as any).${st.propertyName}))`
          let guardCheck = 'true'
          if (t.guardSource) {
            const provable = t.guardDeps && !t.guardDepsError && depsFitProjection(t.guardDeps, stateProjection)
            guardCheck = provable ? `Boolean((${t.guardSource})(this as any))` : 'false'
          }
          L.push(`    if (event === '${t.event}') return ${fromCheck} && ${guardCheck}`)
        }
        L.push(`    return false`)
        L.push(`  }`)
      }
    }

    // Projection-scoped validate(): only validations whose deps fit this controller's
    // permit ∪ includes. Server still runs the full set on the merged record.
    //
    // Fail-closed on method calls: the controller Client emits validator bodies
    // WITHOUT sibling instance methods, so a body calling `this.helper()` (or a
    // proxy synthetic like `this.amountChanged()`) would blow up in the browser.
    // Such validators stay server-only. Field reads and the enum helpers the
    // Client actually generates (statusIsDraft()) remain shippable.
    const clientCallable = new Set<string>(['raw', 'toObject'])
    for (const e of model.enums) {
      for (const label of Object.keys(e.values)) {
        clientCallable.add(`${lcFirst(e.propertyName)}Is${capitalize(label)}`)
      }
    }
    for (const st of model.states ?? []) {
      for (const label of Object.keys(st.values)) {
        clientCallable.add(`${lcFirst(st.propertyName)}Is${capitalize(label)}`)
      }
      if (st.transitions.length) clientCallable.add('can')
    }
    const projection = controllerProjectionFields(ctrl, model, writableFields)
    const clientValidations = (model.instanceMethods ?? []).filter(m =>
      m.isValidation &&
      m.body &&
      !m.validationDepsError &&
      m.validationDeps &&
      depsFitProjection(m.validationDeps, projection) &&
      !bodyCallsUnavailableMethods(m.body, clientCallable)
    )
    // Projection-scoped + shippable (no foreign identifiers) — computed once
    // up top so the Validates import matches exactly what's emitted here
    const clientPropValidations = shippablePropValidations

    if (clientValidations.length > 0 || clientPropValidations.length > 0) {
      L.push('')
      L.push(`  /** Client-side UX validation — subset whose deps fit this controller's projection. */`)
      L.push(`  validate(): Record<string, string[]> {`)
      L.push(`    const errors: Record<string, string[]> = {}`)
      L.push(`    const _push = (field: string, msg: unknown) => {`)
      L.push(`      if (typeof msg !== 'string') return`)
      L.push(`      const t = msg.trim()`)
      L.push(`      if (!t) return`)
      L.push(`      ;(errors[field] ??= []).push(t)`)
      L.push(`    }`)
      // Validators receive (value, draft, field). A record-gate touching
      // something this projection doesn't carry throws — caught and degraded
      // to a no-op; the server stays authoritative. Never a browser crash.
      L.push(`    const _run = (field: string, validators: any, value: any) => {`)
      L.push(`      const list = Array.isArray(validators) ? validators : [validators]`)
      L.push(`      for (const fn of list) {`)
      L.push(`        if (typeof fn !== 'function') continue`)
      L.push(`        try { _push(field, fn(value, this, field)) } catch (e) {`)
      L.push(`          // A throw here USUALLY means a record-gate touched a field outside`)
      L.push(`          // this projection (fine — the server runs the full rule). In dev,`)
      L.push(`          // surface it so a genuinely broken validator can't hide behind the gate.`)
      L.push(`          if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {`)
      L.push(`            console.warn('[active-drizzle] validator for "' + field + '" threw client-side (treated as server-only):', e)`)
      L.push(`          }`)
      L.push(`        }`)
      L.push(`      }`)
      L.push(`    }`)
      for (const [prop, code] of clientPropValidations) {
        L.push(`    _run('${prop}', (${code}), (this as any).${prop})`)
      }
      for (const method of clientValidations) {
        L.push(`    {`)
        L.push(`      const _result = ((function(this: any) ${method.body}).call(this))`)
        L.push(`      _push('base', _result)`)
        L.push(`    }`)
      }
      L.push(`    return errors`)
      L.push(`  }`)
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

    // ── Typed form handle + wired hooks (envelope controllers only) ────────
    if (envelopeEnabled) {
      emitFormHooks(L, ctrl, model, projectMeta!, stateProjection, modelName, scopeFields, scopeType, instantResources)
    }
  }

  // ── Attachment metadata constant (if @attachable) ────────────────────────
  if (ctrl.attachable) {
    const modelKey = ctrl.modelClass ? lcFirst(ctrl.modelClass) : lcFirst(ctrl.className.replace(/Controller$/, ''))
    L.push(`/** Attachment declarations — use for dropzone accept attributes and client-side validation. */`)
    L.push(`export const ${modelKey}Attachments = {`)
    for (const att of (ctrl.attachments ?? [])) {
      const parts: string[] = [`kind: '${att.kind}'`]
      parts.push(`accepts: ${att.accepts ? `'${att.accepts}'` : 'undefined'}`)
      parts.push(`maxSize: ${att.maxSize ?? 'undefined'}`)
      parts.push(`access: '${att.access}'`)
      if (att.kind === 'many' && att.max) parts.push(`max: ${att.max}`)
      L.push(`  ${att.name}: { ${parts.join(', ')} },`)
    }
    L.push(`} as const`)
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
  // Members are hooks — also expose use-prefixed ALIASES (useIndex, useGet…)
  // so eslint's rules-of-hooks can see them (#8 in the audit). Both names
  // reference the SAME functions; prefer the use* names in new code.
  L.push(`  use: (${scopeParam}) => {`)
  L.push(`    const h = {`)
  emitUse(L, ctrl, clientKey)
  L.push(`    }`)
  L.push(`    const aliases = Object.fromEntries(`)
  L.push(`      Object.entries(h).map(([k, v]) => ['use' + k[0]!.toUpperCase() + k.slice(1), v]),`)
  L.push(`    ) as { [K in keyof typeof h as \`use\${Capitalize<string & K>}\`]: (typeof h)[K] }`)
  L.push(`    return { ...h, ...aliases }`)
  L.push(`  },`)
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

// ── Name helpers ─────────────────────────────────────────────────────────────
//
// Naming rules (flat, prefix-based):
//
//   Queries:
//     index, infiniteIndex, get           → as-is (standard CRUD)
//     @action('GET') stats                → indexStats   (prefix 'index', dedup)
//     @action('GET') indexStats           → indexStats   (already starts with 'index')
//     @action('GET') getSummary           → getSummary   (already starts with 'get')
//
//   Mutations (ALL start with 'mutate'):
//     create / update / destroy           → mutateCreate / mutateUpdate / mutateDestroy
//     @mutation() launch                  → mutateLaunch
//     @mutation({ bulk: true }) archive   → mutateBulkArchive   (prefix 'mutateBulk')
//     @mutation({ bulk: true }) bulkArch  → mutateBulkArchive   (dedup: already has 'bulk')
//     @action('POST') recalculate         → mutateRecalculate

function toIndexName(methodName: string): string {
  if (methodName.startsWith('index') || methodName.startsWith('get')) return methodName
  return 'index' + capitalize(methodName)
}

function toMutateName(methodName: string): string {
  return 'mutate' + capitalize(methodName)
}

function toBulkMutateName(methodName: string): string {
  // If name already starts with 'bulk', the capitalize gives us e.g. 'BulkArchive',
  // so 'mutate' + 'BulkArchive' → 'mutateBulkArchive' — natural dedup.
  // If name doesn't start with 'bulk', we add it: 'mutateBulk' + 'Archive'.
  if (methodName.startsWith('bulk')) {
    return 'mutate' + capitalize(methodName)
  }
  return 'mutateBulk' + capitalize(methodName)
}

// ── .use() body ───────────────────────────────────────────────────────────────

function emitUse(L: string[], ctrl: CtrlMeta, clientKey: string): void {
  const modelName   = ctrl.modelClass
  const scopeSpread = ctrl.scopes.length > 0 ? '...scopes, ' : ''
  const keysRef     = modelName ? `${lcFirst(modelName)}Keys` : null

  if (ctrl.kind === 'crud' && modelName) {
    L.push(`    /** Paginated list. Pass search state from use${modelName}Search(). */`)
    L.push(`    index: (params?: ${modelName}SearchState) => useQuery({`)
    L.push(`      queryKey: ${keysRef}!.list(scopes, params),`)
    L.push(`      queryFn:  () => client.${clientKey}.index({ ${scopeSpread}...params }),`)
    L.push(`    }),`)
    L.push(`    /** Infinite-scroll list. */`)
    L.push(`    infiniteIndex: (params?: Omit<${modelName}SearchState, 'page'>) => useInfiniteQuery({`)
    L.push(`      queryKey:         ${keysRef}!.list(scopes, params),`)
    L.push(`      queryFn:          ({ pageParam = 0 }) => client.${clientKey}.index({ ${scopeSpread}...params, page: pageParam as number }),`)
    L.push(`      initialPageParam: 0,`)
    L.push(`      getNextPageParam:  (last: any) => last?.pagination?.hasMore ? (last.pagination.page + 1) : undefined,`)
    L.push(`    }),`)
    L.push(`    /** Single-record query. Pass null/undefined to disable fetching. */`)
    L.push(`    get: (id: number | string | null | undefined) => useQuery({`)
    L.push(`      queryKey: ${keysRef}!.detail(id ?? 0, scopes),`)
    L.push(`      queryFn:  () => client.${clientKey}.get({ ${scopeSpread}id }),`)
    L.push(`      enabled:  id != null,`)
    L.push(`    }),`)
    // Standard CRUD mutations — prefixed with 'mutate'
    L.push(`    mutateCreate:  () => useMutation({ mutationFn: (data: ${modelName}Write) => client.${clientKey}.create({ ${scopeSpread}data }) }),`)
    L.push(`    mutateUpdate:  () => useMutation({ mutationFn: ({ id, ...data }: { id: number | string } & Partial<${modelName}Write>) => client.${clientKey}.update({ ${scopeSpread}id, data }) }),`)
    L.push(`    mutateDestroy: () => useMutation({ mutationFn: (id: number | string) => client.${clientKey}.destroy({ ${scopeSpread}id }) }),`)
  }

  if (ctrl.kind === 'singleton' && modelName) {
    L.push(`    get:          () => useQuery({ queryKey: ${keysRef}!.singleton(scopes), queryFn: () => client.${clientKey}.get({ ${scopeSpread} }) }),`)
    L.push(`    mutateUpdate: () => useMutation({ mutationFn: (data: ${modelName}Write) => client.${clientKey}.update({ ${scopeSpread}data }) }),`)
  }

  // @mutation
  for (const mut of ctrl.mutations) {
    const hookName = mut.bulk ? toBulkMutateName(mut.method) : toMutateName(mut.method)
    if (mut.bulk) {
      L.push(`    ${hookName}: () => useMutation({ mutationFn: (ids: (number | string)[]) => client.${clientKey}.${mut.method}({ ${scopeSpread}ids }) }),`)
    } else {
      L.push(`    ${hookName}: () => useMutation({ mutationFn: (id: number | string) => client.${clientKey}.${mut.method}({ ${scopeSpread}id }) }),`)
    }
  }

  // @attachable upload hooks
  if (ctrl.attachable) {
    const modelKey = ctrl.modelClass ? lcFirst(ctrl.modelClass) : lcFirst(ctrl.className.replace(/Controller$/, ''))
    const attConstName = `${modelKey}Attachments`
    L.push(`    // ── Attachable hooks ─────────────────────────────────────────────`)
    L.push(`    mutatePresign:  () => useMutation({ mutationFn: (input: { filename: string; contentType: string; name: string }) => client.${clientKey}.presign({ ${scopeSpread}...input }) }),`)
    L.push(`    mutateConfirm:  () => useMutation({ mutationFn: (input: { assetId: number }) => client.${clientKey}.confirm({ ${scopeSpread}...input }) }),`)
    L.push(`    mutateAttach:   () => useMutation({ mutationFn: (input: { assetId: number; name: string; attachableId: number }) => client.${clientKey}.attach({ ${scopeSpread}...input }) }),`)
    L.push(`    useUpload:      (name: keyof typeof ${attConstName}, options?: UseUploadOptions) => useUploadFactory(`)
    L.push(`      { presign: (input: any) => client.${clientKey}.presign({ ${scopeSpread}...input }), confirm: (input: any) => client.${clientKey}.confirm({ ${scopeSpread}...input }) },`)
    L.push(`      { ...${attConstName}[name], name: name as string } as AttachmentMeta,`)
    L.push(`      options,`)
    L.push(`    ),`)
    L.push(`    useMultiUpload: (name: keyof typeof ${attConstName}, options?: UseMultiUploadOptions) => useMultiUploadFactory(`)
    L.push(`      { presign: (input: any) => client.${clientKey}.presign({ ${scopeSpread}...input }), confirm: (input: any) => client.${clientKey}.confirm({ ${scopeSpread}...input }) },`)
    L.push(`      { ...${attConstName}[name], name: name as string } as AttachmentMeta,`)
    L.push(`      options,`)
    L.push(`    ),`)
  }

  // @action — GET → useQuery with 'index' prefix; everything else → useMutation with 'mutate' prefix
  for (const act of ctrl.actions) {
    const actionKey = toActionClientKey(act, clientKey)
    if (act.httpMethod === 'GET') {
      const hookName = toIndexName(act.method)
      if (act.load) {
        // Record-level GET: takes id, uses detail cache key
        const qk = keysRef
          ? `${keysRef}.detail(id ?? 0, scopes)`
          : `['${lcFirst(ctrl.className)}', scopes, id, '${act.method}']`
        L.push(`    ${hookName}: (id: number | string | null | undefined) => useQuery({ queryKey: ${qk}, queryFn: () => client.${actionKey}({ ${scopeSpread}id }), enabled: id != null }),`)
      } else {
        const qk = keysRef
          ? `[...${keysRef}.root(scopes), '${act.method}']`
          : `['${lcFirst(ctrl.className)}', scopes, '${act.method}']`
        L.push(`    ${hookName}: () => useQuery({ queryKey: ${qk}, queryFn: () => client.${actionKey}({ ${scopeSpread} }) }),`)
      }
    } else {
      const hookName = toMutateName(act.method)
      if (act.load) {
        // Record-level mutation: fn takes (id, data?)
        const dataArg = act.inputType ? `, data: ${act.inputType}` : ''
        const dataSpread = act.inputType ? ', data' : ''
        L.push(`    ${hookName}: () => useMutation({ mutationFn: ({ id${dataSpread} }: { id: number | string${dataArg} }) => client.${actionKey}({ ${scopeSpread}id${dataSpread} }) }),`)
      } else {
        const inputArg = act.inputType ? `(data: ${act.inputType})` : `(data?: Record<string, unknown>)`
        L.push(`    ${hookName}: () => useMutation({ mutationFn: ${inputArg} => client.${actionKey}({ ${scopeSpread}data }) }),`)
      }
    }
  }
}

// ── .with() body ──────────────────────────────────────────────────────────────

function emitWith(L: string[], ctrl: CtrlMeta, clientKey: string): void {
  const modelName   = ctrl.modelClass
  const scopeSpread = ctrl.scopes.length > 0 ? '...scopes, ' : ''

  if (ctrl.kind === 'crud' && modelName) {
    L.push(`    index:         (params?: ${modelName}SearchState) => client.${clientKey}.index({ ${scopeSpread}...params }),`)
    L.push(`    infiniteIndex: (params?: Omit<${modelName}SearchState, 'page'>) => client.${clientKey}.index({ ${scopeSpread}...params }),`)
    L.push(`    get:           (id: number | string) => client.${clientKey}.get({ ${scopeSpread}id }),`)
    L.push(`    mutateCreate:  (data: ${modelName}Write) => client.${clientKey}.create({ ${scopeSpread}data }),`)
    L.push(`    mutateUpdate:  (id: number | string, data: Partial<${modelName}Write>) => client.${clientKey}.update({ ${scopeSpread}id, data }),`)
    L.push(`    mutateDestroy: (id: number | string) => client.${clientKey}.destroy({ ${scopeSpread}id }),`)
  }

  if (ctrl.kind === 'singleton' && modelName) {
    L.push(`    get:          () => client.${clientKey}.get({ ${scopeSpread} }),`)
    L.push(`    mutateUpdate: (data: ${modelName}Write) => client.${clientKey}.update({ ${scopeSpread}data }),`)
  }

  // @mutation
  for (const mut of ctrl.mutations) {
    const fnName = mut.bulk ? toBulkMutateName(mut.method) : toMutateName(mut.method)
    if (mut.bulk) {
      L.push(`    ${fnName}: (ids: (number | string)[]) => client.${clientKey}.${mut.method}({ ${scopeSpread}ids }),`)
    } else {
      L.push(`    ${fnName}: (id: number | string) => client.${clientKey}.${mut.method}({ ${scopeSpread}id }),`)
    }
  }

  // @attachable async functions
  if (ctrl.attachable) {
    L.push(`    presign:  (input: { filename: string; contentType: string; name: string }) => client.${clientKey}.presign({ ${scopeSpread}...input }),`)
    L.push(`    confirm:  (input: { assetId: number }) => client.${clientKey}.confirm({ ${scopeSpread}...input }),`)
    L.push(`    attach:   (input: { assetId: number; name: string; attachableId: number }) => client.${clientKey}.attach({ ${scopeSpread}...input }),`)
  }

  // @action
  for (const act of ctrl.actions) {
    const actionKey = toActionClientKey(act, clientKey)
    const fnName = act.httpMethod === 'GET' ? toIndexName(act.method) : toMutateName(act.method)
    if (act.load) {
      // Record-level: first arg is id; second optional arg is data
      const dataArg = act.inputType ? `, data: ${act.inputType}` : ''
      const dataSpread = act.inputType ? ', data' : ''
      L.push(`    ${fnName}: (id: number | string${dataArg}) => client.${actionKey}({ ${scopeSpread}id${dataSpread} }),`)
    } else if (act.inputType) {
      L.push(`    ${fnName}: (data: ${act.inputType}) => client.${actionKey}({ ${scopeSpread}data }),`)
    } else {
      L.push(`    ${fnName}: (data?: Record<string, unknown>) => client.${actionKey}({ ${scopeSpread}...data }),`)
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
 * Controller projection field set: permit-listed write fields ∪ get/index includes ∪ id.
 * Validations ship to this Client iff deps ⊆ this set.
 */
/**
 * Attr kind for a projected field: semantic refinement (email/url/uuid from
 * Validates.*) unions with the base kind — `'email' | 'string'` — so BOTH
 * semantic presenters (emailInput) and base-kind presenters (text) are legal
 * at typed call sites. Then meta kind → state/enum → column type.
 */
/** Resolve the child model an acceptsNested association points at. */
function nestedChildModel(assoc: any, projectMeta: ProjectMeta | null): ModelMeta | null {
  const table = assoc.resolvedTable ?? assoc.explicitTable ?? pluralize(assoc.propertyName)
  return projectMeta?.models.find(m => m.tableName === table) ?? null
}

/**
 * Every model reachable through acceptsNested from `root` — transitively, so
 * grandchildren and deeper count. Used to decide which runtime imports the
 * generated file needs (e.g. Validates when a deep child ships a validator).
 * Cycle-safe via `seen`.
 */
function collectNestedModelsDeep(
  root: ModelMeta | null,
  projectMeta: ProjectMeta | null,
  seen: Set<string> = new Set(),
): ModelMeta[] {
  if (!root || seen.has(root.tableName)) return []
  seen.add(root.tableName)
  const out: ModelMeta[] = []
  for (const a of root.associations ?? []) {
    if (!a.acceptsNested) continue
    const child = nestedChildModel(a, projectMeta)
    if (!child || seen.has(child.tableName)) continue
    out.push(child, ...collectNestedModelsDeep(child, projectMeta, seen))
  }
  return out
}

/**
 * One `<assoc>: { kind: 'nested', … }` meta entry — RECURSIVELY. The child's
 * own acceptsNested associations become grandchild `kind: 'nested'` entries
 * nested inside its `fields`, to arbitrary depth. `visited` (owner table
 * names down this branch) breaks self-referential cycles: a category whose
 * children are categories emits one level, then truncates with a warning.
 *
 * Server-forced fields never appear as editable child inputs: the primary
 * key, the parent foreign key, and the STI discriminator `type` are omitted
 * (the server sanitizer strips them anyway).
 */
function renderNestedMetaEntry(
  assoc: any,
  ownerTableName: string,
  projectMeta: ProjectMeta | null,
  visited: Set<string>,
  instantCtx?: { controllerKeys: Set<string>; sink: Set<string> },
): string | null {
  const childModel = nestedChildModel(assoc, projectMeta)
  if (!childModel) return null
  const childTable = childModel.tableName
  const childCols = projectMeta?.schema.tables[childTable]?.columns ?? []
  const childColTypes = new Map(childCols.map(c => [c.name, c.type as string]))
  const parentFk = assoc.foreignKey ?? `${pluralize.singular(ownerTableName)}Id`

  const parts: string[] = []
  for (const col of childCols) {
    if (col.primaryKey) continue
    if (col.name === parentFk || col.name === 'type') continue
    const cm = childModel.fieldMeta?.[col.name]
    const kind = cm?.semantic ?? cm?.kind ?? fieldKind(col.name, childModel, childColTypes)
    const label = cm?.label ? `, label: ${JSON.stringify(cm.label)}` : ''
    parts.push(`${col.name}: { kind: '${kind}'${label} }`)
  }

  // Grandchildren — recurse, guarding cycles
  const nextVisited = new Set(visited).add(childTable)
  for (const grand of childModel.associations ?? []) {
    if (!grand.acceptsNested) continue
    const grandModel = nestedChildModel(grand, projectMeta)
    if (!grandModel) continue
    if (nextVisited.has(grandModel.tableName)) {
      console.warn(
        `[active-drizzle codegen] nested cycle at ${childModel.className}.${grand.propertyName} `
        + `→ ${grandModel.tableName}; deeper nesting truncated (the runtime still handles any `
        + `depth you author by hand).`,
      )
      continue
    }
    const grandEntry = renderNestedMetaEntry(grand, childTable, projectMeta, nextVisited, instantCtx)
    if (grandEntry) parts.push(grandEntry)
  }

  const orderBy = assoc.order && typeof assoc.order === 'object' ? Object.keys(assoc.order)[0] : undefined
  const acceptsOpt = (assoc.options as any)?.acceptsNested
  const allowDestroy = typeof acceptsOpt === 'object' && acceptsOpt?.allowDestroy === true
  // Instant nested writes: opted in on the association AND a controller exists
  // for the child resource. resource = the child's client namespace; foreignKey
  // is forced server-side so the widget never sends it.
  const instantOptedIn = typeof acceptsOpt === 'object' && acceptsOpt?.instant === true
  const instantOn = instantOptedIn && Boolean(instantCtx?.controllerKeys.has(childTable))
  if (instantOn) instantCtx!.sink.add(childTable)
  const instantPart = instantOn ? `, instant: true, resource: '${childTable}', foreignKey: '${parentFk}'` : ''
  const childShippable = Object.entries(childModel.propertyValidations ?? {}).filter(([p]) =>
    (childModel.propertyValidationAnalysis?.[p]?.foreignRefs?.length ?? 0) === 0,
  )
  let validatePart = ''
  if (childShippable.length > 0) {
    const runs = childShippable.map(([p, code]) => `_run('${p}', (${code}), (d as any).${p})`).join('; ')
    validatePart = `, validate: (d: any) => { const e: Record<string, string[]> = {}; const _push = (f: string, m: unknown) => { if (typeof m === 'string' && m.trim()) (e[f] ??= []).push(m.trim()) }; const _run = (f: string, v: any, val: any) => { const l = Array.isArray(v) ? v : [v]; for (const fn of l) { if (typeof fn !== 'function') continue; try { _push(f, fn(val, d, f)) } catch { /* server-only gate */ } } }; ${runs}; return e }`
  }
  return `${assoc.propertyName}: { kind: 'nested', allowDestroy: ${allowDestroy}${instantPart}${orderBy ? `, orderBy: '${orderBy}'` : ''}${validatePart}, fields: { ${parts.join(', ')} } }`
}

function fieldKind(
  field: string,
  model: ModelMeta,
  colTypes: Map<string, string>,
): string {
  const semantic = model.fieldMeta?.[field]?.semantic
  if (semantic) {
    const base = model.fieldMeta?.[field]?.kind ?? 'string'
    return `${semantic}' | '${base}`   // caller wraps in quotes → 'email' | 'string'
  }
  const metaKind = model.fieldMeta?.[field]?.kind
  if (metaKind) return metaKind
  if (model.states?.some(s => s.propertyName === field)) return 'state'
  if (model.enums?.some(e => e.propertyName === field)) return 'enum'
  const t = colTypes.get(field)
  switch (t) {
    case 'integer': case 'smallint': case 'bigint':
    case 'serial': case 'smallserial': case 'bigserial':
      return 'integer'
    case 'decimal': case 'numeric': case 'real': case 'doublePrecision':
      return 'decimal'
    case 'boolean': return 'boolean'
    case 'date': case 'timestamp': case 'timestamptz': return 'date'
    case 'json': case 'jsonb': return 'json'
    default: return 'string'
  }
}

/**
 * Emits the typed FormHandle + wired useEditForm/useNewForm for an envelope
 * controller. Field props are TypedFieldComponent<kind> — with an augmented
 * AdPresenterKinds, a wrong presenter/kind pairing is a compile error.
 */
function emitFormHooks(
  L: string[],
  ctrl: CtrlMeta,
  model: ModelMeta,
  projectMeta: ProjectMeta,
  projection: Set<string>,
  modelName: string,
  scopeFields: string[],
  scopeType: string,
  instantResources: Set<string> = new Set(),
): void {
  const clientKey = toClientKey(ctrl)
  const keysName = `${lcFirst(modelName)}Keys`
  const colTypes = new Map(
    (projectMeta.schema.tables[model.tableName]?.columns ?? []).map(c => [c.name, c.type as string]),
  )
  const fields = [...projection]
    .filter(f => colTypes.has(f) || model.fieldMeta?.[f] || model.states?.some(s => s.propertyName === f))
    .sort()
  const attachmentFields = (ctrl.attachments ?? []).map(a => ({
    name: a.name,
    kind: a.kind === 'many' ? 'attachmentMany' : 'attachmentOne',
  }))

  L.push(`/** Per-field typed handle — presenter names are kind-gated via AdPresenterKinds. */`)
  L.push(`export type ${modelName}FormHandle = FormHandleApi<${modelName}Client> & {`)
  for (const f of fields) {
    L.push(`  ${f}: TypedFieldComponent<'${fieldKind(f, model, colTypes)}'>`)
  }
  for (const a of attachmentFields) {
    L.push(`  ${a.name}: TypedFieldComponent<'${a.kind}'>`)
  }
  // belongsTo sugar members — <deal.owner> aliases the projected FK column
  for (const assoc of model.associations) {
    if (assoc.kind !== 'belongsTo' || assoc.polymorphic) continue
    const fk = assoc.foreignKey ?? `${assoc.propertyName}Id`
    if (!projection.has(fk) || fields.includes(assoc.propertyName)) continue
    L.push(`  ${assoc.propertyName}: TypedFieldComponent<'ref'>`)
  }
  // habtm sugar members — <deal.owners> aliases the projected `<singular>Ids` set
  for (const assoc of model.associations) {
    if (assoc.kind !== 'habtm') continue
    const idsKey = `${singularize(assoc.propertyName)}Ids`
    if (!projection.has(idsKey) || fields.includes(assoc.propertyName)) continue
    L.push(`  ${assoc.propertyName}: TypedFieldComponent<'refMany'>`)
  }
  L.push(`}`)
  L.push('')

  const hasScopes = scopeFields.length > 0
  const scopesParam = hasScopes ? `, scopes: ${scopeType}` : ''
  const scopesArg = hasScopes ? 'scopes' : '({} as Record<string, never>)'
  const scopeSpread = hasScopes ? '...scopes, ' : ''

  // Shared transport error mapping to the FormSession contract
  L.push(`function _${lcFirst(modelName)}SubmitResult(e: unknown): SubmitResult {`)
  L.push(`  const parsed = parseControllerError(e)`)
  L.push(`  const status = parsed?.isValidation ? 422`)
  L.push(`    : parsed?.isUnauthorized ? 401`)
  L.push(`    : parsed?.isForbidden ? 403`)
  L.push(`    : 500`)
  L.push(`  return { ok: false, status, ...(parsed?.fields ? { errors: parsed.fields } : {}) }`)
  L.push(`}`)
  L.push('')

  // Instant nested transports — one per child resource that opted in. Each
  // maps to the child controller's create/update/destroy; the nested manager
  // fires these optimistically when the parent row is already persisted.
  const transportsName = `_${lcFirst(modelName)}NestedTransports`
  if (instantResources.size > 0) {
    L.push(`const ${transportsName} = {`)
    for (const resource of instantResources) {
      L.push(`  ${resource}: {`)
      L.push(`    create: (data: any) => client.${resource}.create({ data }).then((row: any) => ({ ok: true, row })).catch(() => ({ ok: false })),`)
      L.push(`    update: (id: any, data: any) => client.${resource}.update({ id, data }).then((row: any) => ({ ok: true, row })).catch(() => ({ ok: false })),`)
      L.push(`    destroy: (id: any) => client.${resource}.destroy({ id }).then(() => ({ ok: true })).catch(() => ({ ok: false })),`)
      L.push(`  },`)
    }
    L.push(`}`)
    L.push('')
  }
  const transportsLine = instantResources.size > 0 ? `    nestedTransports: ${transportsName},` : null

  // Generated hooks are THIN wiring — identity keying, refetch rehydration,
  // and StrictMode safety live in useGeneratedForm (tested in the package)
  L.push(`/** Envelope-wired edit form. Session is keyed by id: navigating between records rebuilds; refetches rehydrate a CLEAN draft (dirty edits are never clobbered). */`)
  L.push(`export function use${modelName}EditForm(id: number${scopesParam}): { status: 'loading' | 'error' | 'ready'; form: ${modelName}FormHandle | null } {`)
  L.push(`  const qc = useQueryClient()`)
  L.push(`  const _scopes = ${scopesArg}`)
  L.push(`  const query = useQuery({`)
  L.push(`    queryKey: ${keysName}.detail(id, _scopes as any),`)
  L.push(`    queryFn: () => client.${clientKey}.get({ ${scopeSpread}id }),`)
  L.push(`  })`)
  L.push(`  const { form } = useGeneratedForm<${modelName}Client>({`)
  L.push(`    formKey: id,`)
  L.push(`    mode: 'edit',`)
  L.push(`    data: query.data ?? null,`)
  L.push(`    makeDraft: (r) => new ${modelName}Client(r),`)
  L.push(`    fieldMeta: (${modelName}Client as any).fieldMeta ?? {},`)
  if (transportsLine) L.push(transportsLine)
  L.push(`    submit: async ({ data, _event }) => {`)
  L.push(`      try {`)
  L.push(`        const res: any = await client.${clientKey}.update({ ${scopeSpread}id, data: _event ? { ...data, _event } : data })`)
  L.push(`        qc.invalidateQueries({ queryKey: ${keysName}.root(_scopes as any) })`)
  L.push(`        // Envelope responses always flow through so abilities/can re-mask`)
  L.push(`        return { ok: true, ...(res && typeof res === 'object' && 'record' in res ? { envelope: res } : {}) }`)
  L.push(`      } catch (e) { return _${lcFirst(modelName)}SubmitResult(e) }`)
  L.push(`    },`)
  L.push(`  })`)
  L.push(`  return { status: query.isError ? 'error' : form ? 'ready' : 'loading', form: form as ${modelName}FormHandle | null }`)
  L.push(`}`)
  L.push('')

  L.push(`/** New-record form: defaults draft; submit POSTs to create. */`)
  L.push(`export function use${modelName}NewForm(${hasScopes ? `scopes: ${scopeType}` : ''}): { status: 'ready'; form: ${modelName}FormHandle } {`)
  L.push(`  const qc = useQueryClient()`)
  L.push(`  const _scopes = ${scopesArg}`)
  L.push(`  const { form } = useGeneratedForm<${modelName}Client>({`)
  L.push(`    formKey: 'new',`)
  L.push(`    mode: 'new',`)
  L.push(`    data: null,`)
  L.push(`    makeDraft: (r) => new ${modelName}Client(r),`)
  L.push(`    fieldMeta: (${modelName}Client as any).fieldMeta ?? {},`)
  if (transportsLine) L.push(transportsLine)
  L.push(`    submit: async ({ data }) => {`)
  L.push(`      try {`)
  L.push(`        const res: any = await client.${clientKey}.create({ ${scopeSpread}data })`)
  L.push(`        qc.invalidateQueries({ queryKey: ${keysName}.root(_scopes as any) })`)
  L.push(`        return { ok: true, ...(res && typeof res === 'object' && 'record' in res ? { envelope: res } : {}) }`)
  L.push(`      } catch (e) { return _${lcFirst(modelName)}SubmitResult(e) }`)
  L.push(`    },`)
  L.push(`  })`)
  L.push(`  return { status: 'ready', form: form as ${modelName}FormHandle }`)
  L.push(`}`)
  L.push('')
}

/**
 * True when `body` calls a `this.<method>()` that the generated controller
 * Client will not have. Property READS (`this.amount`) are fine — only calls
 * are checked. Fail-closed: any unknown call name keeps the validator
 * server-side rather than shipping code that throws in the browser.
 */
function bodyCallsUnavailableMethods(body: string, available: Set<string>): boolean {
  const re = /\bthis\.([A-Za-z_$][\w$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (!available.has(m[1]!)) return true
  }
  return false
}

function controllerProjectionFields(
  ctrl: CtrlMeta,
  model: ModelMeta,
  writableFields: string[],
): Set<string> {
  // `expose` is the read ceiling — when declared, it IS the projection.
  // Data availability (what the client can SEE), not editability, is the
  // correct fail-closed boundary for shipping validators/guards/predicates:
  // a rule reading a view-only field can still run client-side because the
  // draft carries that field.
  const expose = ctrl.crudConfig?.get?.expose
  if (expose?.length) {
    const fields = new Set<string>(['id', ...expose])
    for (const inc of ctrl.crudConfig?.get?.include ?? []) fields.add(inc)
    for (const inc of ctrl.crudConfig?.index?.include ?? []) fields.add(inc)
    return fields
  }

  // Legacy fallback (no expose declared): permit ∪ includes
  const fields = new Set<string>(['id', ...writableFields])
  for (const inc of ctrl.crudConfig?.get?.include ?? []) fields.add(inc)
  for (const inc of ctrl.crudConfig?.index?.include ?? []) fields.add(inc)
  return fields
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
/** Mirrors the runtime's _singularize — the habtm ids key MUST match what save() accepts. */
function singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }
