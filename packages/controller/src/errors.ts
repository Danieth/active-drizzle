/**
 * HTTP error classes.
 * All throw-able from controller methods or @before hooks.
 * Error shapes:
 *   400/401/403/404 → { code: string, error: string }
 *   409             → { code: 'stale_record', error, envelope? }
 *   422             → { code: 'validation_failed',
 *                       errors:  Record<string, string[]>,        (TanStack Form compatible)
 *                       details: Record<string, ErrorDetail[]> }  (stable machine codes)
 *
 * `code` is the STABLE machine-readable identity of every error — clients
 * branch on it, never on message text. Field-level codes live in `details`
 * ('blank' | 'too_long' | 'taken' | …, mirroring core's errors bag); the
 * `errors` message map is unchanged so nothing existing breaks.
 */

/** One field-level failure with its stable code (mirror of core's ErrorDetail). */
export interface WireErrorDetail {
  code: string
  message: string
  meta?: Record<string, unknown>
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Stable machine-readable code — clients branch on this, not the text. */
    public readonly code: string = 'error',
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) { super(400, message, 'bad_request') }
}

export class Unauthorized extends HttpError {
  constructor(message = 'Not authenticated') { super(401, message, 'unauthorized') }
}

export class Forbidden extends HttpError {
  constructor(message: string) { super(403, message, 'forbidden') }
}

export class NotFound extends HttpError {
  constructor(modelName: string) { super(404, `${modelName} not found`, 'not_found') }
}

export class ValidationError extends HttpError {
  constructor(
    public readonly errors: Record<string, string[]>,
    /** Per-field coded details — same keys as `errors`, same order. */
    public readonly details?: Record<string, WireErrorDetail[]>,
  ) {
    super(422, 'Unprocessable Entity', 'validation_failed')
  }
}

/**
 * Optimistic-concurrency violation (409): the record changed since the
 * client last read it. Carries the CURRENT server envelope so the client
 * can offer "reload" (fold the server truth in) or "overwrite" (resubmit
 * against the fresh version) without another round-trip.
 */
export class Conflict extends HttpError {
  constructor(public readonly envelope?: unknown) {
    super(409, 'The record was changed elsewhere', 'stale_record')
  }
}


/** Convert a model's `.errors` map (or ValidationErrors) to a ValidationError. */
export function toValidationError(
  modelErrors:
    | Record<string, string[]>
    | { all(): Record<string, string[]>; details?: () => Record<string, WireErrorDetail[]> },
): ValidationError {
  const bag = modelErrors as { all?: () => Record<string, string[]>; details?: () => Record<string, WireErrorDetail[]> }
  if (typeof bag.all === 'function') {
    const details = typeof bag.details === 'function' ? bag.details() : undefined
    return new ValidationError(bag.all(), details)
  }
  return new ValidationError(modelErrors as Record<string, string[]>)
}

/** Serialize an HttpError to its wire format. */
export function serializeError(err: HttpError): { status: number; body: unknown } {
  if (err instanceof ValidationError) {
    return {
      status: 422,
      body: {
        code: err.code,
        errors: err.errors,
        ...(err.details ? { details: err.details } : {}),
      },
    }
  }
  if (err instanceof Conflict) {
    return { status: 409, body: { code: err.code, error: err.message, envelope: err.envelope } }
  }
  return { status: err.status, body: { code: err.code, error: err.message } }
}
