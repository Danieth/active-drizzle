import { AsyncLocalStorage } from 'node:async_hooks'
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

export const MODEL_REGISTRY: Record<string, any> = {}

export function boot(db: GlobalDb, schema: Record<string, any>) {
  _activeDb = db
  _schema = schema
  // Wire MODEL_REGISTRY into attachment lookups to avoid circular imports
  import('./attachments.js').then(({ _wireAttachmentRegistry }) => {
    _wireAttachmentRegistry(MODEL_REGISTRY)
  }).catch(() => { /* attachments module may not be loaded */ })
}

export function getExecutor(): GlobalDb {
  if (!_activeDb) throw new Error('active-drizzle: call boot(db, schema) before querying.')
  return (transactionContext.getStore() ?? _activeDb) as GlobalDb
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

export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
  if (!_activeDb) throw new Error('active-drizzle: call boot(db, schema) before using transaction().')
  const db = _activeDb as any
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
      afterCommitQueue.run(queue, () => transactionContext.run(tx as GlobalDb, callback))
    )
  )
  // Fire afterCommit hooks only at the outermost transaction boundary
  if (depth === 0) {
    for (const fn of queue) await fn()
  }
  return result
}
