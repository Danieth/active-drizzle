/**
 * The ACCESS CEILING — DESIGN-projections.md (read half).
 *
 * The door's maximum: what may ever be seen, what may ever be changed,
 * and the whole graph it may reach — recursively, declared ONCE on
 * @crud. SHAPES (what a route actually loads/sends) are a separate
 * concern layered on top; a shape only picks SUBSETS of this ceiling and
 * never restates access, so editability can never drift per shape.
 *
 *   access: {
 *     editable: ['name', 'amount'],          // implicitly viewable
 *     viewable: ['stage'],
 *     include: { notes: { editable: ['body'], viewable: ['position'],
 *                include: { sentiments: { editable: ['score'], viewable: ['label'] } } } },
 *   }
 *
 * Integration strategy (why the mega refactor isn't a big bang):
 *   - `@crud` DESUGARS `access:` into expose/permit/include at decoration
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

/**
 * A ceiling node: two arrays and a rule — anything editable is implicitly
 * viewable. A field in neither list does not exist on this door.
 * Recursive through include, so nested levels carry their own access.
 */
export interface ProjectionNode {
  /** Fields the client may WRITE (implicitly viewable). */
  editable?: string[]
  /** Fields the client may only READ. */
  viewable?: string[]
  /** Recursive: each included association is itself a sliced node. */
  include?: Record<string, ProjectionNode>
}

/** Runtime-normalized ceiling node. fields === '*' means legacy whole-row. */
export interface NormalizedNode {
  fields: Set<string> | '*'
  edit: Set<string>
  include: Record<string, NormalizedNode>
  /** True when declared via `access:` — slicing only activates then;
   *  desugared legacy configs stay byte-identical (their index/get
   *  include sets may legitimately differ). */
  explicit?: boolean
}

/** Stashed on the crud config by the decorator; read by the slicer. */
export const PROJECTION_NODE = Symbol('ad:projection')

function fromExplicit(node: ProjectionNode, path: string): NormalizedNode {
  const at = path || '<root>'
  if (!node || typeof node !== 'object'
      || (!Array.isArray(node.editable) && !Array.isArray(node.viewable))) {
    throw new Error(
      `[active-drizzle] projection node at '${at}' needs editable and/or viewable arrays — ` +
      `{ editable?: ['a'], viewable?: ['b'], include?: { assoc: <node> } } (editable is implicitly viewable)`,
    )
  }
  const edit = new Set<string>(node.editable ?? [])
  // THE rule: editable ⊆ viewable, by construction — declared once, never repeated
  const fields = new Set<string>([...(node.viewable ?? []), ...edit])
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
 * Normalize whatever the config declares into ONE ceiling node.
 * `access:` wins; otherwise expose/permit/include desugar losslessly.
 */
export function normalizeProjection(config: any): NormalizedNode {
  if (config?.access) return fromExplicit(config.access as ProjectionNode, '')
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
