import { AsyncLocalStorage } from 'node:async_hooks'
import { Table, getTableColumns, is } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'

type GlobalDb = PgDatabase<any, any, any>

/**
 * Tracks the current transaction client across async context.
 * When inside ApplicationRecord.transaction(), getExecutor() returns the tx client.
 */
export const transactionContext = new AsyncLocalStorage<GlobalDb>()

/**
 * Holds the pending afterCommit queue when inside a transaction.
 * save() pushes callbacks here; transaction() flushes them after commit.
 */
export const afterCommitQueue = new AsyncLocalStorage<Array<() => Promise<void>>>()

let _activeDb: GlobalDb | null = null
let _schema: Record<string, any> = {}

// ── Multi-database binding ───────────────────────────────────────────────────
// DOCTRINE: we DEFER to drizzle for connections (no shim — drizzle already
// owns drivers/pooling). What the framework owns is BINDING: which tables
// live on which drizzle instance. boot() binds the default; bindDatabase()
// binds more. Table-level routing keeps @model('events') unchanged — the
// database is a property of the binding, not the model declaration.
const _databases = new Map<string, GlobalDb>()
const _tableDb = new Map<string, string>()

/** Which database the CURRENT transaction belongs to — a tx on 'default'
 *  must never capture queries against 'analytics' (they are different
 *  connections; pretending otherwise would silently break atomicity). */
export const transactionDbName = new AsyncLocalStorage<string>()

/**
 * Bind additional tables to ANOTHER drizzle instance:
 *
 *   boot(db, { posts: schema.posts })                                  // default
 *   bindDatabase('analytics', analyticsDb, { events: aSchema.events }) // extra
 *
 * Models declare tables as always — routing happens here. LIMITS (by
 * design): associations/includes across databases are not supported
 * (different connections cannot join); load separately.
 */
export function bindDatabase(name: string, db: GlobalDb, schema: Record<string, any>): void {
  if (name === 'default') throw new Error(`active-drizzle: 'default' is bound by boot()`)
  assertNoReservedColumnNames(schema)
  _databases.set(name, db)
  for (const tableName of Object.keys(schema)) {
    _schema[tableName] = schema[tableName]
    _tableDb.set(tableName, name)
  }
}

export const MODEL_REGISTRY: Record<string, any> = {}

/**
 * Column-name suffixes the record Proxy claims for synthesized dirty-tracking
 * helpers (`titleChanged()`, `titleWas()`, `titleChange()`). A real column
 * with one of these names would be SHADOWED — reads would return the helper
 * function instead of the value — so boot() refuses the schema outright.
 */
const RESERVED_COLUMN_SUFFIXES = ['Changed', 'Was', 'Change'] as const

function assertNoReservedColumnNames(schema: Record<string, any>): void {
  const violations: string[] = []
  for (const [tableName, table] of Object.entries(schema)) {
    if (!is(table, Table)) continue
    for (const columnKey of Object.keys(getTableColumns(table))) {
      const suffix = RESERVED_COLUMN_SUFFIXES.find(
        (s) => columnKey.length > s.length && columnKey.endsWith(s)
      )
      if (suffix) violations.push(`'${columnKey}' on '${tableName}' (reserved suffix '${suffix}')`)
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `active-drizzle: column names ending in ${RESERVED_COLUMN_SUFFIXES.map(s => `'${s}'`).join('/')} ` +
      `collide with synthesized dirty-tracking helpers and would be unreadable: ` +
      `${violations.join(', ')}. Rename the column(s).`
    )
  }
}

export function boot(db: GlobalDb, schema: Record<string, any>) {
  assertNoReservedColumnNames(schema)
  _activeDb = db
  _schema = schema
  // Wire MODEL_REGISTRY into attachment lookups to avoid circular imports
  import('./attachments.js').then(({ _wireAttachmentRegistry }) => {
    _wireAttachmentRegistry(MODEL_REGISTRY)
  }).catch(() => { /* attachments module may not be loaded */ })
}

export function getExecutor(table?: string): GlobalDb {
  const dbName = table ? (_tableDb.get(table) ?? 'default') : 'default'
  // An active transaction only captures queries AGAINST ITS OWN database
  const tx = transactionContext.getStore()
  if (tx && (transactionDbName.getStore() ?? 'default') === dbName) return tx as GlobalDb
  const db = dbName === 'default' ? _activeDb : _databases.get(dbName)
  if (!db) {
    throw new Error(dbName === 'default'
      ? 'active-drizzle: call boot(db, schema) before querying.'
      : `active-drizzle: database '${dbName}' is not bound — call bindDatabase('${dbName}', db, schema).`)
  }
  return db as GlobalDb
}

export function getSchema(): Record<string, any> {
  return _schema
}

/**
 * Raised by Model.find(id) when no record with the given primary key exists.
 * Matches Rails' ActiveRecord::RecordNotFound semantics.
 *
 * @example
 * try {
 *   const user = await User.find(999)
 * } catch (e) {
 *   if (e instanceof RecordNotFound) console.log(e.message) // "User with id=999 not found"
 * }
 */
export class RecordNotFound extends Error {
  public readonly model: string
  public readonly id: unknown

  constructor(model: string, id: unknown) {
    super(`${model} with id=${JSON.stringify(id)} not found`)
    this.name  = 'RecordNotFound'
    this.model = model
    this.id    = id
  }
}

/**
 * Throw inside a @beforeSave / @afterSave hook to abort the operation and
 * automatically roll back the surrounding transaction (if any).
 */
export class AbortChain extends Error {
  constructor(message = 'Transaction aborted') {
    super(message)
    this.name = 'AbortChain'
  }
}

/**
 * Wraps `callback` in a Drizzle transaction. Any save(), destroy(), or query
 * inside `callback` automatically routes through the transaction client via
 * AsyncLocalStorage — no need to pass `tx` around.
 *
 * Rolls back automatically if:
 *  - The callback throws
 *  - An AbortChain error is thrown from any hook
 *
 * @example
 * await ApplicationRecord.transaction(async () => {
 *   const asset = await Asset.create({ ... })
 *   await business.update({ assetCount: business.assetCount + 1 })
 * })
 */
/**
 * Tracks how deeply nested the current async context is inside transactions.
 * When > 0, a new `transaction()` call re-uses the existing connection rather
 * than opening a savepoint — Drizzle handles the nesting at the driver level.
 * A dev-mode warning is emitted so accidental nesting is surfaced early.
 */
const txDepth = new AsyncLocalStorage<number>()

export async function transaction<T>(
  callback: () => Promise<T>,
  opts: { database?: string } = {},
): Promise<T> {
  const dbName = opts.database ?? 'default'
  const bound = dbName === 'default' ? _activeDb : _databases.get(dbName)
  if (!bound) throw new Error(`active-drizzle: database '${dbName}' is not bound — boot()/bindDatabase() first.`)
  const db = bound as any
  if (typeof db.transaction !== 'function') {
    throw new Error('active-drizzle: DB driver does not support transactions.')
  }

  const depth = txDepth.getStore() ?? 0
  if (depth > 0 && process.env['NODE_ENV'] !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      `[active-drizzle] Nested transaction detected (depth=${depth}). ` +
      'Drizzle will use a savepoint. Ensure this is intentional.',
    )
  }

  const queue: Array<() => Promise<void>> = []
  const result = await db.transaction((tx: any) =>
    txDepth.run(depth + 1, () =>
      afterCommitQueue.run(queue, () =>
        transactionDbName.run(dbName, () => transactionContext.run(tx as GlobalDb, callback)))
    )
  )
  // Fire afterCommit hooks only at the outermost transaction boundary
  if (depth === 0) {
    for (const fn of queue) await fn()
  }
  return result
}
