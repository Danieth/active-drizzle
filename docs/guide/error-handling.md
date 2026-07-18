# Error Handling

Two audiences, one rule: **the user sees something friendly, your error
tracker sees everything.** ActiveDrizzle never knows which tracker you use —
you register a handler once, and every layer reports through it.

## Plug in your tracker

Backend, once at boot:

```ts
import { onError } from 'active-drizzle'

onError((error, context) => Rollbar.error(error, context))
// or Sentry.captureException(error, { extra: context })
// or logger.error({ err: error, ...context })
```

Frontend, once at app startup:

```ts
import { onClientError } from '@active-drizzle/react'

onClientError((error, context) => Rollbar.error(error, context))
```

That's the whole integration. `context` is a plain bag —
`{ model, operation, id }` from record saves, `{ procedure, method, path }`
from controller requests. Both `onError` and `onClientError` return an
unsubscribe function, multiple handlers are fine, and a handler that throws
can't break the request that was already failing. With **no** handler
registered, errors fall back to `console.error` — nothing is ever silently
dropped.

## Backend: database errors become validation errors

When Postgres rejects a write — a unique index race, a constraint your
validations didn't cover, a dropped connection — `save()` and `destroy()`
catch it, report the **raw** error to your handlers, and put a **friendly**
message on `record.errors`, exactly where validation failures already live:

```ts
const user = new User({ email: taken })
await user.save()                 // → false (no exception)
user.errors.on('email')           // → ['has already been taken']  (PG 23505)
// …and your onError handler already received the raw PG error.
```

What the SQLSTATE codes translate to:

| PG error | User sees |
| --- | --- |
| `23502` not null | `<field> can't be blank` |
| `23505` unique | `<field> has already been taken` |
| `23503` foreign key | `<field> refers to something that no longer exists` |
| `22001` too long / `22003` out of range / `22P02` bad format | `is too long` / `is out of range` / `is invalid` |
| `40001` / `40P01` deadlock | "The operation conflicted with another change. Please try again." |
| connection-class (`08…`, `53…`, `57P0x`) | "The service is temporarily unavailable. Please try again shortly." |
| anything else with a SQLSTATE | "Something went wrong. Please try again." |

The field comes from the driver when it names one (`column` on 23502, the
`Key (email)=…` detail on 23505/23503); otherwise the message lands on
`errors.on('base')`.

Three deliberate boundaries:

- **Non-database errors still throw.** A `TypeError` in your hook is a bug;
  it must crash loudly, not become a polite banner.
- **Inside `transaction()` the error rethrows** after reporting — a failed
  statement aborts the PG transaction, so the whole block must roll back.
- Field messages match the validators, so the unique-index race that slips
  past `Validates.uniqueness()` produces the *same* `'has already been
  taken'` the validator would have.

## Controller: uncaught errors become safe responses

The adapter is the last line. `HttpError`s serialize as before; anything
else is reported to `onError`, then:

| Error | Response |
| --- | --- |
| Recognized DB error with a field | `422 { errors: { email: ['has already been taken'] } }` |
| Recognized DB error, no field | `422 { error: 'Something went wrong. Please try again.' }` |
| Retryable (deadlock) | `409 { error: … }` |
| DB unavailable | `503 { error: … }` |
| Everything else | `500 { error: 'Internal server error' }` — details only in your tracker, never in the response |

## Frontend: one call in `onError`

`handleControllerError` decides what the user sees and reports what the
developer needs — it returns the banner text, or `null` when field errors
already tell the story:

```ts
import { handleControllerError } from '@active-drizzle/react'

const create = CampaignController.use({ teamId }).mutateCreate({
  onError: (e) => setBanner(handleControllerError(e, { form })),
})
```

- **422 with a form** → field errors applied via `applyFormErrors`, returns
  `null` (the inputs show the problem — no banner needed)
- **Other 4xx** (not found, forbidden…) → returns the server's message,
  which is already user-safe
- **Everything else** (500s, network drops) → reports the raw error through
  `onClientError` and returns `"Something went wrong. Please try again."`

Need different UX? `parseControllerError` gives you the structured error
(`isValidation`, `isNotFound`, `fields`, …) and you compose your own — the
pieces are all exported.
