import { eq, and, or, inArray, notInArray, arrayContains, isNull, ilike, desc, asc, gte, lte, gt, lt, ne, sql, type SQL } from 'drizzle-orm'
import { union, unionAll, intersect, except } from 'drizzle-orm/pg-core'
import { getExecutor, getSchema, MODEL_REGISTRY, transaction, RecordNotFound } from './boot.js'
import { modelClassName } from './class-name.js'
import type { ApplicationRecord } from './application-record.js'

/**
 * Given a Attr property name (e.g. 'price') that may have an Attr.for column mapping
 * (e.g. '_column: priceInCents'), returns the actual DB column property name.
 */
function _resolveColKey(Ctor: any, field: string): string {
  const attr = Ctor[field] as any
  return attr?._isAttr && attr._column ? attr._column : field
}

/**
 * Chainable query builder — the Rails `ActiveRecord::Relation` equivalent.
 *
 * Accumulates where clauses, ordering, limits, and includes before execution.
 * Every method returns `this`, so chains are pure expressions until awaited.
 *
 * Smart hash where() converts:
 *   .where({ status: 'sent' })   → eq(table.status, 1)   (via Attr.set transform)
 *   .where({ status: ['draft', 'sent'] })  → inArray(table.status, [0, 1])
 *   .where({ teamId: null })     → isNull(table.teamId)
 *   .where({ id: Asset.videos() })  → inArray(table.id, subquery)
 */
export class Relation<TModel extends ApplicationRecord = any, TRelations = Record<string, any>> {
  protected _ctor: any
  protected _tableName: string
  protected _where: SQL[] = []
  protected _limit: number | undefined
  protected _offset: number = 0
  protected _order: SQL[] = []
  protected _includes: Record<string, any> = {}
  protected _selectCols: string | undefined  // for toSubquery()
  
  protected _skipAllDefaultScopes = false
  protected _excludedDefaultScopes = new Set<string>()

  // ── Advanced query state (group/having, distinct, window select) ──────────
  protected _group: { col: any; field: string | null }[] = []
  protected _having: SQL | undefined
  protected _distinct = false
  protected _distinctOn: any[] | undefined

  constructor(modelClass: any) {
    this._ctor = modelClass
    this._tableName = modelClass.tableName
  }

  protected getTable(): any {
    const table = getSchema()[this._tableName]
    if (!table) throw new Error(`Table "${this._tableName}" not found in schema. Did you call boot()?`)
    return table
  }

  // ── Chainable modifiers ─────────────────────────────────────────────────

  /**
   * Accepts either:
   *   - a hash   { status: 'sent', teamId: null, id: someRelation }
   *   - a raw SQL expression returned from drizzle helpers (eq, and, etc.)
   */
  public where(condition: Record<string, any> | SQL | null | undefined): this {
    if (!condition) return this

    if (_isPlainObject(condition)) {
      this._applyHashWhere(condition as Record<string, any>)
    } else {
      this._where.push(condition as SQL)
    }
    return this
  }

  /**
   * Case-insensitive substring match ORed across columns:
   *
   *   User.search('ada', ['name', 'email'])
   *   → WHERE (name ILIKE '%ada%' OR email ILIKE '%ada%')
   *
   * The term is escaped (%, _, \ are literals), so user input can be passed
   * straight through. A blank term or empty field list is a no-op. Attr.for
   * column mappings resolve; fields must be text-typed columns.
   */
  public search(term: string | null | undefined, fields: string[]): this {
    const t = (term ?? '').trim()
    if (!t || !fields.length) return this
    const table = this.getTable()
    const pattern = '%' + t.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const conds = fields.map((f) => {
      const col = table[_resolveColKey(this._ctor, f)]
      if (!col) throw new Error(`Column "${f}" not found on table "${this._tableName}"`)
      return ilike(col, pattern)
    })
    this._where.push(conds.length === 1 ? conds[0]! : or(...conds)!)
    return this
  }

  /**
   * OR across hash-condition branches — each branch AND-composes internally,
   * the branches OR together, and the whole group ANDs with everything else:
   *
   *   Deal.all().whereAny([{ stage: 'draft' }, { priority: 'high' }])
   *   → WHERE (stage = 0 OR priority = 2)
   *
   * Branches use the SAME hash grammar as where() (codec transforms,
   * arrays → IN, operator objects) — depth 1 by design: no nested boolean
   * trees. Empty/blank branches are skipped; no valid branches = no-op.
   */
  public whereAny(branches: Array<Record<string, any>>): this {
    const exprs: SQL[] = []
    for (const branch of branches) {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue
      if (Object.keys(branch).length === 0) continue
      const scratch = this._clone()
      scratch._where = []
      scratch._applyHashWhere(branch)
      if (scratch._where.length === 1) exprs.push(scratch._where[0]!)
      else if (scratch._where.length > 1) exprs.push(and(...scratch._where) as SQL)
    }
    if (exprs.length === 1) this._where.push(exprs[0]!)
    else if (exprs.length > 1) this._where.push(or(...exprs) as SQL)
    return this
  }

  /**
   * Weighted full-text search — websearch-style query parsing over a
   * weighted on-the-fly tsvector (no generated column or migration needed;
   * add one later as a pure performance upgrade):
   *
   *   Deal.all().ftsSearch('acme expansion', { name: 'A', contactEmail: 'B' })
   *   → WHERE (setweight(to_tsvector(name),'A') || …) @@ websearch_to_tsquery('acme expansion')
   *
   * websearch semantics: quoted phrases, -negation, OR. Chain
   * .orderByRelevance() for ts_rank ordering. Blank term/no fields = no-op.
   */
  public ftsSearch(term: string | null | undefined, fields: Record<string, 'A' | 'B' | 'C' | 'D'>): this {
    const t = (term ?? '').trim()
    const entries = Object.entries(fields)
    if (!t || !entries.length) return this
    const table = this.getTable()
    let vec: SQL | null = null
    for (const [f, w] of entries) {
      const col = table[_resolveColKey(this._ctor, f)]
      if (!col) throw new Error(`Column "${f}" not found on table "${this._tableName}"`)
      const weight = ['A', 'B', 'C', 'D'].includes(w) ? w : 'D'
      const piece = sql`setweight(to_tsvector('english', coalesce(${col}, '')), ${sql.raw(`'${weight}'`)})`
      vec = vec ? sql`${vec} || ${piece}` : piece
    }
    // HYBRID match: full-text (websearch semantics) OR substring — a
    // half-typed 'glo' still finds 'Globex' (type-ahead survives), while
    // ts_rank orders real lexeme matches above substring-only ones
    const pattern = '%' + t.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const likes = entries.map(([f]) => {
      const col = table[_resolveColKey(this._ctor, f)]
      return ilike(col, pattern)
    })
    this._where.push(or(sql`${vec!} @@ websearch_to_tsquery('english', ${t})`, ...likes)!)
    ;(this as any)._ftsRank = sql`ts_rank(${vec!}, websearch_to_tsquery('english', ${t}))`
    return this
  }

  /** Order by the last ftsSearch's ts_rank (highest relevance first). No-op without a search. */
  public orderByRelevance(): this {
    const rank = (this as any)._ftsRank as SQL | undefined
    if (rank) this._order.push(desc(rank))
    return this
  }

  /**
   * .limit(10)
   */
  public limit(amount: number): this {
    this._limit = amount
    return this
  }

  /**
   * .offset(20)
   */
  public offset(amount: number): this {
    this._offset = amount
    return this
  }

  /**
   * .order('createdAt', 'desc')  — string + direction
   * .order(desc(table.createdAt)) — raw drizzle expression
   */
  public order(field: string | SQL, direction: 'asc' | 'desc' = 'asc'): this {
    if (typeof field === 'string') {
      const table = this.getTable()
      const col = table[field]
      if (!col) throw new Error(`Column "${field}" not found on table "${this._tableName}"`)
      this._order.push(direction === 'desc' ? desc(col) : asc(col))
    } else {
      this._order.push(field)
    }
    return this
  }

  /**
   * Recursive types for deep nested includes generic mapping.
   */
  public includes<
    TArg extends IncludeArg<TRelations>,
    TArgs extends IncludeArg<TRelations>[]
  >(
    arg: TArg,
    ...args: TArgs
  ): Relation<TModel & MapInclude<TRelations, TArg> & MapInclude<TRelations, TArgs[number]>, TRelations> {
    const all = [arg, ...args]
    for (const a of all) {
      if (typeof a === 'string') {
        this._includes[a as string] = true
      } else if (typeof a === 'object' && a !== null) {
        for (const [k, v] of Object.entries(a)) {
          this._includes[k] = _toDrizzleWith(v)
        }
      }
    }
    return this as any
  }

  /**
   * Applies all active default scopes to a clone of this relation and returns it.
   * Execution methods (load, count, etc.) call this before hitting the database.
   */
  protected _withDefaultScopes(): this {
    if (this._skipAllDefaultScopes) return this

    const dscopes = this._ctor.__defaultScopes as Map<string, (q: any) => any> | undefined
    if (!dscopes || dscopes.size === 0) return this

    let activeScopes = 0
    for (const name of dscopes.keys()) {
      if (!this._excludedDefaultScopes.has(name)) activeScopes++
    }
    if (activeScopes === 0) return this

    const cloned = this._clone() as this
    cloned._skipAllDefaultScopes = true // avoid recursive wrapping

    for (const [name, fn] of dscopes.entries()) {
      if (!this._excludedDefaultScopes.has(name)) {
        fn.call(this._ctor, cloned)
      }
    }
    return cloned
  }

  /**
   * Removes default scopes.
   *   .unscoped()               → removes all default scopes
   *   .unscoped('SoftDelete')   → removes only the 'SoftDelete' scope
   */
  public unscoped(concernName?: string): this {
    const next = this._clone() as this
    if (concernName) {
      next._excludedDefaultScopes.add(concernName)
    } else {
      next._skipAllDefaultScopes = true
    }
    return next
  }

  // ── Advanced query modifiers ──────────────────────────────────────────────

  /** Resolves a camelCase field (honoring `Attr.for` column maps) to its drizzle column. */
  protected _col(field: string): any {
    const table = this.getTable()
    const col = table[_resolveColKey(this._ctor, field)]
    if (!col) throw new Error(`Column "${field}" not found on table "${this._tableName}"`)
    return col
  }

  /**
   * GROUP BY. Turns the aggregate terminals (`count`/`sum`/`average`/`minimum`/
   * `maximum`) into `{ groupKey → value }` maps, exactly like Rails'
   * `Order.group(:status).sum(:total)`. Accepts field names or raw `sql`.
   */
  public group(...fields: (string | SQL)[]): this {
    for (const f of fields) {
      if (typeof f === 'string') this._group.push({ col: this._col(f), field: f })
      else this._group.push({ col: f, field: null })
    }
    return this
  }

  /** HAVING — filter groups. `.group('userId').having(sql`count(*) > 5`)`. */
  public having(condition: SQL): this {
    this._having = this._having ? (and(this._having, condition) as SQL) : condition
    return this
  }

  /**
   * `.distinct()`            → SELECT DISTINCT
   * `.distinct('userId')`    → SELECT DISTINCT ON (user_id) …  (one row per group;
   *                            pair with `.order('userId').order('placedAt','desc')`
   *                            for "latest per user")
   */
  public distinct(on?: string | string[]): this {
    if (on === undefined) { this._distinct = true; return this }
    this._distinctOn = (Array.isArray(on) ? on : [on]).map(f => this._col(f))
    return this
  }

  /**
   * Keyset / cursor pagination — O(1) deep paging that OFFSET can't do.
   * Orders by `fields` and, when `after` is given, keeps only rows strictly
   * past that cursor via a row-value comparison `(a,b) > (va,vb)`.
   *
   *   const page1 = await Product.all().seek(['createdAt', 'id']).limit(20)
   *   const page2 = await Product.all().seek(['createdAt','id'], { after: page1.at(-1)! }).limit(20)
   */
  public seek(fields: string[], opts: { after?: Record<string, any>; dir?: 'asc' | 'desc' } = {}): this {
    const dir  = opts.dir ?? 'asc'
    const cols = fields.map(f => this._col(f))
    for (const c of cols) this._order.push((dir === 'desc' ? desc(c) : asc(c)) as SQL)
    if (opts.after) {
      const vals = fields.map(f => {
        const attr = (this._ctor as any)[f]
        const v = (opts.after as any)[f]
        return attr?._isAttr && attr.set ? attr.set(v) : v
      })
      const cmp = dir === 'desc' ? sql`<` : sql`>`
      this._where.push(
        sql`(${sql.join(cols, sql`, `)}) ${cmp} (${sql.join(vals.map(v => sql`${v}`), sql`, `)})` as SQL,
      )
    }
    return this
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /**
   * Executes and returns typed model instances.
   * When querying a parent STI table, instantiates the correct subclass
   * based on the type discriminator column.
   */
  public async load(): Promise<TModel[]> {
    const rows = await this._withDefaultScopes()._buildQuery()

    // STI subclass resolution: build the typeValue → subclass map ONCE for the
    // whole result set instead of scanning MODEL_REGISTRY per row (was O(rows ×
    // registered models)). `null` when this isn't an STI parent query.
    const subclassMap = this._buildSubclassMap()
    if (!subclassMap) {
      return rows.map((r: any) => new (this._ctor as any)(r, false))
    }

    const stiCol = this._ctor.stiTypeColumn ?? 'type'
    return rows.map((r: any) => {
      const typeVal = r[stiCol]
      const SubClass = (typeVal !== undefined && typeVal !== null ? subclassMap.get(typeVal) : undefined) ?? this._ctor
      return new (SubClass as any)(r, false)
    })
  }

  /**
   * Builds a `typeValue → subclass` map for an STI *parent* query, or returns
   * `null` when resolution doesn't apply (this relation is already a subclass,
   * or the table has no registered subclasses). First-registered wins on a
   * duplicate `stiType`, matching the previous per-row `_resolveSubclass` scan.
   */
  protected _buildSubclassMap(): Map<any, any> | null {
    if (this._ctor.stiType !== undefined) return null   // already querying a subclass
    const map = new Map<any, any>()
    for (const cls of Object.values(MODEL_REGISTRY)) {
      const c = cls as any
      if (c.stiType !== undefined && c._activeDrizzleTableName === this._tableName) {
        if (!map.has(c.stiType)) map.set(c.stiType, cls)
      }
    }
    return map.size > 0 ? map : null
  }

  /** Alias for load() — `User.where({ active: true }).all()` executes the query. */
  public all(): Promise<TModel[]> {
    return this.load()
  }

  /**
   * Dispatch query into the async pool immediately, return later.
   * Prevents serial blocking.
   */
  public loadAsync(): this {
    ;(this as any)._pendingPromise = this.load()
    return this
  }

  /** Awaitable — `await Asset.where({ teamId: 5 })` resolves to instances. */
  public async then<TResult1 = TModel[], TResult2 = never>(
    onfulfilled?: ((value: TModel[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    try {
      const result = (this as any)._pendingPromise
        ? await (this as any)._pendingPromise
        : await this.load()
      return onfulfilled ? onfulfilled(result) : (result as any)
    } catch (e) {
      if (onrejected) return onrejected(e) as TResult2
      throw e
    }
  }

  /** Loads first record, returns null if none. */
  public async first(): Promise<TModel | null> {
    const cloned = this._clone() as this
    cloned._limit = 1
    const rows = await cloned.load()
    return rows[0] ?? null
  }

  /** Like first() but raises RecordNotFound if nothing matches. */
  public async firstBang(): Promise<TModel> {
    const rec = await this.first()
    if (rec == null) throw new RecordNotFound(modelClassName(this._ctor), '(first)')
    return rec
  }

  /** Association create-defaults — set by the hasMany/hasOne resolver. */
  protected _createDefaults?: Record<string, any>

  /**
   * Create a record THROUGH this relation. Association-scoped relations
   * contribute their scope automatically — `deal.comments.create({ body })`
   * sets the foreign key AND (for an `as:` polymorphic inverse) the type
   * column, so a child can never be created unparented or mistyped.
   * Explicit attrs win over the defaults. On a bare relation this is just
   * Model.create. (through/habtm relations carry no defaults — create the
   * join row through its own model, or sync via `<singular>Ids`.)
   */
  public async create(attrs: Record<string, any> = {}): Promise<TModel> {
    return (this._ctor as any).create({ ...(this._createDefaults ?? {}), ...attrs })
  }

  /** Like create() but returns the UNSAVED instance (Rails' build). */
  public build(attrs: Record<string, any> = {}): TModel {
    return new (this._ctor as any)({ ...(this._createDefaults ?? {}), ...attrs })
  }

  /**
   * Returns last record(s) by reversing the current order (or defaulting to
   * descending id). Returns a single record when called without arguments,
   * or an array of `n` records when `n` is given.
   */
  public async last(n?: number): Promise<TModel | null | TModel[]> {
    const pk    = (this._ctor as any).primaryKey ?? 'id'
    const pkCol = Array.isArray(pk) ? pk[0]! : pk
    const cloned = this._clone()
    // Reverse existing order, or add DESC on the PK
    if (cloned._order.length === 0) {
      const table = this.getTable()
      if (table[pkCol]) cloned._order = [desc(table[pkCol])]
    } else {
      cloned._order = cloned._order.map((o: any) => {
        // Swap asc ↔ desc by inspecting the SQL string — Drizzle puts 'asc'/'desc' at the end
        const s = String(o)
        if (s.includes(' desc')) return asc((o as any).column ?? o)
        return desc((o as any).column ?? o)
      })
    }
    if (n !== undefined) {
      cloned._limit = n
      const rows = await cloned.load()
      return rows.reverse()
    }
    cloned._limit = 1
    const rows = await cloned.load()
    return rows[0] ?? null
  }

  /** last() variant that raises RecordNotFound if nothing matches. */
  public async lastBang(): Promise<TModel> {
    const rec = await this.last()
    if (rec == null) throw new RecordNotFound(modelClassName(this._ctor), '(last)')
    return rec as TModel
  }

  /**
   * Returns the first record (or null) without changing the existing order.
   * Like Rails' take — "grab whatever comes first from the DB".
   * With `n`, returns an array of up to n records.
   */
  public async take(n?: number): Promise<TModel | null | TModel[]> {
    const cloned = this._clone()
    if (n !== undefined) { cloned._limit = n; return cloned.load() }
    cloned._limit = 1
    const rows = await cloned.load()
    return rows[0] ?? null
  }

  // ── Aggregates ────────────────────────────────────────────────────────────

  /**
   * Shared aggregate engine. Without `.group(...)` returns the scalar; with
   * `.group(...)` returns a `{ groupKey → value }` map (Rails-style overload),
   * applying `.having(...)` and Attr.get on the group keys (enum ints → labels).
   */
  private async _agg(aggExpr: SQL, scalarDefault: any, toScalar: (v: any) => any): Promise<any> {
    const grouped = this._group.length > 0
    if ((this as any)._isNone) return grouped ? {} : scalarDefault

    const rel   = this._withDefaultScopes()
    const table = rel.getTable()
    const where = rel._buildFinalWhere()

    if (!grouped) {
      let q: any = getExecutor().select({ n: aggExpr }).from(table)
      if (where) q = q.where(where)
      const [row] = await q
      return toScalar((row as any)?.n)
    }

    const sel: Record<string, any> = { n: aggExpr }
    rel._group.forEach((g, i) => { sel['_g' + i] = g.col })
    let q: any = getExecutor().select(sel).from(table)
    if (where) q = q.where(where)
    q = q.groupBy(...rel._group.map(g => g.col))
    if (rel._having) q = q.having(rel._having)

    const rows: any[] = await q
    const out: Record<string, any> = {}
    for (const r of rows) {
      const key = rel._group.map((g, i) => {
        const raw  = r['_g' + i]
        const attr = g.field ? (rel._ctor as any)[g.field] : undefined
        return attr?._isAttr && attr.get ? String(attr.get(raw)) : String(raw ?? 'null')
      }).join(',')
      out[key] = toScalar(r.n)
    }
    return out
  }

  /** Count of matching records — or, with `.group(...)`, a `{ groupKey → count }` map. */
  public async count(): Promise<number> {
    return this._agg(sql`count(*)::int`, 0, v => Number(v ?? 0))
  }

  /** SUM of a column (Attr.for aware) — scalar, or a `{ groupKey → sum }` map when grouped. */
  public async sum(field: string): Promise<number> {
    return this._agg(sql`coalesce(sum(${this._col(field)}), 0)::numeric`, 0, v => Number(v ?? 0))
  }

  /** AVERAGE of a column (null if no rows) — or a `{ groupKey → avg }` map when grouped. */
  public async average(field: string): Promise<number | null> {
    return this._agg(sql`avg(${this._col(field)})::numeric`, null, v => (v == null ? null : Number(v)))
  }

  /** Minimum value of a column — or a `{ groupKey → min }` map when grouped. */
  public async minimum(field: string): Promise<any> {
    return this._agg(sql`min(${this._col(field)})`, null, v => v ?? null)
  }

  /** Maximum value of a column — or a `{ groupKey → max }` map when grouped. */
  public async maximum(field: string): Promise<any> {
    return this._agg(sql`max(${this._col(field)})`, null, v => v ?? null)
  }

  /**
   * Runs several aggregates over the SAME relation in **one round-trip** — the
   * multi-metric dashboard query. Beats firing N async aggregates concurrently
   * (which is N round-trips): this is a single `SELECT count(*), sum(…), avg(…)`.
   *
   *   const { orders, revenue, avg } = await Order.where({ paid: true }).aggregate(a => ({
   *     orders:  a.count(),
   *     revenue: a.sum('total'),
   *     avg:     a.average('total'),
   *   }))
   *
   * Composes with `.group(...)` → `{ groupKey → { …metrics } }` in one query.
   */
  public async aggregate<S extends Record<string, AggTerm>>(
    build: (a: AggBuilder) => S,
  ): Promise<Record<keyof S, any> | Record<string, Record<keyof S, any>>> {
    const rel   = this._withDefaultScopes()
    const table = rel.getTable()
    const where = rel._buildFinalWhere()
    const a: AggBuilder = {
      count:   ()          => ({ expr: sql`count(*)::int`,                             to: v => Number(v ?? 0) }),
      sum:     (f: string) => ({ expr: sql`coalesce(sum(${rel._col(f)}), 0)::numeric`, to: v => Number(v ?? 0) }),
      average: (f: string) => ({ expr: sql`avg(${rel._col(f)})::numeric`,              to: v => (v == null ? null : Number(v)) }),
      minimum: (f: string) => ({ expr: sql`min(${rel._col(f)})`,                       to: v => v ?? null }),
      maximum: (f: string) => ({ expr: sql`max(${rel._col(f)})`,                       to: v => v ?? null }),
    }
    const spec = build(a)
    const keys = Object.keys(spec)

    const sel: Record<string, any> = {}
    for (const k of keys) sel[k] = spec[k]!.expr
    const grouped = rel._group.length > 0
    if (grouped) rel._group.forEach((g, i) => { sel['_g' + i] = g.col })

    let q: any = getExecutor().select(sel).from(table)
    if (where) q = q.where(where)
    if (grouped) {
      q = q.groupBy(...rel._group.map(g => g.col))
      if (rel._having) q = q.having(rel._having)
    }
    const rows: any[] = await q

    const shape = (row: any) => {
      const o: Record<string, any> = {}
      for (const k of keys) o[k] = spec[k]!.to(row?.[k])
      return o
    }
    if (!grouped) return shape(rows[0]) as any

    const out: Record<string, any> = {}
    for (const r of rows) {
      const key = rel._group.map((g, i) => {
        const raw  = r['_g' + i]
        const attr = g.field ? (rel._ctor as any)[g.field] : undefined
        return attr?._isAttr && attr.get ? String(attr.get(raw)) : String(raw ?? 'null')
      }).join(',')
      out[key] = shape(r)
    }
    return out
  }

  /**
   * Returns an object mapping each distinct value of `field` to its count.
   * Like Rails' tally: `Order.all().tally('status')` → `{ pending: 3, confirmed: 7 }`.
   * Applies Attr.get transform so enum integers appear as labels.
   */
  public async tally(field: string): Promise<Record<string, number>> {
    if ((this as any)._isNone) return {}
    const rel = this._withDefaultScopes()
    const table  = rel.getTable()
    const colKey = _resolveColKey(rel._ctor, field)
    const col    = table[colKey]
    if (!col) throw new Error(`Column "${colKey}" not found on "${rel._tableName}"`)
    const whereExpr = rel._buildFinalWhere()
    let q: any = getExecutor()
      .select({ val: col, n: sql<number>`count(*)::int` })
      .from(table)
      .groupBy(col)
    if (whereExpr) q = q.where(whereExpr)

    const rows: any[] = await q
    const Ctor = rel._ctor
    const attrGet = (Ctor[field] as any)?._isAttr ? (Ctor[field] as any).get : undefined

    const result: Record<string, number> = {}
    for (const row of rows) {
      const rawVal = row.val
      const label  = attrGet ? String(attrGet(rawVal)) : String(rawVal ?? 'null')
      result[label] = Number(row.n)
    }
    return result
  }

  /**
   * Returns true if at least one record matches.
   * Optional `cond` can be a hash (merged into existing where).
   */
  public async exists(cond?: Record<string, any>): Promise<boolean> {
    if ((this as any)._isNone) return false
    let rel: Relation<TModel> = this._clone() as any
    if (cond) rel = rel.where(cond) as any
    rel = rel._withDefaultScopes()
    const table = rel.getTable()
    const whereExpr = rel._buildFinalWhere()
    let q: any = getExecutor().select({ one: sql`1` }).from(table).limit(1)
    if (whereExpr) q = q.where(whereExpr)
    const rows = await q
    return rows.length > 0
  }

  /** Alias for exists() — mirrors Rails' `.any?`. */
  public async any(cond?: Record<string, any>): Promise<boolean> {
    return this.exists(cond)
  }

  /** Returns true if more than one record matches. */
  public async many(): Promise<boolean> {
    return (await this.count()) > 1
  }

  /** Returns true if exactly one record matches. */
  public async one(): Promise<boolean> {
    return (await this.count()) === 1
  }

  /** Returns true if no records match. */
  public async empty(): Promise<boolean> {
    return !(await this.exists())
  }

  /**
   * Returns a "none" Relation that always resolves to an empty array.
   * Useful for short-circuiting without special-casing downstream code.
   */
  public none(): this {
    const c = this._clone() as any
    c._isNone = true
    return c
  }

  // ── Retrieval shortcuts ───────────────────────────────────────────────────

  /**
   * pick(...cols) — returns the first row's values for the given columns.
   * Single column → plain value. Multiple → plain object.
   * Mirrors Rails' .pick.
   *
   * @example
   * await User.where({ email: 'a@b.com' }).pick('id')       // → 1
   * await User.where({ email: 'a@b.com' }).pick('id','name') // → { id:1, name:'Alice' }
   */
  public async pick(...cols: string[]): Promise<any> {
    const cloned = this._clone()
    cloned._limit = 1
    const rows = await cloned.pluck(...cols)
    return rows[0] ?? null
  }

  /** Returns all primary key values for matching records. Like Rails' .ids. */
  public async ids(): Promise<any[]> {
    const pk = (this._ctor as any).primaryKey ?? 'id'
    if (Array.isArray(pk)) return this.pluck(...pk)
    return this.pluck(pk as string)
  }

  /**
   * Iterate over every matching record one at a time, without loading all in memory.
   * Lower overhead than inBatches when you don't need the whole batch at once.
   */
  public async findEach(batchSize: number, fn: (record: TModel) => Promise<void>): Promise<void> {
    await this.inBatches(batchSize, async (batch) => {
      for (const record of await batch.load()) await fn(record)
    })
  }

  /**
   * Finds the first record matching `attrs`, or returns a new (unsaved) instance.
   */
  public async findOrInitializeBy(attrs: Record<string, any>): Promise<TModel> {
    const found = await this.where(attrs).first()
    if (found) return found
    return new (this._ctor as any)(attrs, true) as TModel
  }

  /**
   * Finds the first record matching `attrs`, or creates it.
   * Raises if validation fails on create.
   */
  public async findOrCreateBy(attrs: Record<string, any>): Promise<TModel> {
    const found = await this.where(attrs).first()
    if (found) return found
    return (this._ctor as any).create(attrs) as TModel
  }

  /**
   * Pluck bypasses proxy instantiation entirely.
   * Applies Attr.get() transforms in-memory on the raw rows.
   */
  /**
   * Returns an array of values for the specified fields, bypassing Proxy wrapping.
   *
   * **Flat fields** (no dot): fast `db.select()` path.
   *   - Respects `Attr.for('colName', { get })` — reads the actual DB column and
   *     applies the get transform before returning.
   *   - Single field → `string[]`.  Multiple fields → `Record<string,any>[]`.
   *
   * **Nested paths** (`'assoc.field'`): switches to `db.query.findMany({ columns, with })`
   *   so Postgres does the join — **one round-trip, no N+1**.
   *   - Auto-resolves the target model via `MODEL_REGISTRY` to apply `Attr.for` maps.
   *   - Dot-notation key preserved in the result object: `{ 'user.email': '...' }`.
   *
   * @example
   * await Product.all().pluck('name', 'price')
   * //=> [{ name: 'Widget', price: 19.99 }, ...]    (Attr.for transform applied)
   *
   * await Order.all().pluck('id', 'user.email')
   * //=> [{ id: 1, 'user.email': 'alice@...' }, ...]
   *
   * await LineItem.all().pluck('qty', 'order.id', 'product.name', 'product.price')
   * //=> [{ qty: 2, 'order.id': 7, 'product.name': 'Widget', 'product.price': 19.99 }, ...]
   */
  public async pluck(...fields: string[]): Promise<any[]> {
    if ((this as any)._isNone) return []
    const rel = this._withDefaultScopes()
    const Ctor = rel._ctor

    // ── Fast path: all flat (no dots) ─────────────────────────────────────
    if (fields.every(f => !f.includes('.'))) {
      return rel._pluckFlat(fields, Ctor)
    }

    // ── Nested pluck: at least one dotted path ─────────────────────────────
    const flatFields  = fields.filter(f => !f.includes('.'))
    const nestedPaths = fields.filter(f => f.includes('.'))

    // Flat fields: map to actual column keys (Attr.for support)
    const topColumns: Record<string, true> = {}
    const flatColMap: Record<string, { colKey: string; attrGet?: (v: any) => any }> = {}
    for (const f of flatFields) {
      const attr = (Ctor as any)[f] as any
      const colKey: string = attr?._isAttr && attr._column ? attr._column : f
      topColumns[colKey] = true
      flatColMap[f] = { colKey, attrGet: attr?._isAttr ? attr.get : undefined }
    }

    // Nested paths: group by root, resolve each sub-field's column key + Attr.get
    type NestedFieldInfo = { colKey: string; attrGet?: (v: any) => any }
    const nestedInfo: Record<string, NestedFieldInfo> = {}     // path → info
    const withColumns: Record<string, Record<string, true>> = {} // root → cols

    for (const path of nestedPaths) {
      const dot   = path.indexOf('.')
      const root  = path.slice(0, dot)
      const sub   = path.slice(dot + 1)

      const marker    = (Ctor as any)[root]
      let colKey      = sub
      let attrGet: ((v: any) => any) | undefined

      if (marker?._type) {
        const TargetCtor = _lookupAssocTarget(marker, root)
        if (TargetCtor) {
          const targetAttr = (TargetCtor as any)[sub] as any
          if (targetAttr?._isAttr) {
            colKey = targetAttr._column ?? sub
            attrGet = targetAttr.get
          }
        }
      }

      nestedInfo[path] = attrGet !== undefined ? { colKey, attrGet } : { colKey }
      if (!withColumns[root]) withColumns[root] = {}
      withColumns[root]![colKey] = true
    }

    const withConfig: Record<string, { columns: Record<string, true> }> = {}
    for (const [root, cols] of Object.entries(withColumns)) {
      withConfig[root] = { columns: cols }
    }

    // Build findMany config
    const config: Record<string, any> = {}
    if (Object.keys(topColumns).length > 0) config.columns = topColumns
    if (Object.keys(withConfig).length > 0)  config.with    = withConfig
    const whereExpr = rel._buildFinalWhere()
    if (whereExpr)              config.where   = whereExpr
    if (rel._limit)            config.limit   = rel._limit
    if (rel._offset > 0)       config.offset  = rel._offset
    if (rel._order.length > 0) config.orderBy = rel._order

    const rows: any[] = await (getExecutor().query as any)[rel._tableName].findMany(config)

    return rows.map((row: any) => {
      // Single-field shortcut → plain value
      if (fields.length === 1) {
        const path = fields[0]!
        if (!path.includes('.')) {
          const { colKey, attrGet } = flatColMap[path]!
          return attrGet ? attrGet(row[colKey]) : row[colKey]
        }
        const dot    = path.indexOf('.')
        const root   = path.slice(0, dot)
        const { colKey, attrGet } = nestedInfo[path]!
        const val    = (row[root] as any)?.[colKey]
        return attrGet ? attrGet(val) : val
      }

      // Multiple fields → object with dotted-key notation preserved
      const out: Record<string, any> = {}
      for (const f of flatFields) {
        const { colKey, attrGet } = flatColMap[f]!
        out[f] = attrGet ? attrGet(row[colKey]) : row[colKey]
      }
      for (const path of nestedPaths) {
        const dot  = path.indexOf('.')
        const root = path.slice(0, dot)
        const { colKey, attrGet } = nestedInfo[path]!
        const val  = (row[root] as any)?.[colKey]
        out[path]  = attrGet ? attrGet(val) : val
      }
      return out
    })
  }

  /** Flat-only pluck via `db.select()` — bypasses relational API entirely. */
  private async _pluckFlat(fields: string[], Ctor: any): Promise<any[]> {
    if ((this as any)._isNone) return []
    const rel = this._withDefaultScopes()
    const db    = getExecutor()
    const table = rel.getTable()

    const selection: Record<string, any> = {}
    const colMap: Record<string, { colKey: string; attrGet?: (v: any) => any }> = {}
    for (const f of fields) {
      const attr    = Ctor[f] as any
      const colKey: string = attr?._isAttr && attr._column ? attr._column : f
      const col = table[colKey]
      if (col) {
        selection[colKey] = col
        colMap[f] = { colKey, attrGet: attr?._isAttr ? attr.get : undefined }
      }
    }

    let q: any = db.select(Object.keys(selection).length > 0 ? (selection as any) : undefined).from(table)
    const whereExpr = rel._buildFinalWhere()
    if (whereExpr)              q = q.where(whereExpr)
    if (rel._limit)            q = q.limit(rel._limit)
    if (rel._offset > 0)       q = q.offset(rel._offset)
    if (rel._order.length > 0) q = q.orderBy(...rel._order)

    const rows: any[] = await q

    return rows.map((row: any) => {
      if (fields.length === 1) {
        const f = fields[0]!
        const { colKey, attrGet } = colMap[f] ?? { colKey: f }
        return attrGet ? attrGet(row[colKey]) : row[colKey]
      }
      const out: Record<string, any> = {}
      for (const f of fields) {
        const { colKey, attrGet } = colMap[f] ?? { colKey: f }
        out[f] = attrGet ? attrGet(row[colKey]) : row[colKey]
      }
      return out
    })
  }

  /**
   * Bulk UPDATE — bypasses proxies and hooks.
   * Values are run through Attr.set() before hitting the database.
   */
  public async updateAll(updates: Record<string, any>): Promise<number> {
    const rel = this._withDefaultScopes()
    const db = getExecutor()
    const table = rel.getTable()
    const Ctor = rel._ctor
    const mapped: Record<string, any> = {}
    for (const [key, val] of Object.entries(updates)) {
      mapped[key] = Ctor[key]?._isAttr && Ctor[key].set ? Ctor[key].set(val) : val
    }
    let q: any = db.update(table).set(mapped)
    const whereExpr = rel._buildFinalWhere()
    if (whereExpr) q = q.where(whereExpr)
    const result = await q
    return (result as any)?.rowCount ?? (result as any)?.length ?? 0
  }

  /**
   * Bulk DELETE for all records matching the current where clauses.
   */
  public async destroyAll(): Promise<number> {
    const rel = this._withDefaultScopes()
    const db = getExecutor()
    const table = rel.getTable()
    let q: any = db.delete(table)
    const whereExpr = rel._buildFinalWhere()
    if (whereExpr) q = q.where(whereExpr)
    const result = await q
    return (result as any)?.rowCount ?? 0
  }

  /**
   * Iterates over matching records in batches of `batchSize`.
   * The `batch` Relation passed to the callback is scoped to that chunk —
   * call batch.updateAll() or batch.destroyAll() to act on just the chunk.
   *
   * @example
   * await Asset.where({ status: 'draft' }).inBatches(500, async (batch) => {
   *   await batch.updateAll({ status: 'archived' })
   * })
   */
  public async inBatches(
    batchSize: number,
    callback: (batch: this) => Promise<void>
  ): Promise<void> {
    let offset = 0
    while (true) {
      const batch = this._clone()
      batch._limit = batchSize
      batch._offset = offset
      const rows = await batch.load()
      if (rows.length === 0) break
      await callback(batch as this)
      if (rows.length < batchSize) break
      offset += batchSize
    }
  }

  /**
   * Returns a Drizzle sub-query expression selecting `selectColumn` from this
   * relation's table with all current where clauses applied.
   *
   * Useful as a value in a parent where() hash:
   *   Team.where({ id: Asset.videos().toSubquery('teamId') })
   *   → WHERE id IN (SELECT team_id FROM assets WHERE ...)
   */
  public toSubquery(selectColumn = 'id'): any {
    const rel = this._withDefaultScopes()
    const table = rel.getTable()
    const col = table[selectColumn]
    if (!col) throw new Error(`Column "${selectColumn}" not found on table "${rel._tableName}"`)
    let q: any = getExecutor().select({ _val: col }).from(table)
    const whereExpr = rel._buildFinalWhere()
    if (whereExpr) q = q.where(whereExpr)
    return q
  }

  /**
   * Executes the relation inside a transaction with `SELECT ... FOR UPDATE`.
   * Prevents other transactions from modifying the rows until the lock is released.
   * Must be inside a transaction — one is created automatically if not present.
   *
   * @example
   * await Asset.where({ id: assetId }).withLock(async (locked) => {
   *   const asset = await locked.first()
   *   await asset!.update({ status: 'processing' })
   * })
   */
  public withLock<T>(callback: (locked: this) => Promise<T>): Promise<T> {
    return transaction(async () => {
      const locked = this._clone() as this
      ;(locked as any)._forUpdate = true
      return callback(locked)
    })
  }

  /**
   * Arbitrary projection — the window-function / computed-column escape hatch.
   * The callback receives the drizzle table (real columns) and `Fn` (window
   * helpers) and returns a selection map. Honors current where/group/having/
   * order/limit and returns plain typed rows (NOT model instances).
   *
   *   // rank products by price within their type
   *   await Product.all().select((t, fn) => ({
   *     name: t.name,
   *     rank: fn.rank().over({ partitionBy: t.type, orderBy: desc(t.priceInCents) }),
   *   }))
   */
  public async select<S extends Record<string, any>>(
    build: (t: any, fn: typeof Fn) => S,
  ): Promise<{ [K in keyof S]: any }[]> {
    if ((this as any)._isNone) return []
    const rel   = this._withDefaultScopes()
    const table = rel.getTable()
    const where = rel._buildFinalWhere()

    let q: any = getExecutor().select(build(table, Fn)).from(table)
    if (where) q = q.where(where)
    if (rel._group.length > 0) q = q.groupBy(...rel._group.map(g => g.col))
    if (rel._having) q = q.having(rel._having)
    if (rel._order.length > 0) q = q.orderBy(...rel._order)
    if (rel._limit) q = q.limit(rel._limit)
    if (rel._offset > 0) q = q.offset(rel._offset)
    return await q
  }

  // ── Set operations (UNION / INTERSECT / EXCEPT) → model instances ─────────
  public union(other: Relation<TModel>): Promise<TModel[]>     { return this._setOp(union, other) }
  public unionAll(other: Relation<TModel>): Promise<TModel[]>  { return this._setOp(unionAll, other) }
  public intersect(other: Relation<TModel>): Promise<TModel[]> { return this._setOp(intersect, other) }
  public except(other: Relation<TModel>): Promise<TModel[]>    { return this._setOp(except, other) }

  private async _setOp(op: any, other: Relation<TModel>): Promise<TModel[]> {
    const db = getExecutor()
    const leg = (r: Relation<TModel>) => {
      const s = r._withDefaultScopes()
      let q: any = db.select().from(s.getTable())
      const w = s._buildFinalWhere()
      return w ? q.where(w) : q
    }
    let combined: any = op(leg(this), leg(other))
    if (this._order.length > 0) combined = combined.orderBy(...this._order)
    if (this._limit) combined = combined.limit(this._limit)
    const rows: any[] = await combined
    return rows.map((r: any) => new (this._ctor as any)(r, false))
  }

  /**
   * Compiles the current query to `{ sql, params }` without running it — the
   * "let me see the SQL" debugging tool every ORM should have.
   */
  public toSQL(): { sql: string; params: unknown[] } {
    if ((this as any)._isNone) return { sql: 'select where false', params: [] }
    return (this._buildQuery() as any).toSQL()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Builds the final WHERE expression, injecting the STI type discriminator
   * automatically when querying a subclass with `static stiType` set.
   */
  protected _buildFinalWhere(): SQL | undefined {
    const clauses = [...this._where]

    // STI: auto-inject `WHERE type = stiType` for subclass queries
    const stiType = this._ctor.stiType
    if (stiType !== undefined) {
      const table = this.getTable()
      const stiCol = this._ctor.stiTypeColumn ?? 'type'
      const col = table[stiCol]
      if (col) clauses.unshift(eq(col, stiType) as SQL)
    }

    return clauses.length === 0 ? undefined : _combine(clauses)
  }

  /**
   * When querying the STI parent class, inspects the type discriminator column
   * on each row and returns the correct registered subclass constructor, or null
   * if no subclass matches (fall back to `this._ctor`).
   *
   * Only activates when querying the parent class (this._ctor.stiType is undefined).
   * STI subclass queries already have a type filter so they always return the right class.
   */
  protected _resolveSubclass(row: any): any {
    // Skip if already querying a subclass
    if (this._ctor.stiType !== undefined) return null

    const stiCol = this._ctor.stiTypeColumn ?? 'type'
    const typeVal = row[stiCol]
    if (typeVal === undefined || typeVal === null) return null

    for (const cls of Object.values(MODEL_REGISTRY)) {
      const c = cls as any
      if (c.stiType === typeVal && c._activeDrizzleTableName === this._tableName) {
        return cls
      }
    }
    return null
  }

  protected _clone(): Relation<TModel, TRelations> {
    const c = new (this.constructor as any)(this._ctor) as Relation<TModel, TRelations>
    c._where    = [...this._where]
    c._limit    = this._limit
    c._offset   = this._offset
    c._order    = [...this._order]
    c._includes = { ...this._includes }
    c._group    = [...this._group]
    c._having   = this._having
    c._distinct = this._distinct
    if (this._distinctOn) c._distinctOn = [...this._distinctOn]
    if ((this as any)._isNone) (c as any)._isNone = true
    if ((this as any)._ftsRank) (c as any)._ftsRank = (this as any)._ftsRank
    // Association create-defaults survive chaining (deal.comments.order(...).create(...))
    if ((this as any)._createDefaults) (c as any)._createDefaults = { ...(this as any)._createDefaults }
    return c
  }

  /**
   * Converts a hash condition into drizzle SQL expressions.
   *
   * Handles:
   *  - string/label values → Attr.set() transform  (e.g. 'sent' → 1)
   *  - array values        → inArray (with Attr.set per element)
   *  - null                → isNull
   *  - Relation value      → IN (sub-query via toSubquery())
   *  - raw values          → eq
   */
  protected _applyHashWhere(hash: Record<string, any>): void {
    const table = this.getTable()
    const Ctor = this._ctor

    for (const [key, rawVal] of Object.entries(hash)) {
      const colKey = _resolveColKey(Ctor, key)
      const col = table[colKey]
      if (!col) throw new Error(`Column "${key}" (mapped to "${colKey}") not found on table "${this._tableName}". Check spelling (use camelCase).`)

      if (rawVal === null || rawVal === undefined) {
        this._where.push(isNull(col) as SQL)
        continue
      }

      // Relation sub-query value
      if (rawVal instanceof Relation) {
        this._where.push(inArray(col, rawVal.toSubquery()) as SQL)
        continue
      }

      // Apply Attr.set() transform if available
      const attrConfig = Ctor[key]
      const transform = (v: any) => attrConfig?._isAttr && attrConfig.set ? attrConfig.set(v) : v

      if (Array.isArray(rawVal)) {
        this._where.push(inArray(col, rawVal.map(transform)) as SQL)
      } else if (_isOperatorObject(rawVal)) {
        // Range/comparison hash: { amount: { gte: '100', lte: '500' } } —
        // each bound runs through the SAME Attr codec as equality (money
        // strings → cents etc.), so filters and forms speak one dialect
        const OPS: Record<string, (c: any, v: any) => SQL> = { gte, lte, gt, lt, ne } as any
        for (const [op, bound] of Object.entries(rawVal)) {
          if (bound === undefined || bound === null || bound === '') continue
          if (op === 'nin') {
            // NOT IN — "everything except these"
            const vals = (Array.isArray(bound) ? bound : [bound]).map(transform)
            this._where.push(notInArray(col, vals) as SQL)
            continue
          }
          if (op === 'all') {
            // array-column contains ALL of these (tags: has every one)
            const vals = (Array.isArray(bound) ? bound : [bound]).map(transform)
            this._where.push(arrayContains(col, vals) as SQL)
            continue
          }
          const fn = OPS[op]
          if (!fn) throw new Error(`Unknown where operator "${op}" for "${key}" (supported: gte, lte, gt, lt, ne, nin, all)`)
          this._where.push(fn(col, transform(bound)))
        }
      } else {
        this._where.push(eq(col, transform(rawVal)) as SQL)
      }
    }
  }

  protected _buildQuery(): any {
    // none() short-circuit — always resolves to empty array, zero DB round-trips
    if ((this as any)._isNone) return Promise.resolve([])

    const db = getExecutor()
    const whereExpr = this._buildFinalWhere()

    // FOR UPDATE / DISTINCT / DISTINCT ON all require the core select builder
    // (the relational `findMany` API can't express them). Rows come back flat
    // and instantiate straight into model proxies.
    const forUpdate = (this as any)._forUpdate
    if (forUpdate || this._distinct || this._distinctOn) {
      const table = this.getTable()
      let q: any =
        this._distinctOn ? db.selectDistinctOn(this._distinctOn).from(table)
        : this._distinct  ? db.selectDistinct().from(table)
        :                   db.select().from(table)
      if (whereExpr) q = q.where(whereExpr)
      if (this._order.length > 0) q = q.orderBy(...this._order)
      if (this._limit) q = q.limit(this._limit)
      if (this._offset > 0) q = q.offset(this._offset)
      return forUpdate ? q.for('update') : q
    }

    const config: Record<string, any> = {}
    if (whereExpr) config.where = whereExpr
    if (this._limit) config.limit = this._limit
    if (this._offset > 0) config.offset = this._offset
    if (this._order.length > 0) config.orderBy = this._order
    if (Object.keys(this._includes).length > 0) config.with = this._includes

    return (db.query as any)[this._tableName].findMany(config)
  }
}

// ── Coalesced aggregates (for `.aggregate(a => …)`) ──────────────────────────

/** One aggregate expression + its scalar post-processor. */
export type AggTerm = { expr: SQL; to: (v: any) => any }

/** The builder handed to `.aggregate()` — same metrics as the standalone terminals. */
export type AggBuilder = {
  count(): AggTerm
  sum(field: string): AggTerm
  average(field: string): AggTerm
  minimum(field: string): AggTerm
  maximum(field: string): AggTerm
}

// ── Window functions (for `.select((t, Fn) => …)`) ───────────────────────────

/** OVER (PARTITION BY … ORDER BY …). Each field accepts a column or a drizzle expr (e.g. `desc(col)`). */
export type OverSpec = { partitionBy?: any | any[]; orderBy?: any | any[] }

function _buildOver(spec: OverSpec): SQL {
  const parts: SQL[] = []
  if (spec.partitionBy != null) {
    const cols = Array.isArray(spec.partitionBy) ? spec.partitionBy : [spec.partitionBy]
    parts.push(sql`partition by ${sql.join(cols, sql`, `)}`)
  }
  if (spec.orderBy != null) {
    const cols = Array.isArray(spec.orderBy) ? spec.orderBy : [spec.orderBy]
    parts.push(sql`order by ${sql.join(cols, sql`, `)}`)
  }
  return sql`over (${sql.join(parts, sql` `)})`
}

/** Wraps a bare aggregate/window expression so `.over(...)` turns it into a window function. */
function _win(expr: SQL): { over: (spec: OverSpec) => SQL } {
  return { over: (spec: OverSpec) => sql<number>`${expr} ${_buildOver(spec)}` }
}

/**
 * Window-function helpers passed to `.select((t, Fn) => …)`. Ranking, running
 * totals, moving windows, LAG/LEAD — all Postgres window functions, typed and
 * composable, without dropping to raw SQL.
 */
export const Fn = {
  rowNumber: ()                       => _win(sql`row_number()`),
  rank:      ()                       => _win(sql`rank()`),
  denseRank: ()                       => _win(sql`dense_rank()`),
  ntile:     (buckets: number)        => _win(sql`ntile(${buckets})`),
  count:     (col?: any)              => _win(col != null ? sql`count(${col})` : sql`count(*)`),
  sum:       (col: any)               => _win(sql`sum(${col})`),
  avg:       (col: any)               => _win(sql`avg(${col})`),
  min:       (col: any)               => _win(sql`min(${col})`),
  max:       (col: any)               => _win(sql`max(${col})`),
  lag:       (col: any, n = 1)        => _win(sql`lag(${col}, ${n})`),
  lead:      (col: any, n = 1)        => _win(sql`lead(${col}, ${n})`),
  firstValue:(col: any)               => _win(sql`first_value(${col})`),
  lastValue: (col: any)               => _win(sql`last_value(${col})`),
} as const

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalizes an include spec value into drizzle's nested relational `with`
 * shape. Accepts the ergonomic forms and lowers them:
 *   true                        → true
 *   ['reactions']               → { with: { reactions: true } }
 *   ['reactions', { user: 1 }]  → { with: { reactions: true, user: {…} } }
 *   { reactions: ['user'] }     → { with: { reactions: { with: { user: true } } } }
 * so `deal.includes({ notes: ['reactions'] })` eager-loads grandchildren.
 */
function _toDrizzleWith(spec: any): any {
  if (spec === true || spec == null) return true
  if (Array.isArray(spec)) {
    const w: Record<string, any> = {}
    for (const item of spec) {
      if (typeof item === 'string') w[item] = true
      else if (item && typeof item === 'object') for (const [k, v] of Object.entries(item)) w[k] = _toDrizzleWith(v)
    }
    return { with: w }
  }
  if (typeof spec === 'object') {
    // Already a drizzle config ({ with, where, … }) — pass through untouched
    if ('with' in spec || 'where' in spec || 'columns' in spec || 'orderBy' in spec) return spec
    const w: Record<string, any> = {}
    for (const [k, v] of Object.entries(spec)) w[k] = _toDrizzleWith(v)
    return { with: w }
  }
  return true
}

/** { gte/lte/gt/lt/ne } comparison hash — every key must be an operator. */
function _isOperatorObject(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return false
  const keys = Object.keys(v)
  return keys.length > 0 && keys.every(k => ['gte', 'lte', 'gt', 'lt', 'ne', 'nin', 'all'].includes(k))
}

function _isPlainObject(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    !Array.isArray(val) &&
    !(val instanceof Relation) &&
    (val.constructor === Object || val.constructor == null)
  )
}

function _combine(clauses: SQL[]): SQL {
  return clauses.length === 1 ? clauses[0]! : (and(...clauses) as SQL)
}

/**
 * Resolves the target model class for a given association marker + prop name.
 * Used by nested pluck to look up Attr configs on the target model.
 */
function _lookupAssocTarget(marker: any, prop: string): any {
  const reg = MODEL_REGISTRY as Record<string, any>

  // Explicit table name on the marker (e.g. habtm('products_tags'), hasMany('line_items'))
  if (marker.table) {
    return Object.values(reg).find((m: any) => m._activeDrizzleTableName === marker.table) ?? null
  }

  // Infer from property name: 'user' → 'users' → reg['users']
  const singular = prop.replace(/ies$/, 'y').replace(/s$/, '')
  const plural   = prop.endsWith('s') ? prop : singular + 's'

  return (
    reg[plural] ??
    Object.values(reg).find((m: any) => modelClassName(m) === prop[0]!.toUpperCase() + prop.slice(1)) ??
    Object.values(reg).find((m: any) => modelClassName(m) === singular[0]!.toUpperCase() + singular.slice(1)) ??
    null
  )
}

// ── Type Sorcery — deep includes generic mapping ─────────────────────────────

export type IncludeArg<TR> =
  | keyof TR
  | (keyof TR)[]
  | { [K in keyof TR]?: IncludeArg<any> }

export type MapInclude<TR, TArg> =
  TArg extends keyof TR
    ? { [K in TArg]: UnwrapAssociation<TR[K]> }
    : TArg extends (infer K)[]
      ? UnionToIntersection<K extends keyof TR ? { [P in K]: UnwrapAssociation<TR[P]> } : never>
      : TArg extends Record<string, any>
        ? { [K in keyof TArg & keyof TR]: MapNestedInclude<TR[K], TArg[K]> }
        : never

type UnwrapAssociation<T> =
  T extends Relation<infer R, any> ? R[] :
  T extends Promise<infer P> ? P :
  T

type MapNestedInclude<TAssoc, TSubInclude> =
  TAssoc extends Relation<infer R, infer A>
    ? (R & MapInclude<A, TSubInclude>)[]
    : TAssoc extends Promise<infer P>
      ? P extends null
        ? (Exclude<P, null> & MapInclude<GetAssocMeta<Exclude<P, null>>, TSubInclude>) | null
        : P & MapInclude<GetAssocMeta<P>, TSubInclude>
      : TAssoc

type GetAssocMeta<T> = T extends { _associations: infer A } ? A : any

type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never
