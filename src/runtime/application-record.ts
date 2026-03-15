import util from 'util'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { Relation } from './relation.js'
import { getExecutor, getSchema, MODEL_REGISTRY, transaction, transactionContext, afterCommitQueue, AbortChain, RecordNotFound } from './boot.js'
import { runHooks, collectHooks } from './hooks.js'
import type { AttrEnumConfig } from './attr.js'

/**
 * The shape every Attr.* config object must satisfy.
 * _isAttr: true distinguishes Attr configs from association markers,
 * class prototypes, and other static properties during validate() loops.
 */
export interface AttrConfig {
  readonly _isAttr?: true
  get?: (raw: any) => any
  set?: (val: any) => any
  default?: any | (() => any)
  validate?: (val: any) => string | null
  serverValidate?: (val: any) => Promise<string | null>
}

export class ApplicationRecord {
  public _attributes: Record<string, any> = {}
  public _changes: Map<string, { was: any; is: any }> = new Map()
  public errors: Record<string, string[]> = {}
  public isNewRecord: boolean = true

  // ── Static table name ──────────────────────────────────────────────────

  static get tableName(): string {
    return (this as any)._activeDrizzleTableName ?? this.name.toLowerCase()
  }

  /**
   * The primary key column name(s).
   * Override to use a non-id column or a composite key:
   *   static primaryKey = 'uuid'
   *   static primaryKey = ['tenantId', 'userId']   // composite
   * Defaults to 'id' if not set.
   */
  static primaryKey: string | string[] = 'id'

  // ── Static query delegates ─────────────────────────────────────────────

  static all():                                    Relation<any>      { return new Relation(this) }
  static where(c: Record<string, any> | null = {}): Relation<any>    { return new Relation(this).where(c) }
  static includes(...a: any[]):                    Relation<any, any> { return (new Relation(this) as any).includes(...a) }
  static limit(n: number):                         Relation<any>      { return new Relation(this).limit(n) }
  static offset(n: number):                        Relation<any>      { return new Relation(this).offset(n) }
  static order(f: string, d: 'asc'|'desc' = 'asc'): Relation<any>  { return new Relation(this).order(f, d) }
  static none():                                   Relation<any>      { return new Relation(this).none() }

  // ── Aggregates (static) ────────────────────────────────────────────────
  static count():                          Promise<number>   { return new Relation(this).count() }
  static sum(col: string):                 Promise<number>   { return new Relation(this).sum(col) }
  static average(col: string):             Promise<number|null> { return new Relation(this).average(col) }
  static minimum(col: string):             Promise<any>      { return new Relation(this).minimum(col) }
  static maximum(col: string):             Promise<any>      { return new Relation(this).maximum(col) }
  static exists(cond?: Record<string,any>): Promise<boolean> { return new Relation(this).exists(cond) }
  static tally(col: string):               Promise<Record<string,number>> { return new Relation(this).tally(col) }

  // ── Retrieval (static) ─────────────────────────────────────────────────
  static async first(): Promise<any | null>                          { return new Relation(this).first() }
  static async last(n?: number): Promise<any | null | any[]>         { return new Relation(this).last(n) }
  static async take(n?: number): Promise<any | any[] | null>         { return new Relation(this).take(n) }
  static async ids(): Promise<any[]>                                  { return new Relation(this).ids() }
  static async pick(...cols: string[]): Promise<any>                  { return new Relation(this).pick(...cols) }
  static async any(): Promise<boolean>                                { return new Relation(this).any() }
  static async many(): Promise<boolean>                               { return new Relation(this).many() }
  static async one(): Promise<boolean>                                { return new Relation(this).one() }
  static async empty(): Promise<boolean>                              { return new Relation(this).empty() }
  static pluck(...f: string[]):  Promise<any[]>                       { return new Relation(this).pluck(...f) }
  static updateAll(u: Record<string,any>): Promise<number>            { return new Relation(this).updateAll(u) }

  /**
   * find(id) — raises RecordNotFound if no row matches the primary key.
   * Mirrors Rails: `User.find(1)` raises if missing.
   * Use `findBy({ id })` or `first()` if you want null instead.
   */
  static async find(id: number | string): Promise<any> {
    const table = getSchema()[(this as any).tableName]
    if (!table) throw new Error(`Table "${(this as any).tableName}" not found. Did you call boot()?`)
    const pkWhereExpr = _buildPkWhere(this as any, table, id)
    const [row] = await getExecutor().select().from(table).where(pkWhereExpr).limit(1)
    if (!row) throw new RecordNotFound(this.name, id)
    return new (this as any)(row, false)
  }

  /**
   * findBy(attrs) — returns null if not found (no error).
   * Rails: `User.find_by(email: 'x')` returns nil if missing.
   */
  static async findBy(attrs: Record<string, any>): Promise<any | null> {
    return new Relation(this).where(attrs).first()
  }

  /** find! is an alias for find() — raises RecordNotFound. */
  static findBang(id: number | string): Promise<any> {
    return (this as any).find(id)
  }

  /** findOrInitializeBy: find matching record or return new (unsaved) instance. */
  static async findOrInitializeBy(attrs: Record<string, any>): Promise<any> {
    return new Relation(this).findOrInitializeBy(attrs)
  }

  /**
   * Finds the first record matching `conditions`, or creates it with `conditions` + optional `defaults`.
   * Race-safe: retries the SELECT on unique-constraint violations.
   */
  static async findOrCreateBy(conditions: Record<string, any>, defaults: Record<string, any> = {}): Promise<any> {
    return new Relation(this).findOrCreateBy(conditions, defaults)
  }

  static async create(attrs: Record<string, any>): Promise<any> {
    const instance = new (this as any)(attrs, true)
    const saved    = await instance.save()
    if (!saved) throw new Error(`Validation failed: ${JSON.stringify(instance.errors)}`)
    return instance
  }

  static async insertAll(records: Record<string, any>[]): Promise<number> {
    const table = getSchema()[(this as any).tableName]
    if (!table) throw new Error(`Table "${(this as any).tableName}" not found.`)
    const Ctor  = this as any
    const rows  = records.map(r => {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(r)) out[k] = Ctor[k]?._isAttr && Ctor[k].set ? Ctor[k].set(v) : v
      return out
    })
    await getExecutor().insert(table).values(rows)
    return rows.length
  }

  static findEach(batchSize: number, fn: (record: any) => Promise<void>): Promise<void> {
    return new Relation(this).findEach(batchSize, fn)
  }

  static transaction<T>(callback: () => Promise<T>): Promise<T> {
    return transaction(callback)
  }

  // ── Constructor ─────────────────────────────────────────────────────────

  constructor(attributes: Record<string, any> = {}, isNew = true) {
    this._attributes    = attributes
    this.isNewRecord    = isNew
    ;(this as any)._previousChanges = null  // initialized so proxy set trap uses Reflect.set
    return _wrapRecord(this)
  }

  // ── Validation ──────────────────────────────────────────────────────────

  async validate(): Promise<boolean> {
    this.errors = {}
    const ctor = this.constructor as any

    // Attr.* property-level validations
    for (const key of Object.getOwnPropertyNames(ctor)) {
      const attr = ctor[key] as AttrConfig | undefined
      if (attr?._isAttr !== true) continue
      if (!attr.validate && !attr.serverValidate) continue
      const value = (this as any)[key]
      if (typeof attr.validate === 'function') {
        const err = attr.validate(value)
        if (err) (this.errors[key] ??= []).push(err)
      }
      if (typeof attr.serverValidate === 'function') {
        const err = await attr.serverValidate(value)
        if (err) (this.errors[key] ??= []).push(err)
      }
    }

    // @validate and @serverValidate decorated instance methods
    for (const hook of collectHooks(ctor)) {
      if (hook.event !== 'validate' && hook.event !== 'serverValidate') continue
      const method = (this as any)[hook.method]
      if (typeof method !== 'function') continue
      const result = await method.call(this)
      // Method can either return a string (base error) or push to this.errors directly
      if (typeof result === 'string') (this.errors['base'] ??= []).push(result)
    }

    return Object.keys(this.errors).length === 0
  }

  // ── Instance persistence ─────────────────────────────────────────────

  async save(): Promise<boolean> {
    const isValid = await this.validate()
    if (!isValid) return false

    const isNew = this.isNewRecord
    if (!(await runHooks(this, 'beforeSave', isNew))) {
      if (transactionContext.getStore()) throw new AbortChain('beforeSave hook returned false')
      return false
    }
    if (!(await runHooks(this, isNew ? 'beforeCreate' : 'beforeUpdate', isNew))) {
      if (transactionContext.getStore()) throw new AbortChain('before hook returned false')
      return false
    }

    const db = getExecutor()
    const table = getSchema()[(this.constructor as any).tableName]
    if (!table) throw new Error(`Table "${(this.constructor as any).tableName}" not found. Did you call boot()?`)

    const ctor = this.constructor as any

    // Snapshot nested *Attributes data before _attributes is overwritten by the DB row
    const nestedSnapshot = _captureNestedAttributes(this, ctor)

    if (isNew) {
      const payload: Record<string, any> = {}

      // Start with raw constructor-passed attributes (strips nested *Attributes keys)
      for (const [k, v] of Object.entries(this._attributes)) {
        if (_isNestedAttrsKey(k, ctor)) continue
        payload[k] = v
      }
      // _changes override (from proxy set calls after construction)
      for (const [k, { is }] of this._changes) {
        if (_isNestedAttrsKey(k, ctor)) continue
        payload[k] = is
      }

      // Apply defaults for fields not yet set
      for (const key of Object.getOwnPropertyNames(ctor)) {
        const attr = ctor[key] as AttrConfig | undefined
        if (attr?._isAttr !== true || attr.default === undefined) continue
        if (key in payload) continue
        const def = typeof attr.default === 'function' ? attr.default() : attr.default
        payload[key] = attr.set ? attr.set(def) : def
      }

      // STI: ensure the discriminator column is always set on INSERT
      if (ctor.stiType && !('type' in payload)) {
        payload['type'] = ctor.stiType
      }

      const [row] = await db.insert(table).values(payload).returning()
      if (row) this._attributes = row
    } else {
      // Strip *Attributes keys before checking if there are real changes
      const realChanges = Array.from(this._changes.entries()).filter(([k]) => !_isNestedAttrsKey(k, ctor))
      const hasAnything = realChanges.length > 0 || Object.keys(nestedSnapshot).length > 0

      // Even with no parent changes, autosave still needs to run below
      if (!hasAnything) {
        await _autosaveAssociations(this, ctor)
        return true
      }
      if (!_getPkValue(ctor, this._attributes)) throw new Error("Cannot save existing record without a primary key.")

      if (realChanges.length > 0) {
        const payload: Record<string, any> = {}
        for (const [k, { is }] of realChanges) payload[k] = is
        const [row] = await db.update(table).set(payload).where(_buildPkWhere(ctor, table, _getPkValue(ctor, this._attributes))).returning()
        if (row) this._attributes = row
      }
    }

    ;(this as any)._previousChanges = Object.fromEntries(
      Array.from(this._changes.entries()).map(([k, { was, is }]) => [k, [was, is]])
    )
    this._changes.clear()
    this.isNewRecord = false

    // Process acceptsNestedAttributesFor associations after parent is persisted
    await _processNestedAttributes(this, ctor, nestedSnapshot)

    // counterCache: increment parent counter on first create
    if (isNew) await _adjustCounterCaches(this, ctor, 1)

    // autosave: save any loaded associations that are flagged autosave: true
    await _autosaveAssociations(this, ctor)

    await runHooks(this, 'afterSave', isNew)
    await runHooks(this, isNew ? 'afterCreate' : 'afterUpdate', isNew)

    const pendingAfterCommit = afterCommitQueue.getStore()
    if (pendingAfterCommit !== undefined) {
      // Inside a transaction — defer afterCommit until after the transaction commits
      pendingAfterCommit.push(async () => { await runHooks(this, 'afterCommit', isNew) })
    } else {
      await runHooks(this, 'afterCommit', isNew)
    }

    return true
  }

  /**
   * Convenience: assign attrs and save in one call.
   */
  async update(attrs: Record<string, any>): Promise<boolean> {
    for (const [k, v] of Object.entries(attrs)) {
      ;(this as any)[k] = v
    }
    return this.save()
  }

  async destroy(): Promise<boolean> {
    if (this.isNewRecord) return false
    if (!(await runHooks(this, 'beforeDestroy', false))) return false

    const db = getExecutor()
    const ctor = this.constructor as any
    const table = getSchema()[ctor.tableName]
    if (!table) throw new Error(`Table "${ctor.tableName}" not found.`)
    if (!_getPkValue(ctor, this._attributes)) throw new Error("Cannot destroy record without a primary key.")

    // Cascade destroy: any hasMany with dependent: 'destroy' fires destroy() per record
    for (const key of Object.getOwnPropertyNames(ctor)) {
      const marker = ctor[key]
      if (!marker || typeof marker !== 'object') continue
      if ((marker._type === 'hasMany' || marker._type === 'hasOne') && marker.options?.dependent === 'destroy') {
        const assocVal = (this as any)[key]
        if (assocVal instanceof Relation) {
          for (const child of await assocVal.load()) {
            await (child as any).destroy()
          }
        } else if (assocVal && typeof (assocVal as any).then === 'function') {
          const child = await assocVal
          if (child) await (child as any).destroy()
        }
      }
    }

    await db.delete(table).where(_buildPkWhere(ctor, table, _getPkValue(ctor, this._attributes)))
    ;(this as any).isDestroyed = true

    // counterCache: decrement parent counter on destroy
    await _adjustCounterCaches(this, ctor, -1)

    await runHooks(this, 'afterDestroy', false)
    return true
  }

  /**
   * Re-fetches the record from the database, discarding any in-memory changes.
   * Throws if the record is new (no id) or has been destroyed.
   */
  async reload(): Promise<this> {
    if (this.isNewRecord) throw new Error('Cannot reload a new record that has not been saved.')
    const ctor  = this.constructor as any
    const pkVal = _getPkValue(ctor, this._attributes)
    if (!pkVal) throw new Error('Cannot reload: record has no primary key.')

    const table = getSchema()[ctor.tableName]
    if (!table) throw new Error(`Table "${ctor.tableName}" not found.`)

    const [row] = await getExecutor().select().from(table).where(_buildPkWhere(ctor, table, pkVal)).limit(1)
    if (!row) throw new Error(`${ctor.name} with pk=${JSON.stringify(pkVal)} not found — was it deleted?`)

    this._attributes = row
    this._changes.clear()
    return this
  }

  // ── Dirty tracking ──────────────────────────────────────────────────────

  isChanged(): boolean { return this._changes.size > 0 }
  changedFields(): string[] { return Array.from(this._changes.keys()) }

  get changes(): Record<string, [any, any]> {
    const out: Record<string, [any, any]> = {}
    for (const [k, { was, is }] of this._changes) out[k] = [was, is]
    return out
  }

  get previousChanges(): Record<string, [any, any]> {
    return (this as any)._previousChanges ?? {}
  }

  restoreAttributes(): void {
    for (const [key, { was }] of this._changes) {
      this._attributes[key] = was
    }
    this._changes.clear()
  }

  // ── Serialization ────────────────────────────────────────────────────────

  get attributes(): Record<string, any> {
    const ctor = this.constructor as any
    const out: Record<string, any> = {}
    for (const key of Object.keys(this._attributes)) {
      const attr = ctor[key] as AttrConfig | undefined
      out[key] = attr?.get ? attr.get(this._attributes[key]) : this._attributes[key]
    }
    for (const [k, { is }] of this._changes) out[k] = is
    return out
  }

  /**
   * Serializes to a plain object. Supports filtering:
   *   .toJSON()                              → all attributes
   *   .toJSON({ only: ['id','title'] })       → subset
   *   .toJSON({ except: ['password'] })       → exclude
   *   .toJSON({ include: ['campaigns'] })     → embed already-loaded associations
   *
   * `include` embeds associations that are already in `_attributes` (i.e. loaded
   * via Relation#includes() or returned inline by the DB query). Unloaded
   * associations are included as `null`.
   */
  toJSON(opts?: { only?: string[]; except?: string[]; include?: string[] }): Record<string, any> {
    const all = this.attributes
    let result: Record<string, any>
    if (!opts) {
      result = all
    } else if (opts.only) {
      result = Object.fromEntries(opts.only.map(k => [k, all[k]]))
    } else if (opts.except) {
      const ex = new Set(opts.except)
      result = Object.fromEntries(Object.entries(all).filter(([k]) => !ex.has(k)))
    } else {
      result = { ...all }
    }
    if (opts?.include) {
      for (const assocName of opts.include) {
        const val = all[assocName]
        if (Array.isArray(val)) {
          result[assocName] = val.map((r: any) => (typeof r?.toJSON === 'function' ? r.toJSON() : r))
        } else if (val && typeof (val as any).toJSON === 'function') {
          result[assocName] = (val as any).toJSON()
        } else {
          result[assocName] = val ?? null
        }
      }
    }
    return result
  }

  // ── Console inspect ──────────────────────────────────────────────────────

  [util.inspect.custom](_depth: number, _options: util.InspectOptions): string {
    const name = this.constructor.name
    const attrs = this.attributes
    const id = attrs['id'] ? `:${attrs['id']}` : ''
    const dirty = this.changedFields()
    const dirtyStr = dirty.length > 0 ? ` (dirty: ${dirty.join(', ')})` : ''

    const parts: string[] = []
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'id') continue
      const vStr = typeof val === 'string' ? `"${val}"` : String(val)
      if (this._changes.has(key)) {
        const was = this._changes.get(key)!.was
        const wasStr = typeof was === 'string' ? `"${was}"` : String(was)
        parts.push(`${key}: ${vStr} (was: ${wasStr})`)
      } else {
        parts.push(`${key}: ${vStr}`)
      }
    }
    return `#<${name}${id}${dirtyStr} ${parts.join(', ')}>`
  }
}

// ── Association lazy loading ──────────────────────────────────────────────────

/**
 * Resolves an association marker at instance access time.
 *
 * belongsTo / hasOne → returns a Promise<TargetRecord | null>
 * hasMany / habtm   → returns a scoped Relation (awaitable)
 *
 * FK inference rules:
 *   belongsTo: `${propertyName}Id` on owner table
 *   hasMany:   `${toCamelCase(ownerClass)}Id` on target table (unless foreignKey is set)
 *   through:   builds an IN subquery via the join table
 */
function _resolveAssociation(marker: any, prop: string, target: any, ctor: any): any {
  // ── polymorphic belongsTo — target determined by <prop>Type column ──────
  // Handled before _findModelByMarker because there is no fixed target table.
  if (marker._type === 'belongsTo' && marker.options?.polymorphic) {
    const idField = marker.options?.foreignKey ?? `${prop}Id`
    const typeField = marker.options?.foreignType ?? `${prop}Type`
    const ownerId = target._attributes[idField]
    const ownerType = target._attributes[typeField]
    if (!ownerId || !ownerType) return Promise.resolve(null)
    const PolyTarget = Object.values(MODEL_REGISTRY).find(
      (m: any) => m.name === ownerType || m._activeDrizzleTableName === ownerType
    )
    if (!PolyTarget) return Promise.resolve(null)
    return new Relation(PolyTarget).where({ id: ownerId }).first()
  }

  const TargetModel = _findModelByMarker(marker, prop)
  if (!TargetModel) return undefined

  // ── belongsTo — FK lives on the owner table ─────────────────────────────
  if (marker._type === 'belongsTo') {
    const fkField = marker.options?.foreignKey ?? `${prop}Id`
    const ownerId = target._attributes[fkField]
    if (ownerId === null || ownerId === undefined) return Promise.resolve(null)
    return new Relation(TargetModel).where({ id: ownerId }).first()
  }

  // ── hasOne — FK lives on the target table ────────────────────────────────
  if (marker._type === 'hasOne') {
    const ownerSingular = _singularize(ctor.tableName)
    const fkField = marker.options?.foreignKey ?? `${toCamelCase(ownerSingular)}Id`
    const ownerId = target._attributes.id
    if (ownerId === null || ownerId === undefined) return Promise.resolve(null)
    return new Relation(TargetModel).where({ [fkField]: ownerId }).first()
  }

  // ── habtm — join table is marker.table ──────────────────────────────────
  if (marker._type === 'habtm') {
    const ownerId = target._attributes.id
    if (ownerId === null || ownerId === undefined) return new Relation(TargetModel)

    const schema = getSchema()
    const joinTableObj = schema[marker.table]
    if (!joinTableObj) return new Relation(TargetModel)

    const ownerFk = marker.options?.foreignKey ?? `${toCamelCase(_singularize(ctor.tableName))}Id`
    const targetFk = marker.options?.associationForeignKey ?? `${toCamelCase(_singularize(TargetModel._activeDrizzleTableName ?? TargetModel.name))}Id`

    const joinOwnerCol = joinTableObj[ownerFk]
    const joinTargetCol = joinTableObj[targetFk]
    if (!joinOwnerCol || !joinTargetCol) return new Relation(TargetModel)

    const db = getExecutor()
    const subquery = db.select({ _val: joinTargetCol }).from(joinTableObj).where(eq(joinOwnerCol, ownerId))
    const targetTableObj = schema[TargetModel._activeDrizzleTableName]
    if (!targetTableObj) return new Relation(TargetModel)

    const rel = new Relation(TargetModel)
    ;(rel as any)._where.push(inArray(targetTableObj.id, subquery))
    return rel
  }

  // ── hasMany ──────────────────────────────────────────────────────────────
  if (marker._type === 'hasMany') {
    const ownerId = target._attributes.id
    if (ownerId === null || ownerId === undefined) return new Relation(TargetModel)

    // :through — use an IN (subquery) via the join table
    if (marker.options?.through) {
      const schema = getSchema()
      const throughTableObj = schema[marker.options.through as string]
      if (!throughTableObj) return new Relation(TargetModel)

      const ownerFk = marker.options?.foreignKey ?? `${toCamelCase(_singularize(ctor.tableName))}Id`
      const targetFk = marker.options?.sourceForeignKey ?? `${toCamelCase(_singularize(TargetModel._activeDrizzleTableName ?? TargetModel.name))}Id`

      const throughOwnerCol = throughTableObj[ownerFk]
      const throughTargetCol = throughTableObj[targetFk]
      if (!throughOwnerCol || !throughTargetCol) return new Relation(TargetModel)

      const db = getExecutor()
      const subquery = db.select({ _val: throughTargetCol }).from(throughTableObj).where(eq(throughOwnerCol, ownerId))
      const targetTableObj = schema[TargetModel._activeDrizzleTableName]
      if (!targetTableObj) return new Relation(TargetModel)

      const rel = new Relation(TargetModel)
      ;(rel as any)._where.push(inArray(targetTableObj.id, subquery))
      return rel
    }

    // Simple hasMany
    const ownerSingular = _singularize(ctor.tableName)
    const fkField = marker.options?.foreignKey ?? `${toCamelCase(ownerSingular)}Id`
    let rel = new Relation(TargetModel).where({ [fkField]: ownerId })
    // Apply declarative order from the association options
    if (marker.options?.order) {
      for (const [col, dir] of Object.entries(marker.options.order as Record<string, 'asc' | 'desc'>)) {
        rel = rel.order(col, dir)
      }
    }
    return rel
  }

  return undefined
}

/**
 * Finds a model in MODEL_REGISTRY by the association marker's declared table name
 * or by inferring from the property name.
 *
 * Note: for `habtm`, `marker.table` is the JOIN table — target is always inferred
 * from the property name.
 */
function _findModelByMarker(marker: any, prop: string): any {
  const reg = MODEL_REGISTRY

  // For belongsTo / hasMany / hasOne: marker.table is the TARGET table (if explicit)
  if (marker._type !== 'habtm' && marker.table) {
    return Object.values(reg).find((m: any) => m._activeDrizzleTableName === marker.table) ?? null
  }

  // Infer from property name: direct table-name lookup first (precise), then class name.
  const singular = _singularize(prop)
  const inferredTable = prop.endsWith('s') ? prop : singular + 's'

  // Direct registry lookup by inferred table name — this is the most reliable because
  // MODEL_REGISTRY stores by table name too (from the @model decorator).
  // When two classes share a table, the last one registered wins, which is intentional.
  if (reg[inferredTable]) return reg[inferredTable]

  // Class-name fallback: handle cases where the table name differs from the prop
  const capitalized = prop[0]!.toUpperCase() + prop.slice(1)
  const singularCap = singular[0]!.toUpperCase() + singular.slice(1)

  return (
    Object.values(reg).find((m: any) => m.name === capitalized) ??
    Object.values(reg).find((m: any) => m.name === singularCap) ??
    null
  )
}

/** Naive singularizer — strips trailing 's' for common English plurals. */
function _singularize(word: string): string {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'
  if (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('zes')) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** True when the key ends in 'Attributes' AND matches an acceptsNested hasMany on the model. */
function _isNestedAttrsKey(key: string, ctor: any): boolean {
  if (!key.endsWith('Attributes')) return false
  const assocName = key.slice(0, -'Attributes'.length)
  const marker = ctor[assocName]
  return marker?._type === 'hasMany' && marker.options?.acceptsNested === true
}

/**
 * Captures all `*Attributes` data from both `_attributes` (constructor-passed)
 * and `_changes` (proxy-set) BEFORE the parent DB operation overwrites `_attributes`.
 * Returns a map of associationName → array.
 */
function _captureNestedAttributes(record: any, ctor: any): Record<string, any[]> {
  const result: Record<string, any[]> = {}
  for (const key of Object.getOwnPropertyNames(ctor)) {
    const marker = ctor[key]
    if (!marker || typeof marker !== 'object' || marker._type !== 'hasMany') continue
    if (!marker.options?.acceptsNested) continue

    const attrsKey = `${key}Attributes`
    const fromAttrs = record._attributes[attrsKey]
    const fromChanges = record._changes.get(attrsKey)?.is
    const data = fromChanges ?? fromAttrs
    if (Array.isArray(data)) result[key] = data
  }
  return result
}

/**
 * Processes `*Attributes` arrays for `acceptsNestedAttributesFor` associations.
 * Called after the parent record is persisted (so parent id is available).
 *
 * Each item in the array:
 *   { id, ...fields }           → update existing child
 *   { ...fields } (no id)       → create new child
 *   { id, _destroy: true }      → destroy child
 */
async function _processNestedAttributes(record: any, ctor: any, snapshot: Record<string, any[]>): Promise<void> {
  const ownerId = record._attributes['id']
  if (!ownerId || Object.keys(snapshot).length === 0) return

  for (const [key, nested] of Object.entries(snapshot)) {
    const marker = ctor[key]
    const TargetModel = _findModelByMarker(marker, key)
    if (!TargetModel) continue

    const ownerSingular = _singularize(ctor.tableName)
    const fkField = (marker.options?.foreignKey as string | undefined) ?? `${toCamelCase(ownerSingular)}Id`

    for (const item of nested) {
      const { _destroy, id, ...fields } = item
      if (_destroy && id) {
        const child = await TargetModel.find(id)
        if (child) await child.destroy()
      } else if (id) {
        const child = await TargetModel.find(id)
        if (child) await child.update({ ...fields, [fkField]: ownerId })
      } else {
        await TargetModel.create({ ...fields, [fkField]: ownerId })
      }
    }
  }
}

/**
 * counterCache: When a child is created (+1) or destroyed (-1), updates a
 * counter column on the parent record. Finds parent FK from the child's
 * `belongsTo` markers and matches it to any `hasMany` on the parent with
 * `counterCache: true | 'columnName'`.
 */
async function _adjustCounterCaches(record: any, ctor: any, delta: 1 | -1): Promise<void> {
  for (const key of Object.getOwnPropertyNames(ctor)) {
    const marker = ctor[key]
    if (!marker || typeof marker !== 'object') continue
    if (marker._type !== 'belongsTo') continue

    const fkField = marker.options?.foreignKey ?? `${key}Id`
    const parentId = record._attributes[fkField]
    if (!parentId) continue

    const ParentModel = _findModelByMarker(marker, key)
    if (!ParentModel) continue

    // Find the hasMany on the parent that points to this child's table and has counterCache
    for (const parentKey of Object.getOwnPropertyNames(ParentModel)) {
      const parentMarker = ParentModel[parentKey]
      if (!parentMarker || typeof parentMarker !== 'object' || parentMarker._type !== 'hasMany') continue
      if (!parentMarker.options?.counterCache) continue

      // Verify this hasMany actually points back to our model (the child)
      if (_findModelByMarker(parentMarker, parentKey) !== ctor) continue

      // Determine the counter column name: boolean → `<assoc>Count`, string → explicit name
      const counterCol = typeof parentMarker.options.counterCache === 'string'
        ? parentMarker.options.counterCache
        : `${parentKey}Count`

      const parentTable = getSchema()[ParentModel._activeDrizzleTableName ?? ParentModel.tableName]
      if (!parentTable || !parentTable[counterCol]) continue

      const db = getExecutor()
      await db
        .update(parentTable)
        .set({ [counterCol]: sql`${parentTable[counterCol]} + ${delta}` })
        .where(eq(parentTable.id, parentId))
    }
  }
}

/**
 * autosave: After saving a parent, save any already-loaded associations
 * that have `autosave: true` and have unsaved changes.
 */
async function _autosaveAssociations(record: any, ctor: any): Promise<void> {
  for (const key of Object.getOwnPropertyNames(ctor)) {
    const marker = ctor[key]
    if (!marker || typeof marker !== 'object') continue
    if (marker._type !== 'hasMany' && marker._type !== 'hasOne' && marker._type !== 'belongsTo') continue
    if (!marker.options?.autosave) continue

    // Only act if the association is already loaded (stored in _attributes)
    const loaded = record._attributes[key]
    if (!loaded) continue

    if (Array.isArray(loaded)) {
      for (const child of loaded) {
        if (child && typeof child.save === 'function' && child.isChanged?.()) {
          await child.save()
        }
      }
    } else if (loaded && typeof loaded.save === 'function' && loaded.isChanged?.()) {
      await loaded.save()
    }
  }
}

// ── Primary-key helpers ────────────────────────────────────────────────────────

/**
 * Returns the primary key value(s) for a record's attributes.
 * Supports:
 *   single string PK  → returns the scalar value
 *   composite PK []   → returns an array of values in declaration order
 * Default PK is 'id' when `static primaryKey` is not set.
 */
function _getPkValue(ctor: any, attributes: Record<string, any>): any {
  const pk = ctor.primaryKey ?? 'id'
  if (Array.isArray(pk)) return pk.map((k: string) => attributes[k])
  return attributes[pk as string]
}

/**
 * Builds a Drizzle WHERE expression that matches a record by its primary key.
 * For composite PKs, ANDs all the individual column conditions.
 */
function _buildPkWhere(ctor: any, table: any, pkValue: any): any {
  const pk = ctor.primaryKey ?? 'id'
  if (Array.isArray(pk)) {
    const values = Array.isArray(pkValue) ? pkValue : [pkValue]
    const clauses = pk.map((k: string, i: number) => eq(table[k], values[i]))
    return clauses.length === 1 ? clauses[0] : and(...clauses)
  }
  return eq(table[pk as string], pkValue)
}

// ── Proxy factory ─────────────────────────────────────────────────────────────

function _wrapRecord<T extends ApplicationRecord>(record: T): T {
  const ctor = record.constructor as any

  return new Proxy(record, {
    get(target: any, prop: string | symbol, receiver: any) {
      if (prop === 'then') return undefined

      // Own instance property or prototype method — pass through, never bind constructor
      if (typeof prop === 'symbol' || prop in target) {
        const val = Reflect.get(target, prop, receiver)
        if (typeof val === 'function' && prop !== 'constructor') return val.bind(receiver)
        return val
      }

      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver)

      // ── Attr get transform ──────────────────────────────────────────────
      const attrConfig = ctor[prop] as AttrConfig | undefined
      if (attrConfig?.get) {
        // Attr.for('colName', ...) redirects reads to a different attribute key
        const colKey: string = (attrConfig as any)._column ?? prop
        // _changes.is stores raw DB value; apply get() for display
        if (target._changes.has(colKey)) return attrConfig.get(target._changes.get(colKey)!.is)
        if (colKey in target._attributes) return attrConfig.get(target._attributes[colKey])
        if (!target.isNewRecord) {
          throw new Error(`MissingAttributeError: '${colKey}' was not selected in the query.`)
        }
        if (attrConfig.default !== undefined) {
          const def = typeof attrConfig.default === 'function' ? attrConfig.default() : attrConfig.default
          return attrConfig.get(def)
        }
        return undefined
      }

      // ── Association lazy loading ────────────────────────────────────────
      // If the class has a static property that is an association marker,
      // resolve it into a Promise (belongsTo/hasOne) or scoped Relation (hasMany/habtm).
      const assocMarker = ctor[prop]
      if (assocMarker && typeof assocMarker === 'object' && typeof assocMarker._type === 'string') {
        return _resolveAssociation(assocMarker, prop, target, ctor)
      }

      // ── is<Label>() and to<Label>() from Attr.enum ──────────────────────
      if (prop.length > 2) {
        const prefix = prop.slice(0, 2)
        if (prefix === 'is' || prefix === 'to') {
          const labelKey = prop[2]!.toLowerCase() + prop.slice(3)
          for (const [enumProp, enumConfig] of Object.entries(ctor) as [string, any][]) {
            if (enumConfig?._type !== 'enum') continue
            if (!(labelKey in (enumConfig as AttrEnumConfig).values)) continue
            if (prefix === 'is') {
              return () => {
                const raw = target._changes.has(enumProp)
                  ? target._changes.get(enumProp)!.is
                  : target._attributes[enumProp]
                return enumConfig.get(raw) === labelKey
              }
            }
            return () => {
              ;(receiver as any)[enumProp] = labelKey
              return receiver
            }
          }
        }
      }

      // ── Dirty tracking helpers ──────────────────────────────────────────
      if (prop.endsWith('Changed')) {
        const field = prop.slice(0, -7)
        return () => target._changes.has(field)
      }
      if (prop.endsWith('Was')) {
        const field = prop.slice(0, -3)
        return () => (target._changes.has(field) ? target._changes.get(field)!.was : undefined)
      }
      if (prop.endsWith('Change')) {
        const field = prop.slice(0, -6)
        return () => {
          if (!target._changes.has(field)) return null
          const { was, is } = target._changes.get(field)!
          return [was, is]
        }
      }

      // Plain column fallback — mirror Attr behavior: check _changes first, then _attributes.
      // This handles columns without an explicit Attr.* declaration.
      if (typeof prop === 'string') {
        if (target._changes.has(prop)) return target._changes.get(prop)!.is
        if (prop in target._attributes) return target._attributes[prop]
      }

      return Reflect.get(target, prop, receiver)
    },

    set(target: any, prop: string | symbol, value: any, receiver: any) {
      if (typeof prop === 'symbol' || prop in target) {
        return Reflect.set(target, prop, value, receiver)
      }

      const attrConfig = ctor[prop as string] as AttrConfig | undefined
      if (typeof attrConfig?.set === 'function') {
        // Attr.for('colName', ...) redirects writes to a different attribute key
        const colKey: string = (attrConfig as any)._column ?? (prop as string)
        const rawOriginal = target._attributes[colKey]
        const rawNew = attrConfig.set(value)   // DB value to store and send
        if (rawOriginal !== rawNew) {
          const was = attrConfig.get ? attrConfig.get(rawOriginal) : rawOriginal
          target._changes.set(colKey, { was, is: rawNew })
        } else {
          target._changes.delete(colKey)
        }
        return true
      }

      // Plain column (no Attr) — mirror Attr pattern: keep _attributes as the
      // original DB value, track the new value only in _changes.
      const rawOriginal = target._attributes[prop as string]
      if (rawOriginal !== value) {
        target._changes.set(prop as string, { was: rawOriginal, is: value })
      } else {
        // Setting back to original — clear any pending change
        target._changes.delete(prop as string)
      }
      return true
    },
  })
}

function toCamelCase(s: string): string {
  if (!s) return s
  // if it's got snake_case, let's turn it into camelCase first
  s = s.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
  return s[0]!.toLowerCase() + s.slice(1)
}
