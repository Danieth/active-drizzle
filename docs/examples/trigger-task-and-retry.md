# Trigger.dev Task + Batch Updates + Error Handling

This doc shows:
1. A full example of triggering a background task and doing batch updates
2. Error handling in active-drizzle
3. Recovering from DB connection errors and retrying

---

## 1. Full Task Trigger + Batch Updates Example

### Controller — enqueue on launch

```typescript
// src/controllers/Campaign.ctrl.ts
import { ActiveController, controller, crud, mutation, before, afterCommit } from '@active-drizzle/controller'
import { tasks } from '@trigger.dev/sdk/v3'
import { Campaign } from '../models/Campaign.model'

@controller('/campaigns')
@crud(Campaign, { scopes: ['teamId'] })
export class CampaignController extends ActiveController<AppContext> {
  @before()
  async requireAuth() {
    if (!this.context.user) throw new Unauthorized()
  }

  @mutation()
  async launch(id: number) {
    const campaign = await Campaign.where({ id, teamId: this.context.teamId }).first()
    if (!campaign) throw new NotFound('Campaign')
    if (campaign.status !== 'draft') throw new BadRequest('Campaign already launched')

    await campaign.update({ status: 'pending_launch' })
    // afterCommit fires after the transaction commits
  }

  @afterCommit({ if: 'statusChanged' })
  async enqueueLaunch() {
    if (this.status !== 'pending_launch') return
    await tasks.trigger('campaigns.process-launch', { campaignId: this.id })
  }
}
```

### Trigger.dev task — batch updates

```typescript
// src/tasks/process-launch.ts
import { tasks } from '@trigger.dev/sdk/v3'
import { boot, ApplicationRecord } from '@active-drizzle/core'
import { db, schema } from '../db'
import { Campaign, Asset } from '../models'

tasks.define({
  id: 'campaigns.process-launch',
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
  },
  run: async (payload) => {
    boot(db, schema)

    const campaign = await Campaign.find(payload.campaignId)

    await ApplicationRecord.transaction(async () => {
      // 1. Update the campaign
      await campaign.update({
        status: 'active',
        launchedAt: new Date(),
      })

      // 2a. Per-record updates (beforeSave/afterSave hooks run for each)
      const assets = await Asset.where({ campaignId: campaign.id }).load()
      for (const asset of assets) {
        await asset.update({ status: 'live' })
      }

      // 2b. OR use bulk updateAll (no hooks, single SQL UPDATE — faster for large sets)
      await Asset.where({ campaignId: campaign.id })
        .where({ status: 'draft' })
        .updateAll({ status: 'live', updatedAt: new Date() })
    })

    // Optional: trigger follow-up tasks
    await tasks.trigger('campaigns.send-launch-notifications', { campaignId: campaign.id })
  },
})
```

---

## 2. Error Handling in active-drizzle

### Built-in HTTP errors (controllers)

| Class           | Status | Use case                          |
|----------------|--------|------------------------------------|
| `BadRequest`    | 400    | Invalid input, bad params          |
| `Unauthorized`  | 401    | Not authenticated                  |
| `Forbidden`     | 403    | Authenticated but not allowed      |
| `NotFound`      | 404    | Record not found                   |
| `ValidationError` | 422  | Model validation failed            |

```typescript
// In a controller or @before hook
throw new NotFound('Campaign')
throw new BadRequest('Budget must be positive')
throw new Forbidden('You do not own this campaign')

// From model validation
if (!(await campaign.save())) throw toValidationError(campaign.errors)
```

### Runtime errors (ApplicationRecord)

| Error            | When it's raised                          |
|------------------|-------------------------------------------|
| `RecordNotFound` | `Model.find(id)` when no row exists       |
| `AbortChain`     | Thrown from a hook to roll back a transaction |

```typescript
import { RecordNotFound } from '@active-drizzle/core'

try {
  const user = await User.find(999)
} catch (e) {
  if (e instanceof RecordNotFound) {
    // e.model, e.id available
  }
}
```

### Unhandled errors (DB, etc.)

- **Controllers**: Non-`HttpError` exceptions → 500, logged to console
- **ApplicationRecord**: Drizzle/DB errors bubble up unchanged — no retry, no special handling

---

## 3. DB Connection Errors & Retrying

### The problem

active-drizzle does **not** have built-in retry for transient DB errors (ECONNREFUSED, connection pool exhausted, etc.). If Drizzle throws, the error propagates. You handle it yourself.

### Option A: trigger.dev retries (recommended for tasks)

trigger.dev **automatically retries** failed tasks. A DB connection error causes the task to fail → trigger.dev retries with backoff. Configure per-task:

```typescript
tasks.define({
  id: 'campaigns.process-launch',
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
  },
  run: async (payload) => {
    boot(db, schema)
    // If this throws ECONNREFUSED, trigger.dev retries the whole run()
    const campaign = await Campaign.find(payload.campaignId)
    // ...
  },
})
```

**Idempotency**: Make task logic idempotent so retries are safe. Example: check `status === 'pending_launch'` before mutating, or use `updateAll` with a `WHERE` that only matches rows that still need processing.

### Option B: Manual retry wrapper (for non-trigger code)

For API handlers, cron scripts, or other code that isn't in a trigger.dev task, wrap DB work in a retry helper:

```typescript
// src/lib/retry-db.ts
const TRANSIENT_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01',   // admin shutdown
  '57P02',   // crash shutdown
  '57P03',   // cannot connect now
]

function isTransientDbError(e: unknown): boolean {
  if (e instanceof Error) {
    if (TRANSIENT_CODES.includes((e as any).code)) return true
    if (/connection|connect|timeout/i.test(e.message)) return true
  }
  return false
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options = { maxAttempts: 3, baseMs: 500 }
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isTransientDbError(e) || attempt === options.maxAttempts) throw e
      const delay = options.baseMs * Math.pow(2, attempt - 1)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}
```

Usage in a controller or script:

```typescript
import { withDbRetry } from '../lib/retry-db'

// In a controller action or plain function
const result = await withDbRetry(async () => {
  boot(db, schema)
  const campaign = await Campaign.find(id)
  await campaign.update({ status: 'active' })
  return campaign
})
```

### Option C: Connection pool tuning (Drizzle/pg)

Reduce connection failures by tuning the pool:

```typescript
// db/index.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5000,
})

export const db = drizzle({ client: pool, schema })
```

---

## Summary

| Scenario                    | Approach                                      |
|----------------------------|-----------------------------------------------|
| trigger.dev task fails     | Use task `retry` config; make logic idempotent |
| API/cron without trigger   | Wrap DB work in `withDbRetry()`               |
| Reduce connection errors   | Tune pool, health checks, failover            |

active-drizzle stays thin: it doesn't add retry logic. You layer retries at the right boundary (task runner or a small wrapper).
