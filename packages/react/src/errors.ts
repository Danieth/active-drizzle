/**
 * Structured representation of a controller error returned by an oRPC mutation or query.
 */
export interface ParsedControllerError {
  /** oRPC error code, e.g. 'UNPROCESSABLE_ENTITY', 'NOT_FOUND' */
  code: string
  /** Human-readable message */
  message: string
  /**
   * Field-level validation errors — only present for UNPROCESSABLE_ENTITY.
   * Maps field names to arrays of error messages, compatible with TanStack Form's
   * `form.setFieldMeta` / `setErrors` API.
   *
   * @example { name: ["can't be blank"], status: ["is invalid"] }
   */
  fields?: Record<string, string[]>
  isValidation: boolean
  isNotFound: boolean
  isUnauthorized: boolean
  isForbidden: boolean
  isBadRequest: boolean
}

/**
 * Parse an oRPC error (from TanStack Query's `mutation.error` or `query.error`)
 * into a structured object that's easy to consume in React components.
 *
 * Returns `null` when `error` is null, undefined, or not a recognized oRPC error.
 *
 * @example
 * const create = CampaignController.use({ teamId }).mutateCreate()
 * const err = parseControllerError(create.error)
 *
 * // Show a generic banner
 * if (err) toast.error(err.message)
 *
 * // Bind field errors to TanStack Form
 * if (err?.isValidation && err.fields) {
 *   for (const [field, messages] of Object.entries(err.fields)) {
 *     form.setFieldMeta(field as any, meta => ({ ...meta, errors: messages }))
 *   }
 * }
 *
 * // Handle 404 specifically
 * if (err?.isNotFound) router.replace('/404')
 */
export function parseControllerError(error: unknown): ParsedControllerError | null {
  if (error == null) return null

  const e = error as Record<string, any>

  // oRPC errors have a `code` string property
  if (typeof e['code'] !== 'string') return null

  const code: string    = e['code']
  const message: string = typeof e['message'] === 'string' ? e['message'] : 'Unknown error'

  // Validation errors carry `data.errors` (field → messages[])
  const rawData = e['data'] as Record<string, any> | undefined
  const fields: Record<string, string[]> | undefined = rawData?.['errors'] ?? undefined

  return {
    code,
    message,
    ...(fields !== undefined ? { fields } : {}),
    isValidation:  code === 'UNPROCESSABLE_ENTITY',
    isNotFound:    code === 'NOT_FOUND',
    isUnauthorized: code === 'UNAUTHORIZED',
    isForbidden:   code === 'FORBIDDEN',
    isBadRequest:  code === 'BAD_REQUEST',
  }
}

/**
 * Apply field-level errors from a ParsedControllerError to a TanStack Form instance.
 * Call this in a mutation's `onError` callback.
 *
 * @example
 * const create = CampaignController.use({ teamId }).mutateCreate({
 *   onError: (e) => applyFormErrors(form, parseControllerError(e)),
 * })
 */
export function applyFormErrors(
  form: { setFieldMeta: (field: string, updater: (meta: any) => any) => void },
  parsed: ParsedControllerError | null,
): void {
  if (!parsed?.fields) return
  for (const [field, messages] of Object.entries(parsed.fields)) {
    form.setFieldMeta(field, (meta: any) => ({ ...meta, errors: messages }))
  }
}
