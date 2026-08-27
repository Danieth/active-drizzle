/**
 * THE optimistic-lock vocabulary — one module both the runtime (core save()
 * CAS, relation.updateAll, the controller's version-token seam) and the
 * codegen validator (versioned-models pass) share, so the column-resolution
 * rule and every teaching message exist in exactly one place.
 *
 * The contract (DESIGN-transport-proof.md A1/O2): a versioned model carries
 * ONE token kind — its integer locking column (`lockVersion` by convention,
 * or `static lockingColumn = '<name>'`; `= false` disables). The DB default
 * initializes it on INSERT; save()'s compare-and-swap bumps + WHERE-guards
 * it on UPDATE. Timestamps can never satisfy this: same-millisecond commits
 * and clock skew produce equal or regressing tokens, and core never CASes
 * them — every timestamp-token path is cosplay and fails loud.
 */

/** The paste-ready drizzle column a versioned model needs. */
export const LOCK_COLUMN_SNIPPET = "lockVersion: integer('lock_version').notNull().default(0)"

/** The paste-ready drizzle column for a (possibly non-conventional) lock column name. */
export function lockColumnSnippetFor(colName: string): string {
  return colName === 'lockVersion'
    ? LOCK_COLUMN_SNIPPET
    : `${colName}: integer('${colName.replace(/([A-Z])/g, '_$1').toLowerCase()}').notNull().default(0)`
}

/**
 * THE column-resolution rule, in its one place: `false` → locking off (null);
 * a string → that column name; anything else → the `lockVersion` convention.
 * Every consumer (core CAS, updateAll bump, controller lockField, the
 * versioned-models codegen pass, the wire strip) derives from this.
 */
export function resolveLockColumnName(declared: string | false | undefined): string | null {
  if (declared === false) return null
  return typeof declared === 'string' ? declared : 'lockVersion'
}

/**
 * The optimistic-locking column for a model, or null. Opt-in by convention: an
 * integer `lockVersion` column (Rails' lock_version) enables compare-and-swap
 * on save automatically. Override the name with `static lockingColumn = 'x'`,
 * or disable with `static lockingColumn = false`. Returns null when the column
 * isn't actually in the schema, so models without it are unaffected.
 */
export function lockingColumnFor(ctor: any, table: any): string | null {
  const colName = resolveLockColumnName(ctor?.lockingColumn)
  if (colName === null) return null
  return table && table[colName] ? colName : null
}

/** A teaching diagnostic in codegen shape — the runtime joins the two halves
 *  into one throw string; the versioned-models pass consumes them as-is, so
 *  build-time and request-time always teach the same fix. */
export interface LockDiagnostic {
  message: string
  suggestion: string
}

/**
 * Teaching error: `optimisticLock` names a column that is not the model's
 * RESOLVED locking column (its declared `static lockingColumn`, or
 * `lockVersion` by convention) — core's CAS would never bump it, so the
 * token would freeze and the lock be silently dead.
 */
export function undeclaredLockColumnDiag(modelName: string, field: string): LockDiagnostic {
  return {
    message: `update.optimisticLock names column '${field}', but core's compare-and-swap only ` +
      `bumps the model's RESOLVED locking column ('lockVersion' by convention, or its declared ` +
      `\`static lockingColumn\`) — '${field}' would never advance and stale writes would silently win.`,
    suggestion: `Declare \`static lockingColumn = '${field}'\` on ${modelName} so save() bumps and ` +
      `WHERE-guards it, or rename the column to the \`lockVersion\` convention. (Timestamp columns ` +
      `can never be lock tokens — migrate to \`${LOCK_COLUMN_SNIPPET}\` instead.)`,
  }
}

export function undeclaredLockColumnMessage(modelName: string, field: string): string {
  const d = undeclaredLockColumnDiag(modelName, field)
  return `[active-drizzle] ${d.message} ${d.suggestion}`
}

/**
 * Teaching error: the controller declares `optimisticLock` but the model
 * declares `static lockingColumn = false` — the two configs contradict.
 */
export function lockingDisabledDiag(modelName: string, tableRef?: string): LockDiagnostic {
  return {
    message: `update.optimisticLock is enabled, but ${modelName} declares ` +
      `\`static lockingColumn = false\` — locking is explicitly disabled on the model, so no ` +
      `token exists to check.`,
    suggestion: `Remove \`optimisticLock\` from the controller, or drop the ` +
      `\`lockingColumn = false\` override and add \`${LOCK_COLUMN_SNIPPET}\` to ` +
      `${tableRef ? `pgTable('${tableRef}')` : 'the table'}.`,
  }
}

export function lockingDisabledMessage(modelName: string): string {
  const d = lockingDisabledDiag(modelName)
  return `[active-drizzle] ${d.message} ${d.suggestion}`
}

/**
 * Teaching error: the model is opted into optimistic locking but its table
 * has no lock column at all — the CAS has nothing to bump, so every write
 * would silently be last-write-wins (O2a; also the controller's runtime
 * backstop for plugin-less apps).
 */
export function missingLockColumnDiag(modelName: string, colName: string, tableRef?: string): LockDiagnostic {
  return {
    message: `${modelName} is versioned (optimistic locking), but table ` +
      `${tableRef ? `'${tableRef}'` : 'the model\'s table'} has no '${colName}' column — core's ` +
      `compare-and-swap has nothing to bump, so every write would be last-write-wins.`,
    suggestion: `Paste \`${lockColumnSnippetFor(colName)}\` into ` +
      `${tableRef ? `pgTable('${tableRef}')` : 'the table'} — the DB default initializes inserts, ` +
      `and save()'s CAS bumps + WHERE-guards it on every update.`,
  }
}

export function missingLockColumnMessage(modelName: string, colName: string, tableRef?: string): string {
  const d = missingLockColumnDiag(modelName, colName, tableRef)
  return `[active-drizzle] ${d.message} ${d.suggestion}`
}

/**
 * Teaching error: the version token must come from an integer column the
 * driver returns as a JS number. A Date here is the killed updatedAt-cosplay;
 * a string is pg's bigint/numeric representation.
 */
export function nonNumericTokenMessage(modelName: string, field: string, raw: unknown): string {
  const got = raw instanceof Date ? 'a Date'
    : typeof raw === 'bigint' ? `a BigInt (${String(raw)})`
    : `a ${typeof raw} (${JSON.stringify(raw)})`
  return `[active-drizzle] optimistic locking on ${modelName}: the version token must come ` +
    `from the model's INTEGER locking column, but '${field}' holds ${got}. Timestamps are not ` +
    `strictly increasing per commit (same-millisecond commits, clock skew) and core's ` +
    `compare-and-swap never touches them — they cannot be lock tokens. Migrate: add ` +
    `\`${LOCK_COLUMN_SNIPPET}\` to the table and set \`update: { optimisticLock: true }\`.`
}
