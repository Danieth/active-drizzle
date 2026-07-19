/**
 * HTTP error classes.
 * All throw-able from controller methods or @before hooks.
 * Error shapes:
 *   400/401/403/404 → { error: string }
 *   422             → { errors: Record<string, string[]> }  (TanStack Form compatible)
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class BadRequest extends HttpError {
  constructor(message: string) { super(400, message) }
}

export class Unauthorized extends HttpError {
  constructor(message = 'Not authenticated') { super(401, message) }
}

export class Forbidden extends HttpError {
  constructor(message: string) { super(403, message) }
}

export class NotFound extends HttpError {
  constructor(modelName: string) { super(404, `${modelName} not found`) }
}

export class ValidationError extends HttpError {
  constructor(public readonly errors: Record<string, string[]>) {
    super(422, 'Unprocessable Entity')
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
    super(409, 'The record was changed elsewhere')
  }
}


/** Convert a model's `.errors` map (or ValidationErrors) to a ValidationError. */
export function toValidationError(
  modelErrors: Record<string, string[]> | { all(): Record<string, string[]> },
): ValidationError {
  const fields =
    typeof (modelErrors as { all?: () => Record<string, string[]> }).all === 'function'
      ? (modelErrors as { all(): Record<string, string[]> }).all()
      : (modelErrors as Record<string, string[]>)
  return new ValidationError(fields)
}

/** Serialize an HttpError to its wire format. */
export function serializeError(err: HttpError): { status: number; body: unknown } {
  if (err instanceof ValidationError) {
    return { status: 422, body: { errors: err.errors } }
  }
  if (err instanceof Conflict) {
    return { status: 409, body: { error: err.message, envelope: err.envelope } }
  }
  return { status: err.status, body: { error: err.message } }
}
