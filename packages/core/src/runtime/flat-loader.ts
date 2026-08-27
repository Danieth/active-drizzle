/**
 * Flat include loading — the server-side twin of the columnar wire
 * (DESIGN-wire-identity §2: "load flat, serve flat").
 *
 * Instead of drizzle RQB's single nested query, each included association
 * loads as ONE batched per-table query (`WHERE fk IN (parent pks)` for
 * hasMany/hasOne, `WHERE pk IN (fks)` for belongsTo), with association
 * `order` clauses applied. The DB returns flat uniform rows per table —
 * exactly the columnar envelope's tables — and every row passes through
 * model instantiation, so Attr codecs (money, enums, encryption) run
 * per-column over homogeneous instances. Nothing bypasses the LAW.
 *
 * Query count: 1 (roots, run by the caller) + one per included table.
 *
 * v1 refusals (teaching errors, not silent degradation):
 *   - raw drizzle `with`-config include specs ({ where, limit, columns }) —
 *     the conditions live in drizzle's shape, not the association's; keep
 *     `wire: 'nested'` on that door or lift them into the association
 *   - hasMany `{ through }` and habtm includes — join-table batching is a
 *     later phase; give the collection its own paged door
 *   - polymorphic belongsTo — no fixed identity space to load from
 */
import { Relation } from './relation.js'
import { resolveWireAssociation, type WireAssociationMeta } from './application-record.js'
import { modelClassName } from './class-name.js'

/** One normalized include entry: association name + its own nested includes. */
interface IncludeEntry {
  name: string
  children: any[]
}

/**
 * Normalizes the controller IncludeSpec[] shape (`['notes', { notes:
 * ['author'] }]`) into flat entries. Drizzle passthrough configs are refused
 * — see the module header.
 */
export function normalizeIncludeSpecs(specs: any[], owner: string): IncludeEntry[] {
  const out: IncludeEntry[] = []
  for (const spec of specs ?? []) {
    if (typeof spec === 'string') {
      out.push({ name: spec, children: [] })
    } else if (spec && typeof spec === 'object') {
      for (const [name, kids] of Object.entries(spec)) {
        if (kids && typeof kids === 'object' && !Array.isArray(kids)
          && ('with' in (kids as any) || 'where' in (kids as any) || 'columns' in (kids as any)
            || 'orderBy' in (kids as any) || 'limit' in (kids as any))) {
          throw new Error(
            `[active-drizzle] flat include loading on ${owner}: include '${name}' carries a raw ` +
            `drizzle config ({ where/limit/columns/orderBy }) — those conditions live in drizzle's ` +
            `nested shape, which the flat loader does not translate (v1). Either keep ` +
            `\`wire: 'nested'\` on this door, or move the condition into the association ` +
            `declaration (e.g. \`order\`) / give the collection its own paged door.`,
          )
        }
        out.push({ name, children: Array.isArray(kids) ? kids : kids == null || kids === true ? [] : [kids] })
      }
    }
  }
  return out
}

/** The wire meta for an association a columnar door may include — refusals teach. */
export function resolveIncludableAssociation(model: any, name: string): WireAssociationMeta {
  const meta = resolveWireAssociation(model, name)
  const owner = modelClassName(model)
  const marker = (model as any)?.[name]
  // Kind refusals fire BEFORE target resolution — a habtm whose target model
  // is unregistered must still teach the habtm rule, not a resolution error.
  const markerKind = marker && typeof marker === 'object' ? marker._type : null
  if (markerKind === 'habtm' || (markerKind === 'hasMany' && marker.options?.through)) {
    const isHabtm = markerKind === 'habtm'
    const singular = name.endsWith('ies') ? name.slice(0, -3) + 'y'
      : name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name
    throw new Error(
      `[active-drizzle] columnar wire on ${owner}: include '${name}' is a ` +
      `${isHabtm ? 'habtm' : 'hasMany-through'} association — join-table batching is ` +
      `not in flat loading v1. Give '${name}' its own paged door` +
      `${isHabtm ? ` (or expose the '${singular}Ids' habtm ids column instead)` : ''}, ` +
      `or keep \`wire: 'nested'\` on this door.`,
    )
  }
  if (!meta) {
    if (marker && typeof marker === 'object' && marker._type === 'belongsTo' && marker.options?.polymorphic) {
      throw new Error(
        `[active-drizzle] columnar wire on ${owner}: include '${name}' is a POLYMORPHIC belongsTo — ` +
        `it has no fixed identity space (table), so its rows cannot ride a single entity table. ` +
        `Keep \`wire: 'nested'\` on this door, or expose the concrete association instead.`,
      )
    }
    throw new Error(
      `[active-drizzle] columnar wire on ${owner}: include '${name}' does not resolve to an ` +
      `association with a registered target model. Check the association declaration (and that ` +
      `the target model's module is imported for its side effects).`,
    )
  }
  if (!meta.primaryKey) {
    throw new Error(
      `[active-drizzle] columnar wire on ${owner}: include '${name}' targets a model with a ` +
      `COMPOSITE primary key — rows without a single pk are not wire-addressable. Keep ` +
      `\`wire: 'nested'\` on this door.`,
    )
  }
  return meta
}

/**
 * Loads the include tree for already-loaded root instances with per-table
 * batched queries, attaching children onto `_attributes[<assoc>]` exactly
 * where the nested loader puts them (as model INSTANCES, so codecs are
 * already live). Mutates the given instances; returns them for chaining.
 */
export async function attachFlatIncludes(
  roots: any[],
  model: any,
  includeSpecs: any[],
): Promise<any[]> {
  if (!roots.length) return roots
  const entries = normalizeIncludeSpecs(includeSpecs, modelClassName(model))
  for (const entry of entries) {
    const meta = resolveIncludableAssociation(model, entry.name)
    const Target: any = meta.targetModel
    const pkField = meta.primaryKey!

    if (meta.kind === 'belongsTo') {
      const fk = meta.foreignKey!
      const fkVals = [...new Set(roots
        .map(r => r?._attributes?.[fk] ?? r?.[fk])
        .filter(v => v !== null && v !== undefined))]
      // .unscoped(): the nested lane lowers includes to raw drizzle `with`,
      // where the child model's DEFAULT SCOPES never run — applying them here
      // would change the served ROW SET (and hasMany membership) on flag
      // flip, an authorization-adjacent semantic change riding a transport
      // flag. Parity is the law; scoping included children belongs to a
      // deliberate change in BOTH lanes, not this loader.
      const children = fkVals.length
        ? await new Relation(Target).unscoped().where({ [pkField]: fkVals }).load()
        : []
      const byPk = new Map(children.map((c: any) => [c._attributes[pkField], c]))
      for (const r of roots) {
        const v = r?._attributes?.[fk] ?? r?.[fk]
        r._attributes[entry.name] = (v !== null && v !== undefined ? byPk.get(v) : null) ?? null
      }
      if (entry.children.length) await attachFlatIncludes(children, Target, entry.children)
      continue
    }

    // hasOne / hasMany: fk lives on the CHILD
    const fk = meta.foreignKey!
    const rootPkField = typeof model?.primaryKey === 'string' ? model.primaryKey : 'id'
    const rootPks = [...new Set(roots
      .map(r => r?._attributes?.[rootPkField] ?? r?.[rootPkField])
      .filter(v => v !== null && v !== undefined))]
    const marker = (model as any)[entry.name]
    const asName = marker?.options?.as as string | undefined
    // .unscoped(): parity with the nested lane — see the belongsTo branch.
    let rel = new Relation(Target).unscoped().where({ [fk]: rootPks })
    // Polymorphic inverse (as:) scopes by the type column too — id alone
    // leaks rows between parent types that share an id. The accepted type set
    // is the DISTINCT class names of the loaded roots (STI: a subclass row's
    // children carry the subclass name in the type column — matching only
    // the static model class would silently drop them).
    if (asName) {
      const typeNames = [...new Set(roots.map(r =>
        modelClassName((r?.constructor && r.constructor !== Object ? r.constructor : model) as any)))]
      rel = rel.where({ [`${asName}Type`]: typeNames.length === 1 ? typeNames[0] : typeNames })
    }
    // Association order clauses, exactly as the per-record relation applies
    // them; a pk tiebreaker keeps within-parent order deterministic (the
    // nested loader's unordered rows come back in heap order — pk asc is the
    // stable, parity-safe reading of that).
    const orderSpec = marker?.options?.order as Record<string, 'asc' | 'desc'> | undefined
    if (orderSpec) for (const [col, dir] of Object.entries(orderSpec)) rel = rel.order(col, dir)
    rel = rel.order(pkField, 'asc')
    const children = rootPks.length ? await rel.load() : []

    if (meta.kind === 'hasOne') {
      const byFk = new Map<any, any>()
      for (const c of children) {
        const key = c._attributes[fk]
        if (!byFk.has(key)) byFk.set(key, c)   // first per parent
      }
      for (const r of roots) {
        r._attributes[entry.name] = byFk.get(r?._attributes?.[rootPkField] ?? r?.[rootPkField]) ?? null
      }
    } else {
      const byFk = new Map<any, any[]>()
      for (const c of children) {
        const key = c._attributes[fk]
        const list = byFk.get(key)
        if (list) list.push(c)
        else byFk.set(key, [c])
      }
      for (const r of roots) {
        r._attributes[entry.name] = byFk.get(r?._attributes?.[rootPkField] ?? r?.[rootPkField]) ?? []
      }
    }
    if (entry.children.length) await attachFlatIncludes(children, Target, entry.children)
  }
  return roots
}
