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

/** Convert a model's `.errors` map to a ValidationError. */
export function toValidationError(modelErrors: Record<string, string[]>): ValidationError {
  return new ValidationError(modelErrors)
}

/** Serialize an HttpError to its wire format. */
export function serializeError(err: HttpError): { status: number; body: unknown } {
  if (err instanceof ValidationError) {
    return { status: 422, body: { errors: err.errors } }
  }
  return { status: err.status, body: { error: err.message } }
}
