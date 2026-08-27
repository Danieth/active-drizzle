/**
 * The columnar-doors pass — the build-time gate for `wire: 'columnar'`
 * (transport WS2, DESIGN-wire-identity §1/§2).
 *
 * The flag is per-door (the door is the migration unit) and ONE extracted
 * source — CtrlCrudConfig.wire — drives both the runtime serializer branch
 * and the generated hook bodies. This pass refuses, with teaching errors,
 * every configuration the columnar envelope cannot represent or the write
 * path cannot protect:
 *
 *   W1  columnar requires `get.expose` — the k header IS the column picking;
 *       without a ceiling there is nothing to pick from.
 *   W2  columnar + an included hasMany requires `update.optimisticLock`:
 *       the included collection rides the OWNER as an ordered pk-array
 *       column versioned with the owner's token, and a reorder/membership
 *       edit is a structural write that must CAS the owner (wire-identity
 *       §1 — the array form is refused where the write path can't CAS it;
 *       silent LWW-lost-add is the failure mode).
 *   W3  columnar is refused (v1) on STI-parent doors whose subclasses
 *       declare divergent exposed field surfaces: columnar JSON has ONE k
 *       header per table and cannot express per-row absence, and
 *       absence ≠ null is load-bearing (A0 footnote). A per-table absence
 *       bitmap is a later phase, not a hole.
 *   W4  columnar includes must be flat-loadable and identity-addressable:
 *       habtm / hasMany-through (join-table batching is a later phase) and
 *       polymorphic belongsTo (no fixed identity table) are refused — at
 *       EVERY depth of the include tree, matching the runtime refusals.
 *   W5  columnar requires `get: { abilities: true }` — flagged doors always
 *       serve the record envelope, and a door without abilities was serving
 *       a BARE record, so flipping the flag would change the app-visible
 *       hook shape (P6 forbids that).
 *   W6  a hasOne in the INDEX include tree is refused: store-materialized
 *       list rows cannot re-nest hasOne (no FK index client-side), so the
 *       member would silently vanish on flag flip.
 *   W7  columnar + an explicit `access:` ceiling: every declared include
 *       (get + index, recursively) must appear in the access include tree —
 *       the ceiling is TOTAL, and an undeclared include would serialize the
 *       child table whole past it. The runtime serializer refuses the same.
 *   W8  columnar + `access:` alongside a diverging `get.expose` is refused —
 *       the server's k header comes from the access node while the client's
 *       projection mask derives from expose; disagreement renders exposed
 *       fields as silent undefined.
 *
 * Runs beside validateVersionedModels in the vite strict gate (both change
 * lanes) — it needs controller config × model associations × STI shape at
 * once, so no single-model validate() sees it.
 */
import type { CtrlProjectMeta, CtrlMeta } from './controller-types.js'
import type { ProjectMeta, ModelMeta, Diagnostic } from './types.js'
import { resolveLockColumnName } from '../runtime/optimistic-lock.js'
import { projIdFor, fieldsRevOf, WRITE_LOG_SCHEMA_SQL } from '../runtime/write-log.js'

const WIRE_VALUES = new Set(['columnar', 'nested'])

function warn(modelFile: string, message: string, suggestion?: string): Diagnostic {
  return { severity: 'warning', modelFile, message, ...(suggestion ? { suggestion } : {}) }
}

function err(modelFile: string, message: string, suggestion?: string): Diagnostic {
  const d: Diagnostic = { severity: 'error', modelFile, message }
  if (suggestion !== undefined) d.suggestion = suggestion
  return d
}

/** Top-level association names of a (possibly nested) include list — the ONE
 *  shape-walking helper (react-generator imports it too; DRY). */
export function includeTopNames(specs: any[] | undefined): string[] {
  const names: string[] = []
  for (const inc of specs ?? []) {
    if (typeof inc === 'string') names.push(inc)
    else if (inc && typeof inc === 'object') names.push(...Object.keys(inc))
  }
  return names
}

/** [name, children[]] entries of one include list level. */
function includeEntries(specs: any[] | undefined): Array<[string, any[]]> {
  const out: Array<[string, any[]]> = []
  for (const inc of specs ?? []) {
    if (typeof inc === 'string') out.push([inc, []])
    else if (inc && typeof inc === 'object') {
      for (const [k, v] of Object.entries(inc)) out.push([k, Array.isArray(v) ? v : []])
    }
  }
  return out
}

/**
 * The read ceiling a columnar door serves — `get.expose` when declared,
 * otherwise the `access:` node's viewable∪editable (the @crud decorator
 * desugars access into expose at runtime; extraction sees the source form).
 * Shared with the react generator so the client's _WireFields mask derives
 * from the SAME source the server's k header uses.
 */
export function effectiveExpose(crudConfig: any): string[] | undefined {
  const expose: string[] | undefined = crudConfig?.get?.expose
  if (expose?.length) return expose
  const access = crudConfig?.access
  if (access && (Array.isArray(access.editable) || Array.isArray(access.viewable))) {
    return [...new Set([...(access.editable ?? []), ...(access.viewable ?? [])])]
  }
  return undefined
}

/** All STI subclasses (transitive) of `parent` in the project. */
function stiSubclassesOf(parent: ModelMeta, models: ModelMeta[]): ModelMeta[] {
  const byParent = new Map<string, ModelMeta[]>()
  for (const m of models) {
    if (!m.stiParent) continue
    const list = byParent.get(m.stiParent)
    if (list) list.push(m)
    else byParent.set(m.stiParent, [m])
  }
  const out: ModelMeta[] = []
  const stack = [parent.className]
  while (stack.length) {
    for (const sub of byParent.get(stack.pop()!) ?? []) {
      out.push(sub)
      stack.push(sub.className)
    }
  }
  return out
}

/** The field surface a subclass DECLARES itself (its own Attrs/enums/states). */
function declaredFieldSurface(m: ModelMeta): Set<string> {
  return new Set([
    ...Object.keys(m.fieldMeta ?? {}),
    ...m.enums.map(e => e.propertyName),
    ...(m.states ?? []).map(s => s.propertyName),
  ])
}

// ── WS3: the write-log registry (O10's codegen substrate) ────────────────────
//
// WHICH models are logged is DERIVED, never a knob: a model is logged iff it
// is lock-tokened AND appears (as root or include, at any depth) in a door
// with wire:'columnar' — logging piggybacks on the opt-in that already
// exists. This pass computes that set, each model's ONE declaration-order
// field numbering (+ fieldsRev hash for deploy-drift detection), and each
// door's projId = hash of its compiled validatable mask (scalar + belongsTo-
// FK columns ONLY — hasMany pk-array columns are EXCLUDED by construction:
// child commits do not bump the owner's token or appear in the owner's
// previousChanges, so A2′ clause (i) over a pk-array is unanswerable from
// the owner's write-log; list/child freshness rides the membership-tag lane
// and per-child validation instead).
//
// The runtime backstop (plugin-less apps) computes the same set at router
// build via registerLoggedModel/validatableMask — packages/controller/src/
// validate-handler.ts. The hash helpers are SHARED (runtime/write-log.ts) so
// codegen, server, and generated client can never disagree by construction.

export interface WriteLogModelEntry {
  className: string
  /** Schema export identifier — the identity space (matches runtime tableName). */
  tableName: string
  /** THE model-level numbering: all table columns in declaration order. */
  fields: string[]
  fieldsRev: string
  lockColumn: string
  softDelete: boolean
}

export interface WriteLogDoorEntry {
  controller: string
  modelClass: string
  tableName: string
  /** The validatable mask: pk + exposed physical columns + included
   *  belongsTo FKs. hasMany pk-arrays excluded (see header note). */
  maskFields: string[]
  projId: string
}

export interface WriteLogRegistry {
  models: WriteLogModelEntry[]
  doors: WriteLogDoorEntry[]
}

/** Paste-ready drizzle fragment for the transport tables (schema authoring). */
export const WRITE_LOG_DRIZZLE_SNIPPET = `
export const recordWriteLog = pgTable('record_write_log', {
  model:       text('model').notNull(),
  pk:          text('pk').notNull(),
  token:       bigint('token', { mode: 'number' }).notNull(),
  changed:     customType<{ data: Buffer }>({ dataType: () => 'bytea' })('changed').notNull(),
  lifecycle:   smallint('lifecycle').notNull().default(0),
  committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.model, t.pk, t.token] })])

export const recordWriteLogMeta = pgTable('record_write_log_meta', {
  model:      text('model').primaryKey(),
  fieldsHash: text('fields_hash').notNull(),
})

export const membershipTags = pgTable('membership_tags', {
  door: text('door').primaryKey(),
  tag:  bigint('tag', { mode: 'number' }).notNull().default(0),
})`.trim()

/**
 * Does this model's table actually carry its resolved lock column?
 * Exported: the react generator gates the client validation-transport
 * emission on it, symmetric with the server (an unlogged root's validate
 * route answers the conservative slice — a client should not be generated
 * to call a lane that can never 304).
 */
export function physicalLockColumnOf(m: ModelMeta, project: ProjectMeta): string | null {
  const col = resolveLockColumnName(m.lockingColumn)
  if (col === null) return null
  const table = project.schema.tables[m.tableName]
  return table?.columns.some(c => c.name === col) ? col : null
}

/** Every model reached by a door's include trees (get + index), root included. */
function reachableModels(ctrl: CtrlMeta, project: ProjectMeta): ModelMeta[] {
  const root = ctrl.modelClass
    ? project.models.find(m => m.className === ctrl.modelClass)
    : undefined
  if (!root) return []
  const modelByTable = new Map(project.models.map(m => [m.tableName, m]))
  const out = new Map<string, ModelMeta>([[root.tableName, root]])
  const walk = (specs: any[] | undefined, owner: ModelMeta): void => {
    for (const [name, children] of includeEntries(specs)) {
      const assoc = owner.associations.find(a => a.propertyName === name)
      const childTable = assoc?.resolvedTable ?? assoc?.explicitTable
      const child = childTable ? modelByTable.get(childTable) : undefined
      if (!child) continue
      if (!out.has(child.tableName)) out.set(child.tableName, child)
      if (children.length) walk(children, child)
    }
  }
  walk((ctrl.crudConfig as any)?.get?.include, root)
  walk((ctrl.crudConfig as any)?.index?.include, root)
  return [...out.values()]
}

/** The door's compiled validatable mask (see registry header). Empty when the
 *  door has no ceiling — such a door cannot validate and gets no projId. */
export function validatableMaskFields(ctrl: CtrlMeta, project: ProjectMeta): string[] {
  const model = ctrl.modelClass
    ? project.models.find(m => m.className === ctrl.modelClass)
    : undefined
  const expose = effectiveExpose(ctrl.crudConfig)
  if (!model || !expose?.length) return []
  const table = project.schema.tables[model.tableName]
  const physical = new Set((table?.columns ?? []).map(c => c.name))
  const pk = (table?.columns ?? []).find(c => c.primaryKey)?.name ?? 'id'
  const mask = new Set<string>([pk])
  for (const f of expose) if (physical.has(f)) mask.add(f)
  // Included belongsTo FKs ride the columnar row as linkage columns and are
  // part of the door's projection even when expose omits them.
  for (const [name] of includeEntries((ctrl.crudConfig as any)?.get?.include)) {
    const assoc = model.associations.find(a => a.propertyName === name)
    if (assoc?.kind !== 'belongsTo' || assoc.polymorphic) continue
    const fk = assoc.foreignKey ?? `${name}Id`
    if (physical.has(fk)) mask.add(fk)
  }
  const lockCol = resolveLockColumnName(model.lockingColumn)
  if (lockCol) mask.delete(lockCol)   // the token is never a wire field (WS0)
  return [...mask]
}

/**
 * The write-log registry for a project: logged models (with THE field
 * numbering + fieldsRev) and columnar-door projIds. Consumed today by the
 * react generator (embedded mask + projId literals) and by
 * validateWriteLogSchema (the vite gate); the runtime backstop
 * (registerColumnarDoorTransport) mirrors the same derivation at router
 * build. A codegen-EMITTED server registry — making the mask ONE
 * computation instead of two twins sharing one rule — is the named
 * follow-up in DESIGN-transport-work WS3.
 */
export function computeWriteLogRegistry(
  ctrlProject: CtrlProjectMeta,
  project: ProjectMeta,
): WriteLogRegistry {
  const models = new Map<string, WriteLogModelEntry>()
  const doors: WriteLogDoorEntry[] = []
  for (const ctrl of ctrlProject.controllers) {
    if ((ctrl.crudConfig as any)?.wire !== 'columnar') continue
    for (const m of reachableModels(ctrl, project)) {
      const lockCol = physicalLockColumnOf(m, project)
      if (!lockCol) continue                       // untracked lane — never logged
      if (!models.has(m.tableName)) {
        const table = project.schema.tables[m.tableName]
        const fields = (table?.columns ?? []).map(c => c.name)
        models.set(m.tableName, {
          className: m.className,
          tableName: m.tableName,
          fields,
          fieldsRev: fieldsRevOf(fields),
          lockColumn: lockCol,
          softDelete: Boolean(m.softDelete),
        })
      }
    }
    const rootModel = ctrl.modelClass
      ? project.models.find(m => m.className === ctrl.modelClass)
      : undefined
    if (rootModel && physicalLockColumnOf(rootModel, project)) {
      const maskFields = validatableMaskFields(ctrl, project)
      if (maskFields.length) {
        doors.push({
          controller: ctrl.className,
          modelClass: rootModel.className,
          tableName: rootModel.tableName,
          maskFields,
          projId: projIdFor(maskFields),
        })
      }
    }
  }
  return { models: [...models.values()], doors }
}

/**
 * O2a-pattern teaching refusal: a project whose columnar doors imply logged
 * models MUST declare the transport tables in its schema — the log row
 * commits inside every data transaction, so a missing table fails every
 * write on those models at runtime. Separate from validateColumnarDoors so
 * the vite gate can adopt it per-project (paste-ready fix in the message).
 */
export function validateWriteLogSchema(
  ctrlProject: CtrlProjectMeta,
  project: ProjectMeta,
): Diagnostic[] {
  const registry = computeWriteLogRegistry(ctrlProject, project)
  if (registry.models.length === 0) return []
  const missing = ['record_write_log', 'record_write_log_meta', 'membership_tags']
    .filter(t => !Object.values(project.schema.tables).some(tb => tb.dbName === t || tb.name === t))
  if (missing.length === 0) return []
  const doorList = registry.models.map(m => m.className).join(', ')
  return [{
    severity: 'error',
    modelFile: project.schema.filePath,
    message:
      `wire:'columnar' doors make ${doorList} write-logged (validation 304s and gone(D) depend ` +
      `on the per-commit log), but the schema lacks ${missing.map(t => `'${t}'`).join(', ')} — ` +
      `every save on those models would refuse at runtime.`,
    suggestion:
      `Add the transport tables to the schema and migrate:\n${WRITE_LOG_SCHEMA_SQL}`,
  }]
}

export function validateColumnarDoors(
  ctrlProject: CtrlProjectMeta,
  project: ProjectMeta,
): Diagnostic[] {
  const out: Diagnostic[] = []

  for (const ctrl of ctrlProject.controllers) {
    const wire = ctrl.crudConfig?.wire
    if (wire === undefined) continue
    const file = ctrl.filePath

    if (!WIRE_VALUES.has(wire)) {
      out.push(err(
        file,
        `${ctrl.className}: wire: '${wire}' is not a wire format — the flag takes 'columnar' or ` +
        `'nested' (the default).`,
        `Set \`wire: 'columnar'\` to put this door on the columnar envelope, or delete the key.`,
      ))
      continue
    }
    if (wire !== 'columnar') continue

    const model = ctrl.modelClass
      ? project.models.find(m => m.className === ctrl.modelClass)
      : undefined

    // ── W1: the ceiling is the column picking ────────────────────────────────
    if (!effectiveExpose(ctrl.crudConfig)?.length) {
      out.push(err(
        file,
        `${ctrl.className} declares wire: 'columnar' without \`get: { expose: [...] }\` — the ` +
        `columnar k header is picked from the read ceiling, so a door without one has no columns ` +
        `to serve (and no ceiling means the nested lane was serving whole rows, which columnar ` +
        `deliberately refuses to replicate).`,
        `Declare the ceiling: \`get: { expose: ['field', ...] }\` — the same list the abilities ` +
        `envelope already wants.`,
      ))
    }

    // ── W5: flagged doors always serve the record envelope ──────────────────
    // (`access:` desugars abilities on at decoration time — accepted as-is.)
    if (!ctrl.crudConfig?.get?.abilities && !ctrl.crudConfig?.access) {
      out.push(err(
        file,
        `${ctrl.className} declares wire: 'columnar' without \`get: { abilities: true }\` — a ` +
        `flagged door's show/echo responses are ALWAYS the record envelope ({ record, abilities, ` +
        `can, version }), so a door serving a bare record today would change its app-visible ` +
        `hook shape on flag flip (the flag is a transport migration, never an API change).`,
        `Add \`abilities: true\` beside the expose list, or keep \`wire: 'nested'\` on this door.`,
      ))
    }

    // ── W9: the validation lane needs the lock token ─────────────────────────
    // A columnar door whose root model has no PHYSICAL lock column is never
    // write-logged: the validate procedure can only answer the conservative
    // slice (correct, never a 304), the splice endpoint has no counter, and
    // the generated client emits no revalidate transport (symmetric skip).
    // Warn — the door still works, but the whole 304 lane is silently dead.
    if (model && !physicalLockColumnOf(model, project)) {
      out.push(warn(
        file,
        `${ctrl.className} (columnar): ${model.className}'s table has no lock-token column ` +
        `(resolved '${resolveLockColumnName(model.lockingColumn) ?? 'lockVersion'}' is not on ` +
        `'${model.tableName}'${model.lockingColumn === false ? `, and lockingColumn is false` : ''}) — ` +
        `the validation/304 lane and the membership counter need it, so this door will answer ` +
        `every revalidation with the full record and serve no membership tag.`,
        `Add the integer lock column (e.g. \`lockVersion: integer('lock_version').notNull().default(0)\`) ` +
        `and enable \`update: { optimisticLock: true }\`, or accept the always-refetch behavior.`,
      ))
    }

    // ── W2/W4/W6: the include TREE, recursively (matching the runtime) ──────
    if (model) {
      const doorHasLock = Boolean(ctrl.crudConfig?.update?.optimisticLock)
      const modelByTable = new Map(project.models.map(m => [m.tableName, m]))

      const seenIdxHasOne = new Set<string>()
      const walk = (specs: any[] | undefined, owner: ModelMeta, depth: number, inIndexTree: boolean, seen: Set<string>): void => {
        for (const [name, children] of includeEntries(specs)) {
          const key = `${owner.tableName}.${name}`
          const dup = seen.has(key)
          seen.add(key)
          const assoc = owner.associations.find(a => a.propertyName === name)
          if (!assoc) continue // unresolvable include — the runtime/other passes own that error
          const at = depth === 0 ? `'${name}'` : `'${name}' (nested include)`
          if (!dup && (assoc.kind === 'habtm' || (assoc.kind === 'hasMany' && assoc.through))) {
            out.push(err(
              file,
              `${ctrl.className} (columnar) includes ${at}, a ` +
              `${assoc.kind === 'habtm' ? 'habtm' : 'hasMany-through'} association — join-table ` +
              `batching is not in flat loading v1, so the columnar wire cannot serve it.`,
              `Give '${name}' its own paged door` +
              (assoc.kind === 'habtm' ? ` (or expose the habtm ids column instead)` : '') +
              `, or keep \`wire: 'nested'\` on this door.`,
            ))
            continue
          }
          if (!dup && assoc.kind === 'belongsTo' && assoc.polymorphic) {
            out.push(err(
              file,
              `${ctrl.className} (columnar) includes ${at}, a POLYMORPHIC belongsTo — its rows ` +
              `have no fixed identity table, so they cannot ride a single entity section.`,
              `Expose the concrete association, or keep \`wire: 'nested'\` on this door.`,
            ))
            continue
          }
          // W6: list rows are store-materialized, and the store has no FK
          // index — a hasOne anywhere in the INDEX tree cannot be re-nested,
          // so the member would silently vanish from list rows on flag flip.
          // (Own dedupe set: the same hasOne may legally sit in the GET tree.)
          if (assoc.kind === 'hasOne' && inIndexTree && !seenIdxHasOne.has(key)) {
            seenIdxHasOne.add(key)
            out.push(err(
              file,
              `${ctrl.className} (columnar) includes hasOne ${at} in the INDEX include tree — ` +
              `store-materialized list rows cannot re-nest a hasOne (the client store keeps no ` +
              `FK index), so '${name}' would be silently undefined on every list row after the ` +
              `flag flip.`,
              `Move '${name}' to \`get.include\` (detail/echo responses re-nest it), expose the ` +
              `child through its own door, or keep \`wire: 'nested'\` on this door.`,
            ))
          }
          if (!dup && assoc.kind === 'hasMany') {
            if (depth === 0 && !doorHasLock) {
              out.push(err(
                file,
                `${ctrl.className} (columnar) includes hasMany '${name}' without ` +
                `\`update: { optimisticLock: true }\`. An included hasMany rides the owner as an ` +
                `ordered pk-array column VERSIONED WITH THE OWNER'S TOKEN — membership/reorder edits ` +
                `are structural writes that must compare-and-swap the owner, and without the lock a ` +
                `concurrent add is silently lost (LWW). The pk-array form is refused where the write ` +
                `path can't CAS it (wire-identity §1).`,
                `Either add \`update: { optimisticLock: true }\` (with the ` +
                `\`lockVersion: integer('lock_version').notNull().default(0)\` column — the ` +
                `versioned-models pass teaches the shape), or drop '${name}' from the include and ` +
                `give it its own paged door.`,
              ))
            }
            if (depth > 0) {
              // The pk-array's OWNER here is the intermediate child model —
              // its rows must carry a real lock column or the array rides
              // v=null in the untracked lane (silent LWW, W2's own rationale).
              const lockCol = resolveLockColumnName(owner.lockingColumn)
              const table = project.schema.tables[owner.tableName]
              const hasCol = lockCol !== null && Boolean(table?.columns.some(c => c.name === lockCol))
              if (!hasCol) {
                out.push(err(
                  file,
                  `${ctrl.className} (columnar) includes hasMany ${at} whose OWNER model ` +
                  `${owner.className} has no lock column${lockCol ? ` ('${lockCol}' is not on ` +
                  `'${owner.tableName}')` : ` (locking disabled)`} — the child pk-array would ride ` +
                  `at v = null in the untracked arrival-order lane, which is exactly the silent ` +
                  `last-write-wins the pk-array form is refused for (wire-identity §1).`,
                  `Add the \`lockVersion: integer('lock_version').notNull().default(0)\` column to ` +
                  `'${owner.tableName}', or drop '${name}' from the nested include.`,
                ))
              }
            }
          }
          const childTable = assoc.resolvedTable ?? assoc.explicitTable
          const childModel = childTable ? modelByTable.get(childTable) : undefined
          if (children.length && childModel) walk(children, childModel, depth + 1, inIndexTree, seen)
        }
      }

      const seen = new Set<string>()
      walk(ctrl.crudConfig?.get?.include as any[], model, 0, false, seen)
      walk(ctrl.crudConfig?.index?.include as any[], model, 0, true, seen)
    }

    // ── W7/W8: explicit `access:` ceilings ──────────────────────────────────
    const access = ctrl.crudConfig?.access
    if (access && typeof access === 'object') {
      // W8: a beside-it expose that diverges from the access ceiling makes
      // the server's k header and the client's projection mask disagree —
      // exposed-but-not-accessible fields render as silent undefined.
      const expose = ctrl.crudConfig?.get?.expose
      if (expose?.length) {
        const ceiling = new Set([...(access.editable ?? []), ...(access.viewable ?? [])])
        const outside = expose.filter((f: string) => !ceiling.has(f))
        if (outside.length) {
          out.push(err(
            file,
            `${ctrl.className} (columnar) declares \`get.expose\` field` +
            `${outside.length === 1 ? '' : 's'} ${outside.map((f: string) => `'${f}'`).join(', ')} ` +
            `outside its \`access:\` ceiling — the server's k header comes from the access node, ` +
            `so these fields would be silently undefined in every projected row.`,
            `Add them to \`access\` (editable/viewable), or drop them from \`expose\` (with ` +
            `\`access:\` declared, \`expose\` can usually be deleted — it desugars).`,
          ))
        }
      }
      // W7: an include not declared in the access tree would serialize the
      // child table WHOLE past the ceiling (the runtime serializer throws
      // the same refusal; this catches it at build time).
      const reported = new Set<string>()
      const walkAccess = (specs: any[] | undefined, node: any, path: string): void => {
        for (const [name, children] of includeEntries(specs)) {
          const childNode = node?.include?.[name]
          if (!childNode) {
            if (reported.has(`${path}${name}`)) continue
            reported.add(`${path}${name}`)
            out.push(err(
              file,
              `${ctrl.className} (columnar) includes '${path}${name}' which is not declared in ` +
              `the door's \`access:\` ceiling — an explicit ceiling is TOTAL, and an undeclared ` +
              `include would serialize the child table's entire column set past it.`,
              `Declare it: \`access: { ..., include: { ${name}: { viewable: [...] } } }\`, or drop ` +
              `'${name}' from the include list.`,
            ))
            continue
          }
          if (children.length) walkAccess(children, childNode, `${path}${name}.`)
        }
      }
      walkAccess(ctrl.crudConfig?.get?.include as any[], access, '')
      walkAccess(ctrl.crudConfig?.index?.include as any[], access, '')
    }

    // ── W3: STI divergence ──────────────────────────────────────────────────
    if (model) {
      const subclasses = stiSubclassesOf(model, project.models)
      if (subclasses.length >= 2) {
        const surfaces = subclasses.map(s => ({ m: s, fields: declaredFieldSurface(s) }))
        const union = new Set<string>()
        for (const s of surfaces) for (const f of s.fields) union.add(f)
        const divergent = [...union].filter(f => surfaces.some(s => !s.fields.has(f)))
        const expose = new Set(ctrl.crudConfig?.get?.expose ?? [])
        const exposedDivergent = divergent.filter(f => expose.has(f))
        if (exposedDivergent.length > 0) {
          const who = (f: string) =>
            surfaces.filter(s => s.fields.has(f)).map(s => s.m.className).join('/')
          out.push(err(
            file,
            `${ctrl.className} (columnar) serves STI parent ${model.className}, and its exposed ` +
            `field${exposedDivergent.length === 1 ? '' : 's'} ` +
            exposedDivergent.map(f => `'${f}' (declared only by ${who(f)})`).join(', ') +
            ` diverge${exposedDivergent.length === 1 ? 's' : ''} across subclasses. Columnar JSON ` +
            `has ONE k header per table and cannot express per-row absence — and absence ≠ null ` +
            `is load-bearing (a null cell is a value; an absent column is not-in-projection).`,
            `Keep \`wire: 'nested'\` on this door for now (a per-table absence bitmap is a later ` +
            `phase, not a hole), split the door per subclass, or align the subclass field sets.`,
          ))
        }
      }
    }
  }

  return out
}
