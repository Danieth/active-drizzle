# Error Handling

Controllers throw HTTP-mapped errors that automatically serialise to proper oRPC error codes, consistent JSON bodies, and the right HTTP status on REST adapters.

## Built-in Error Classes

```typescript
import {
  BadRequest,       // 400
  Unauthorized,     // 401
  Forbidden,        // 403
  NotFound,         // 404
  ValidationError,  // 422 — structured field errors
} from '@active-drizzle/controller'
```

## Usage

```typescript
// Simple message
throw new NotFound('Campaign')
// → { status: 404, code: "NOT_FOUND", message: "Campaign not found" }

// Bad request with detail
throw new BadRequest('Budget must be positive')

// Forbidden with reasoning
throw new Forbidden('You do not own this campaign')

// Validation failure from model
const ok = await campaign.save()
if (!ok) throw toValidationError(campaign.errors)
// → { status: 422, code: "UNPROCESSABLE_ENTITY",
//     errors: { name: ["can't be blank"], budget: ["must be positive"] } }
```

## Conversion to oRPC

When using `buildRouter`, all `HttpError` instances thrown in handlers (including lifecycle hooks) are automatically converted to `ORPCError` with the matching code. You never need to do this manually.

| HTTP Status | oRPC Code               |
|-------------|-------------------------|
| 400         | `BAD_REQUEST`           |
| 401         | `UNAUTHORIZED`          |
| 403         | `FORBIDDEN`             |
| 404         | `NOT_FOUND`             |
| 422         | `UNPROCESSABLE_ENTITY`  |

## REST Adapter (Hono)

```typescript
import { honoAdapter } from '@active-drizzle/controller/hono'
import { Hono } from 'hono'
import { router, routes } from './_routes.gen'

const app = new Hono()
honoAdapter(app, router, routes)
// Routes registered: GET /campaigns, POST /campaigns, GET /campaigns/:id, etc.
```

Error serialisation in the Hono adapter maps `HttpError.statusCode` directly to the HTTP response status.
