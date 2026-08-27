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

const WIRE_VALUES = new Set(['columnar', 'nested'])

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
