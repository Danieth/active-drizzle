/**
 * Pluggable error reporting + database error translation.
 *
 * Two jobs, deliberately separate:
 *
 * 1. `onError()` — a plug-in point for whatever error tracker the app uses.
 *    ActiveDrizzle never knows about Rollbar/Sentry/Datadog; it just calls
 *    every registered handler with the RAW error and a context bag:
 *
 *      import { onError } from 'active-drizzle'
 *      onError((error, context) => Rollbar.error(error, context))
 *
 * 2. `translateDbError()` — turns Postgres SQLSTATE failures (23502
 *    not_null_violation, 23505 unique_violation, …) into what the USER
 *    should see: a field + message when the error names a column, or a
 *    generic "something went wrong" otherwise.
 *
 * save()/destroy() and the controller adapter use both: raw error to the
 * handlers, translated message to the user.
 */

export type ErrorContext = Record<string, unknown>
export type ErrorHandler = (error: unknown, context: ErrorContext) => void

const _handlers = new Set<ErrorHandler>()

/**
 * Registers an error handler. Returns an unsubscribe function.
 * With no handlers registered, reportError falls back to console.error —
 * errors are never silently dropped.
 */
export function onError(handler: ErrorHandler): () => void {
  _handlers.add(handler)
  return () => _handlers.delete(handler)
}

/** Removes every registered handler (test isolation). */
export function clearErrorHandlers(): void {
  _handlers.clear()
}

/**
 * Fans an error out to every registered handler. Never throws — a broken
 * error tracker must not take down the request that was already failing.
 */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  if (_handlers.size === 0) {
    console.error('[active-drizzle] unhandled error:', error, context)
    return
  }
  for (const handler of _handlers) {
    try {
      handler(error, context)
    } catch (handlerErr) {
      console.error('[active-drizzle] error handler threw:', handlerErr)
    }
  }
}

// ── Database error translation ─────────────────────────────────────────────

export interface TranslatedDbError {
  /** SQLSTATE code, e.g. '23505'. */
  code: string
  /** Coarse category — lets callers pick a response status. */
  kind: 'constraint' | 'bad_value' | 'retryable' | 'unavailable' | 'unknown'
  /** Column the error names, when the driver tells us. */
  field?: string
  /** Field-level message (validation-style, no field name in it). */
  message: string
  /** Standalone user-facing sentence for when there is no field. */
  friendly: string
}

/** The all-purpose user-facing failure sentence. */
export const GENERIC_DB_MESSAGE = 'Something went wrong. Please try again.'

const SQLSTATE_RE = /^[0-9A-Z]{5}$/

/** `Key (email)=(a@b.co) already exists.` → 'email' */
function fieldFromDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string') return undefined
  const m = /^Key \(([^),]+)\)/.exec(detail)
  return m?.[1]
}

/**
 * Recognizes a Postgres/driver error and translates it for end users.
 * Returns null for anything that is not a database error (programming
 * errors must propagate, not turn into polite banners).
 */
export function translateDbError(err: unknown): TranslatedDbError | null {
  const e = err as { code?: unknown; column?: unknown; detail?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : null
  if (!code || !SQLSTATE_RE.test(code)) return null

  const field =
    (typeof e?.column === 'string' && e.column !== '' ? e.column : undefined) ??
    fieldFromDetail(e?.detail)

  const t = (kind: TranslatedDbError['kind'], message: string, friendly?: string): TranslatedDbError => ({
    code,
    kind,
    ...(field !== undefined ? { field } : {}),
    message,
    friendly: friendly ?? (field ? `${field} ${message}` : GENERIC_DB_MESSAGE),
  })

  switch (code) {
    case '23502': return t('constraint', "can't be blank")
    case '23505': return t('constraint', 'has already been taken')
    case '23503': return t('constraint', 'refers to something that no longer exists')
    case '23514': return t('constraint', 'is invalid')
    case '22001': return t('bad_value', 'is too long')
    case '22003': return t('bad_value', 'is out of range')
    case '22007': // invalid datetime format
    case '22P02': return t('bad_value', 'is invalid')
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return t('retryable', 'conflicted with another change', 'The operation conflicted with another change. Please try again.')
  }

  // Connection / server-availability classes → "try again shortly"
  if (code.startsWith('08') || code.startsWith('53') || code === '57P01' || code === '57P02' || code === '57P03') {
    return t('unavailable', 'is temporarily unavailable', 'The service is temporarily unavailable. Please try again shortly.')
  }

  // Any other integrity violation (class 23) or data error (class 22)
  if (code.startsWith('23')) return t('constraint', 'is invalid')
  if (code.startsWith('22')) return t('bad_value', 'is invalid')

  // It has a SQLSTATE, so it came from the database — but we don't know it.
  return t('unknown', 'could not be saved')
}
