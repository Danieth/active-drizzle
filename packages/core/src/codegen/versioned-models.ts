/**
 * The versioned-models pass — the cross-IR half of the optimistic-lock
 * contract (DESIGN-transport-proof.md axiom A1, obligations O2 + O14).
 *
 * A model is LOCK-TOKENED when any of these opt it in:
 *   • a controller declares `update.optimisticLock` over it,
 *   • the model declares `static lockingColumn = '<name>'`,
 *   • the schema table carries a `lockVersion` column (the convention core's
 *     save() CAS engages on automatically).
 *
 * The drizzle schema is USER-AUTHORED and read-only to codegen — enforcement
 * is therefore REFUSE-with-teaching-error, never auto-declare:
 *   O2a  the resolved lock column must exist in the table;
 *   O2b  it must be `integer(...).notNull().default(0)` (the DB default IS
 *        the insert initializer — one place, no runtime insert change);
 *   O2c  timestamp/date tokens are refused outright — same-millisecond
 *        commits and clock skew make them non-monotonic, and core's CAS
 *        never touches them (the build-time updatedAt-cosplay kill);
 *   O2d  `optimisticLock: '<col>'` must name the model's RESOLVED locking
 *        column (build-time twin of the controller's request-time guard);
 *   O14  a lock-tokened model whose pk is REUSABLE (natural key, plain
 *        integer, defaultless uuid, or undetectable) must declare
 *        @include(SoftDeletable) — otherwise destroy→recreate restarts the
 *        token chain on the same pk and stale clients silently certify.
 *        Serial/identity pks and uuid pks WITH a default are never reused,
 *        so their lineage is automatic (a defaultless uuid is client-supplied
 *        — a natural key in uuid clothing — and IS reusable). NOTE the
 *        runtime escape hatches outside this rule's sight: `hardDestroy()`
 *        and `Relation.deleteAll()` physically DELETE even on a SoftDeletable
 *        model, so a pk destroyed through them CAN be re-created with a
 *        restarted chain — codegen cannot see those calls; they are named in
 *        the WS0 contract exclusion alongside explicit-pk inserts and
 *        sequence resets.
 *
 * Runs next to controller extraction in the vite plugin because it needs
 * controller config × model statics × schema pk kind simultaneously — no
 * single-model validate() sees all three.
 */
import type { CtrlProjectMeta } from './controller-types.js'
import type { ProjectMeta, ModelMeta, TableMeta, ColumnMeta, Diagnostic } from './types.js'
import {
  LOCK_COLUMN_SNIPPET,
  lockColumnSnippetFor,
  resolveLockColumnName,
  lockingDisabledDiag,
  undeclaredLockColumnDiag,
  missingLockColumnDiag,
} from '../runtime/optimistic-lock.js'

const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz', 'date', 'time'])
/** Column types the pg driver returns as JS numbers — the only CAS-able kinds. */
const INTEGER_LOCK_TYPES = new Set(['integer', 'smallint'])
/** Pk kinds the database never re-issues — lineage is automatic. (uuid is
 *  never-reused only WITH a default — see the O14 header note.) */
const NEVER_REUSED_PK_TYPES = new Set(['serial', 'smallserial', 'bigserial'])

function err(modelFile: string, message: string, suggestion?: string): Diagnostic {
  const d: Diagnostic = { severity: 'error', modelFile, message }
  if (suggestion !== undefined) d.suggestion = suggestion
  return d
}

export function validateVersionedModels(
  ctrlProject: CtrlProjectMeta,
  project: ProjectMeta,
): Diagnostic[] {
  const out: Diagnostic[] = []

  for (const model of project.models) {
    const table = project.schema.tables[model.tableName]
    if (!table) continue // missing table is another validator's diagnostic

    // Every controller opt-in over this model (a model may sit behind several doors)
    const ctrlLocks: Array<boolean | string> = []
    for (const ctrl of ctrlProject.controllers) {
      if (ctrl.modelClass !== model.className) continue
      const lock = ctrl.crudConfig?.update?.optimisticLock
      if (lock !== undefined && lock !== false) ctrlLocks.push(lock)
    }

    // ── Contradiction: controller wants a token, model disabled locking ──────
    if (ctrlLocks.length > 0 && model.lockingColumn === false) {
      const d = lockingDisabledDiag(model.className, table.dbName)
      out.push(err(model.filePath, d.message, d.suggestion))
      continue
    }
    if (model.lockingColumn === false) continue // locking off, nothing to enforce

    // THE resolution rule, from its one shared place (lockingColumn !== false here).
    const resolvedCol = resolveLockColumnName(model.lockingColumn)!
    const declaredCol = typeof model.lockingColumn === 'string' ? model.lockingColumn : null
    const findCol = (name: string): ColumnMeta | undefined =>
      table.columns.find(c => c.name === name)

    // ── O2c/O2d: string opt-ins must name the model's RESOLVED locking column ─
    // (comparing against the RESOLVED column also refuses `optimisticLock:
    // 'lockVersion'` over a model that declared `lockingColumn = 'rev'` — the
    // envelope would serve a token the CAS never bumps.)
    let stringOptInErrored = false
    for (const lock of ctrlLocks) {
      if (typeof lock !== 'string') continue
      const named = findCol(lock)
      if (named && TIMESTAMP_TYPES.has(named.type)) {
        stringOptInErrored = true
        out.push(err(
          model.filePath,
          `update.optimisticLock: '${lock}' names a ${named.type} column on '${table.dbName}' — ` +
          `timestamps cannot be lock tokens: same-millisecond commits and clock skew produce equal ` +
          `or regressing values, and core's compare-and-swap never touches them. The lock would only ` +
          `ever cosplay a version check.`,
          `Migrate to an integer lock column: add \`${LOCK_COLUMN_SNIPPET}\` to ` +
          `pgTable('${table.dbName}') and set \`update: { optimisticLock: true }\`.`,
        ))
        continue
      }
      if (lock !== resolvedCol) {
        stringOptInErrored = true
        const d = undeclaredLockColumnDiag(model.className, lock)
        out.push(err(model.filePath, d.message, d.suggestion))
      }
    }

    // Is this model lock-tokened at all? (WS0 scope: the rules below only
    // fire on versioned models.)
    const lockTokened = ctrlLocks.length > 0 || declaredCol !== null || findCol('lockVersion') !== undefined
    if (!lockTokened) continue

    // ── O2a/O2b/O2c: the resolved lock column must be integer().notNull().default(0) ─
    // Skipped when a string opt-in already errored above: the cosplay /
    // undeclared-column diagnostic carries the full migration, and a second
    // error about a column the user never mentioned reads as a non sequitur.
    if (!stringOptInErrored) {
      const lockCol = findCol(resolvedCol)
      if (!lockCol) {
        const d = missingLockColumnDiag(model.className, resolvedCol, table.dbName)
        out.push(err(model.filePath, d.message, d.suggestion))
      } else if (TIMESTAMP_TYPES.has(lockCol.type)) {
        out.push(err(
          model.filePath,
          `${model.className}'s locking column '${resolvedCol}' is a ${lockCol.type} — timestamps ` +
          `cannot be lock tokens: same-millisecond commits and clock skew produce equal or regressing ` +
          `values, and core's compare-and-swap needs a JS integer to bump.`,
          `Migrate to an integer lock column: add \`${LOCK_COLUMN_SNIPPET}\` to ` +
          `pgTable('${table.dbName}') (backfill 0) and drop the timestamp override.`,
        ))
      } else {
        const problems: string[] = []
        if (!INTEGER_LOCK_TYPES.has(lockCol.type)) {
          problems.push(`its type is '${lockCol.type}' — use \`integer(...)\` (pg returns bigint/numeric as strings, which the CAS cannot bump)`)
        }
        if (lockCol.nullable) {
          problems.push('it is nullable — add `.notNull()` (a NULL token silently disables the stale-write check)')
        }
        if (!lockCol.hasDefault) {
          problems.push('it has no default — add `.default(0)` (the DB default is the insert-time initializer; without it new rows start un-versioned)')
        }
        if (problems.length > 0) {
          out.push(err(
            model.filePath,
            `${model.className}'s locking column '${resolvedCol}' on '${table.dbName}' is mis-shaped: ` +
            problems.join('; ') + '.',
            `The full shape is \`${lockColumnSnippetFor(resolvedCol)}\`.`,
          ))
        }
      }
    }

    // ── O14: the pk lineage rule ─────────────────────────────────────────────
    out.push(...validatePkLineage(model, table))
  }

  return out
}

/**
 * O14: a lock-tokened model needs a per-pk lineage the token chain can ride.
 * Serial/identity pks and uuid pks WITH a default are never re-issued —
 * lineage is automatic. A REUSABLE pk (natural key, plain integer,
 * defaultless/client-supplied uuid, or none the extractor can see) needs
 * @include(SoftDeletable): the concern's destroy is `update({<column>})`,
 * which rides save()'s CAS, so destroy AND un-delete bump the token on the
 * SAME pk — one strictly increasing chain across recreation. The declared
 * soft-delete column itself must exist and be a timestamp, or the lineage
 * certificate is a concern whose destroy cannot write.
 */
function validatePkLineage(model: ModelMeta, table: TableMeta): Diagnostic[] {
  if (model.softDelete) {
    // The certificate is only as good as the column the concern writes.
    const sdCol = model.softDeleteColumn ?? 'deletedAt'
    const col = table.columns.find(c => c.name === sdCol)
    if (!col) {
      return [err(
        model.filePath,
        `${model.className} relies on @include(SoftDeletable) for its pk lineage, but table ` +
        `'${table.dbName}' has no '${sdCol}' column — the concern's destroy would write a ` +
        `nonexistent field, so nothing is ever soft-deleted and the lineage certificate is void.`,
        `Add \`${sdCol}: timestamp('${sdCol.replace(/([A-Z])/g, '_$1').toLowerCase()}')\` to ` +
        `pgTable('${table.dbName}') (nullable — NULL means live).`,
      )]
    }
    if (!TIMESTAMP_TYPES.has(col.type)) {
      return [err(
        model.filePath,
        `${model.className}'s soft-delete column '${sdCol}' on '${table.dbName}' is a ` +
        `'${col.type}' — SoftDeletable's destroy writes \`new Date()\` into it, which a ` +
        `non-timestamp column cannot hold.`,
        `Change it to \`${sdCol}: timestamp('${sdCol.replace(/([A-Z])/g, '_$1').toLowerCase()}')\` ` +
        `(nullable — NULL means live).`,
      )]
    }
    return []
  }

  const pk = table.columns.find(c => c.primaryKey)
  const neverReused = pk !== undefined && (
    NEVER_REUSED_PK_TYPES.has(pk.type)
    || pk.isGenerated
    // uuid is never-reused only when the DB/runtime issues it (defaultRandom /
    // $defaultFn). A defaultless uuid pk is necessarily client-supplied — a
    // natural key in uuid clothing: destroy→recreate on the same client-chosen
    // uuid restarts the chain, the exact case this rule refuses.
    || (pk.type === 'uuid' && pk.hasDefault)
  )
  if (neverReused) return []

  const pkDesc = pk
    ? `its primary key ('${pk.name}' ${pk.type}${pk.type === 'uuid' ? ', no default — client-supplied' : ''}) is REUSABLE — a destroyed key can be re-created`
    : `it has no primary-key column the extractor can see (a composite pgTable(...) third-argument ` +
      `primaryKey(...) is invisible to codegen, so reuse cannot be ruled out)`

  return [err(
    model.filePath,
    `${model.className} is versioned (optimistic locking), but ${pkDesc}. Re-creating a destroyed ` +
    `pk would restart the version chain, and clients holding tokens from the old incarnation would ` +
    `silently pass the stale-write check against the new one.`,
    `Either switch the pk to a never-reused kind (serial / generated identity / uuid.defaultRandom), ` +
    `or add \`@include(SoftDeletable)\` to ${model.className} (with a 'deleted_at' column) — its ` +
    `destroy is an UPDATE through save()'s compare-and-swap, so destroy and un-delete keep one ` +
    `strictly increasing token chain on the same pk.`,
  )]
}
