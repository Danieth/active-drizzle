# Error Handling

ActiveDrizzle provides a layered error system: built-in HTTP error classes, Rails-style `@rescue` handlers, automatic rescue of common ORM errors, and a structured frontend utility for turning errors into UI state.

---

## Built-in Error Classes

```typescript
import {
  BadRequest,       // 400
  Unauthorized,     // 401
  Forbidden,        // 403
  NotFound,         // 404
  ValidationError,  // 422 — structured field errors
  toValidationError,
} from '@active-drizzle/controller'
```

Throw these from any controller method, lifecycle hook, or `@rescue` handler:

```typescript
// Simple 404
throw new NotFound('Campaign')
// → { code: "NOT_FOUND", message: "Campaign not found" }

// 400 with detail
throw new BadRequest('Budget must be positive')

// 403
throw new Forbidden('You do not own this campaign')

// 422 with field-level errors (TanStack Form compatible)
const ok = await campaign.save()
if (!ok) throw toValidationError(campaign.errors)
// → { code: "UNPROCESSABLE_ENTITY", errors: { name: ["can't be blank"] } }
```

All `HttpError` subclasses thrown anywhere in the dispatch cycle (action body, `@before`/`@after` hooks, `@rescue` handlers) are automatically converted to the correct `ORPCError` code. You never call `httpToOrpc` manually.

| HTTP Status | oRPC Code              |
|-------------|------------------------|
| 400         | `BAD_REQUEST`          |
| 401         | `UNAUTHORIZED`         |
| 403         | `FORBIDDEN`            |
| 404         | `NOT_FOUND`            |
| 422         | `UNPROCESSABLE_ENTITY` |

---

## Auto-Rescue: RecordNotFound → 404

When you call `Model.find(id)` inside any controller method and the record doesn't exist, the ORM throws a `RecordNotFound` error. This is automatically converted to a `NOT_FOUND` oRPC error — no manual handling needed:

```typescript
@mutation()
async launch(campaign: Campaign) {
  // If id doesn't exist, the router auto-rescue converts RecordNotFound → 404
  // The @mutation record auto-load already handles this for you,
  // but if you call Model.find() yourself inside an @action:
  const team = await Team.find(this.params.teamId)  // throws RecordNotFound if missing
  // → automatically becomes NOT_FOUND response
}
```

This mirrors Rails' `ActiveRecord::RecordNotFound` behaviour exactly.

---

## @rescue — Rails-style Error Handlers

`@rescue` lets you intercept specific error types and convert, swallow, or re-map them. Declare a handler method, decorate it with `@rescue(ErrorClass)`, and it fires whenever that error type is thrown during an action.

```typescript
import { rescue, BadRequest, NotFound } from '@active-drizzle/controller'

class DomainError extends Error { constructor(msg: string) { super(msg); this.name = 'DomainError' } }
class LockError  extends Error {}

@controller('/campaigns')
@crud(Campaign, { /* ... */ })
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {

  // Convert a domain error into a user-friendly 400
  @rescue(DomainError)
  async handleDomainError(e: DomainError) {
    throw new BadRequest(`Operation failed: ${e.message}`)
  }

  // Swallow a transient error and return a fallback value
  @rescue(LockError, { only: ['index'] })
  async handleLockOnIndex(_e: LockError) {
    return { data: [], pagination: { totalCount: 0 } }
  }

  @mutation()
  async launch(campaign: Campaign) {
    if (campaign.isLocked()) throw new LockError()
    campaign.status = 'active'
    return campaign.save()
  }
}
```

**Handler semantics:**
- If the handler **throws** a different error, that error becomes the response (error conversion)
- If the handler **returns** a value, that becomes the action's response (error swallowed, fallback used)
- If no matching `@rescue` handler is found, the error continues through the auto-rescue chain

**Inheritance:** `@rescue` handlers defined on parent classes fire before child handlers, just like `@before` hooks. Define common error handling in a base controller:

```typescript
export class BaseController extends ActiveController<AppContext> {
  @rescue(SomeDomainError)
  async handleCommon(e: SomeDomainError) {
    throw new BadRequest(e.message)
  }
}

// All subclasses automatically get handleCommon
export class CampaignController extends BaseController { /* ... */ }
export class AssetController    extends BaseController { /* ... */ }
```

**Options:**
- `only: ['create', 'update']` — rescue only for these actions
- `except: ['index']` — rescue for all actions except these

---

## this.record in @before Hooks

When `@mutation` or `@action({ load: true })` auto-loads a record, it's available as `this.record` **before** `@before` hooks run. Use this to check ownership or permissions without an extra DB query:

```typescript
@before({ only: ['launch', 'update'] })
async ensureOwner() {
  if (this.record.creatorId !== this.context.user.id) {
    throw new Forbidden('You do not own this campaign')
  }
}

@mutation()
async launch(campaign: Campaign) {
  // @before already verified ownership — proceed
  campaign.status = 'active'
  return campaign.save()
}
```

---

## Frontend: parseControllerError

`@active-drizzle/react` exports `parseControllerError` to turn oRPC errors into a structured object suitable for UI state. Use it with TanStack Query's `mutation.error` or `query.error`.

```typescript
import { parseControllerError, applyFormErrors } from '@active-drizzle/react'

const create = CampaignController.use({ teamId }).mutateCreate()
const err = parseControllerError(create.error)
```

The returned `ParsedControllerError` has:

```typescript
interface ParsedControllerError {
  code: string              // e.g. 'UNPROCESSABLE_ENTITY'
  message: string           // human-readable
  fields?: Record<string, string[]>  // validation field errors
  isValidation: boolean     // UNPROCESSABLE_ENTITY
  isNotFound: boolean       // NOT_FOUND
  isUnauthorized: boolean   // UNAUTHORIZED
  isForbidden: boolean      // FORBIDDEN
  isBadRequest: boolean     // BAD_REQUEST
}
```

### Usage patterns

**Toast on any error:**

```tsx
const create = CampaignController.use({ teamId }).mutateCreate()
const err    = parseControllerError(create.error)

return (
  <>
    {err && <Toast message={err.message} variant="error" />}
    <button onClick={() => create.mutate(data)} disabled={create.isPending}>Save</button>
  </>
)
```

**Redirect on 404:**

```tsx
const { data, error } = ctrl.get(id)
const err = parseControllerError(error)
if (err?.isNotFound) return <Navigate to="/404" />
```

**Bind validation errors to TanStack Form:**

```tsx
import { useForm }        from '@tanstack/react-form'
import { applyFormErrors } from '@active-drizzle/react'

const create = CampaignController.use({ teamId }).mutateCreate()

const form = useForm({
  ...campaignFormConfig,
  onSubmit: async ({ value }) => {
    await create.mutateAsync(value)
  },
})

// In render, after a failed submit:
const err = parseControllerError(create.error)
if (err?.isValidation) {
  applyFormErrors(form, err)
  // Sets field.state.meta.errors for each invalid field automatically
}
```

`applyFormErrors` calls `form.setFieldMeta(field, meta => ({ ...meta, errors: messages }))` for each field in `err.fields`. One line to go from server validation → form field errors. No manual field-by-field handling.

---

## Complete Example

A controller with `@rescue`, per-action ownership check, and a frontend component that handles all error states:

```typescript
// CampaignController.ctrl.ts
@controller('/campaigns')
@crud(Campaign, { update: { permit: ['name', 'status'] } })
@scope('teamId')
export class CampaignController extends ActiveController<AppContext> {

  @before({ only: ['update', 'launch', 'archive'] })
  async ensureOwner() {
    if (this.record.creatorId !== this.context.user.id) {
      throw new Forbidden('Not your campaign')
    }
  }

  @rescue(SomeThirdPartyError)
  async handleThirdParty(e: SomeThirdPartyError) {
    throw new BadRequest(`External service error: ${e.message}`)
  }

  @mutation()
  async launch(campaign: Campaign) {
    campaign.status = 'active'
    return campaign.save()
  }
}
```

```tsx
// CampaignsPage.tsx
function LaunchButton({ campaignId, teamId }) {
  const launch = CampaignController.use({ teamId }).mutateLaunch()
  const err    = parseControllerError(launch.error)

  return (
    <div>
      <button
        onClick={() => launch.mutate(campaignId)}
        disabled={launch.isPending}
      >
        {launch.isPending ? 'Launching...' : 'Launch'}
      </button>
      {err?.isForbidden   && <p className="text-red-500">You don't own this campaign.</p>}
      {err?.isBadRequest  && <p className="text-yellow-500">{err.message}</p>}
    </div>
  )
}
```
