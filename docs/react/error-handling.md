# Error Handling (Frontend)

`@active-drizzle/react` exports `parseControllerError` and `applyFormErrors` to turn oRPC errors into structured objects your UI can respond to intelligently.

## `parseControllerError(error)`

Parses a TanStack Query `mutation.error` or `query.error` into a `ParsedControllerError`:

```ts
import { parseControllerError } from '@active-drizzle/react'

const create = CampaignController.use({ teamId }).mutateCreate()
const err    = parseControllerError(create.error)

// err is null when there's no error
// err is ParsedControllerError when the mutation has failed
```

### `ParsedControllerError` shape

```ts
interface ParsedControllerError {
  code: string              // 'UNPROCESSABLE_ENTITY', 'NOT_FOUND', etc.
  message: string           // human-readable message
  fields?: Record<string, string[]>  // validation errors by field name
  isValidation:  boolean    // code === 'UNPROCESSABLE_ENTITY'
  isNotFound:    boolean    // code === 'NOT_FOUND'
  isUnauthorized: boolean   // code === 'UNAUTHORIZED'
  isForbidden:   boolean    // code === 'FORBIDDEN'
  isBadRequest:  boolean    // code === 'BAD_REQUEST'
}
```

Returns `null` if the error is `null`, `undefined`, or not a recognized oRPC error.

## Patterns

### Error Banner

```tsx
const err = parseControllerError(create.error)
{err && <div className="error-banner">{err.message}</div>}
```

### Type-Specific Handling

```tsx
const err = parseControllerError(query.error)

if (err?.isNotFound)     return <NotFoundPage />
if (err?.isUnauthorized) return <Navigate to="/login" />
if (err?.isForbidden)    return <p>You don't have access.</p>
if (err?.isBadRequest)   return <p>Invalid request: {err.message}</p>
```

### Validation Errors Inline

```tsx
const err = parseControllerError(create.error)
if (err?.isValidation && err.fields) {
  // err.fields = { name: ["can't be blank"], budget: ["must be >= 0"] }
  Object.entries(err.fields).forEach(([field, messages]) => {
    console.log(`${field}: ${messages.join(', ')}`)
  })
}
```

## `applyFormErrors(form, parsed)`

Binds `parsed.fields` to a TanStack Form instance in one call:

```tsx
import { applyFormErrors } from '@active-drizzle/react'

const err = parseControllerError(create.error)
if (err?.isValidation) applyFormErrors(form, err)

// Equivalent to:
// Object.entries(err.fields).forEach(([field, messages]) => {
//   form.setFieldMeta(field, meta => ({ ...meta, errors: messages }))
// })
```

`applyFormErrors` does nothing when `parsed` is `null` or `parsed.fields` is empty — safe to call unconditionally on every render.

## In `onError` Callbacks

Apply errors inside the mutation's `onError` option for automatic application:

```tsx
const create = CampaignController.use({ teamId }).mutateCreate({
  onError: (error) => {
    const parsed = parseControllerError(error)
    if (parsed?.isValidation) {
      applyFormErrors(form, parsed)
    } else if (parsed) {
      toast.error(parsed.message)
    }
  },
})
```

## Toast on Any Error

```tsx
const create = CampaignController.use({ teamId }).mutateCreate({
  onSuccess: () => toast.success('Campaign created!'),
  onError:   (e) => toast.error(parseControllerError(e)?.message ?? 'Something went wrong'),
})
```

## Server-Defined Error Codes

oRPC error codes come directly from the controller. The built-in codes:

| Code | `is*` flag | Thrown by |
|------|-----------|-----------|
| `BAD_REQUEST` | `isBadRequest` | `throw new BadRequest(...)` |
| `UNAUTHORIZED` | `isUnauthorized` | `throw new Unauthorized()` |
| `FORBIDDEN` | `isForbidden` | `throw new Forbidden(...)` |
| `NOT_FOUND` | `isNotFound` | `throw new NotFound(...)` or auto-rescue `RecordNotFound` |
| `UNPROCESSABLE_ENTITY` | `isValidation` | `throw toValidationError(record.errors)` |

Custom codes from `@rescue` handlers that throw `new ORPCError(...)` directly are available via `err.code` as a string — add your own `is*` checks as needed.
