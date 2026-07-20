/**
 * The projection tree — DESIGN-projections.md P1 (read half).
 *
 * ONE concept for what-is-visible / what-is-editable / what-comes-along,
 * recursively at every level of the record graph:
 *
 *   form: {
 *     fields: { name: 'edit', stage: 'view' },
 *     include: { notes: { fields: { body: 'edit', position: 'view' },
 *                         include: { sentiments: { fields: { label: 'view', score: 'edit' } } } } },
 *   }
 *
 * Integration strategy (why the mega refactor isn't a big bang):
 *   - `@crud` DESUGARS `form:` into expose/permit/include at decoration
 *     time, so every existing reader (envelope, sanitize, index, search
 *     ceilings, codegen) keeps working with zero changes.
 *   - The normalized node rides the config; the ONLY new runtime is
 *     sliceByProjection() applied after serialization — which slices
 *     included children to their node's fields. Legacy configs normalize
 *     to '*' nodes and the slicer is a no-op: byte-identical behavior.
 *   - P2 (edit half: tree abilities + recursive write sanitize) and P3
 *     (named views) build on the same node without re-touching this.
 */

export type Access = 'edit' | 'view'

export interface ProjectionNode {
  /** Slice + editability in ONE map. A field absent from the map does
   *  not exist in this projection. */
  fields: Record<string, Access>
  /** Recursive: each included association is itself a sliced node. */
  include?: Record<string, ProjectionNode>
}

/** Runtime-normalized node. fields === '*' means legacy whole-row. */
export interface NormalizedNode {
  fields: Set<string> | '*'
  edit: Set<string>
  include: Record<string, NormalizedNode>
  /** True when declared via `form:` — slicing only activates then;
   *  desugared legacy configs stay byte-identical (their index/get
   *  include sets may legitimately differ). */
  explicit?: boolean
}

/** Stashed on the crud config by the decorator; read by the slicer. */
export const PROJECTION_NODE = Symbol('ad:projection')

function fromExplicit(node: ProjectionNode, path: string): NormalizedNode {
  if (!node || typeof node !== 'object' || !node.fields || typeof node.fields !== 'object') {
    throw new Error(
      `[active-drizzle] projection node at '${path || '<root>'}' needs a fields map — ` +
      `{ fields: { name: 'edit' | 'view', … }, include?: { assoc: <node> } }`,
    )
  }
  const fields = new Set<string>()
  const edit = new Set<string>()
  for (const [f, access] of Object.entries(node.fields)) {
    if (access !== 'edit' && access !== 'view') {
      throw new Error(
        `[active-drizzle] projection field '${path}${path ? '.' : ''}${f}' has access '${String(access)}' — use 'edit' or 'view'`,
      )
    }
    fields.add(f)
    if (access === 'edit') edit.add(f)
  }
  const include: Record<string, NormalizedNode> = {}
  for (const [name, child] of Object.entries(node.include ?? {})) {
    include[name] = fromExplicit(child, path ? `${path}.${name}` : name)
  }
  return { fields, edit, include, explicit: true }
}

/** Legacy IncludeSpec[] → '*' nodes (whole rows, exactly today's shape). */
function fromIncludeSpecs(specs: any[]): Record<string, NormalizedNode> {
  const out: Record<string, NormalizedNode> = {}
  for (const spec of specs ?? []) {
    if (typeof spec === 'string') {
      out[spec] = { fields: '*', edit: new Set(), include: {} }
    } else if (spec && typeof spec === 'object') {
      for (const [name, kids] of Object.entries(spec)) {
        out[name] = {
          fields: '*',
          edit: new Set(),
          include: fromIncludeSpecs(Array.isArray(kids) ? kids : [kids]),
        }
      }
    }
  }
  return out
}

/**
 * Normalize whatever the config declares into ONE node.
 * `form:` wins; otherwise expose/permit/include desugar losslessly.
 */
export function normalizeProjection(config: any): NormalizedNode {
  if (config?.form) return fromExplicit(config.form as ProjectionNode, '')
  const expose: string[] | undefined = config?.get?.expose
  const permitRaw = config?.update?.permit
  const permit = Array.isArray(permitRaw) ? permitRaw : []   // permit FNS stay with the envelope machinery
  return {
    fields: expose?.length ? new Set(expose) : '*',
    edit: new Set(permit),
    include: fromIncludeSpecs(config?.get?.include ?? []),
  }
}

/** node.include tree → legacy IncludeSpec[] (for eager loading + readers). */
export function nodeToIncludeSpecs(node: NormalizedNode): any[] {
  return Object.entries(node.include).map(([name, child]) =>
    Object.keys(child.include).length === 0 ? name : { [name]: nodeToIncludeSpecs(child) },
  )
}

/**
 * Recursive read-slice over ALREADY-SERIALIZED data (plain objects).
 * - '*' fields → keep everything at this level, still recurse into
 *   included children that have their own slices.
 * - sliced fields → keep pk + declared fields + declared includes; drop
 *   the rest (this is what finally ends "keep secrets out of included
 *   tables" — a child row serializes ONLY its node's slice).
 * Pure data walk: no model machinery, works on any toJSON output.
 */
export function sliceByProjection(data: any, node: NormalizedNode, pk = 'id'): any {
  if (data == null || typeof data !== 'object') return data
  if (Array.isArray(data)) return data.map(row => sliceByProjection(row, node, pk))

  const out: Record<string, any> = {}
  const star = node.fields === '*'
  for (const [key, value] of Object.entries(data)) {
    const childNode = node.include[key]
    if (childNode) {
      out[key] = sliceByProjection(value, childNode, pk)
    } else if (star || key === pk || (node.fields as Set<string>).has(key)) {
      out[key] = value
    }
    // else: dropped — outside this projection
  }
  return out
}

/** True when slicing could change anything (skip the walk otherwise). */
export function projectionSlices(node: NormalizedNode): boolean {
  if (node.fields !== '*') return true
  return Object.values(node.include).some(projectionSlices)
}
