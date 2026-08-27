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
 * The name of the database a table is bound to ('default' unless bindDatabase
 * routed it elsewhere). save()/destroy() use it so their atomic transaction
 * wrap opens on the MODEL's own connection — a wrap on 'default' would never
 * capture writes routed to another bound database.
 */
export function databaseForTable(table: string): string {
  return _tableDb.get(table) ?? 'default'
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
 * Raised by save() when an optimistic-lock conflict is detected: the row's
 * locking column no longer holds the value this record was loaded with, so a
 * concurrent writer already advanced it. The compare-and-swap UPDATE matched
 * zero rows — this record's write would silently clobber theirs. Mirrors
 * Rails' ActiveRecord::StaleObjectError.
 */
export class StaleObjectError extends Error {
  public readonly model: string
  public readonly id: unknown
  constructor(model: string, id: unknown) {
    super(`${model} (id=${JSON.stringify(id)}) was updated concurrently — reload before retrying`)
    this.name  = 'StaleObjectError'
    this.model = model
    this.id    = id
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
export async function transaction<T>(
  callback: () => Promise<T>,
  opts: { database?: string } = {},
): Promise<T> {
  const dbName = opts.database ?? 'default'
  // A nested call for the SAME database must run on the CURRENT tx client —
  // tx.transaction() opens a real SAVEPOINT on the connection that owns the
  // outer transaction. Resolving the ROOT instance here instead would check
  // out a NEW pool connection and run an INDEPENDENT top-level transaction:
  // the outer rollback would not undo it, and it can deadlock (invisibly to
  // Postgres) against the outer's own row locks. A nested call for a
  // DIFFERENT database is genuinely independent — different connection — and
  // runs as its own outermost transaction.
  const enclosingTx = transactionContext.getStore()
  const sameDbNested = enclosingTx !== undefined
    && (transactionDbName.getStore() ?? 'default') === dbName
  const bound = sameDbNested
    ? enclosingTx
    : (dbName === 'default' ? _activeDb : _databases.get(dbName))
  if (!bound) throw new Error(`active-drizzle: database '${dbName}' is not bound — boot()/bindDatabase() first.`)
  const db = bound as any
  if (typeof db.transaction !== 'function') {
    throw new Error('active-drizzle: DB driver does not support transactions.')
  }

  if (sameDbNested && process.env['NODE_ENV'] !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      '[active-drizzle] Nested transaction detected — running it as a savepoint ' +
      `on the enclosing '${dbName}' transaction. Ensure this is intentional.`,
    )
  }

  // The enclosing transaction's afterCommit queue. Only a same-db SAVEPOINT
  // hands its callbacks up — its fate is the outer commit's. A nested
  // different-db transaction commits on its own, so its queue flushes below.
  const parentQueue = sameDbNested ? afterCommitQueue.getStore() : undefined

  const queue: Array<() => Promise<void>> = []
  const result = await db.transaction((tx: any) =>
    afterCommitQueue.run(queue, () =>
      transactionDbName.run(dbName, () => transactionContext.run(tx as GlobalDb, callback)))
  )
  if (parentQueue) {
    // Savepoint released. Its afterCommit callbacks must NOT fire yet and must
    // NOT be dropped — hand them up to the enclosing transaction so they run
    // once, after the OUTERMOST commit (and never if it rolls back).
    for (const fn of queue) parentQueue.push(fn)
  } else {
    // Outermost boundary FOR THIS DATABASE — a real commit happened. Fire
    // everything queued, including callbacks handed up from savepoints.
    for (const fn of queue) await fn()
  }
  return result
}
