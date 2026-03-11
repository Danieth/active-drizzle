# active-drizzle

Rails ActiveRecord patterns for [Drizzle ORM](https://orm.drizzle.team). Write expressive, type-safe models with associations, lifecycle hooks, dirty tracking, and enum transforms — while Drizzle handles the actual SQL. A Vite plugin catches schema errors at build time that Rails only finds in production.

## What it is

| Rails ActiveRecord | active-drizzle |
|---|---|
| `class Asset < ApplicationRecord` | `class Asset extends ApplicationRecord` |
| `enum asset_type: { jpg: 116 }` | `static assetType = Attr.enum({ jpg: 116 })` |
| `before_save :sanitize` | `@beforeSave() sanitize() {}` |
| `has_many :attachments` | `static attachments = hasMany()` |
| `has_many :campaigns, through: :assets_campaigns` | `static campaigns = hasMany({ through: 'assets_campaigns' })` |
| `accepts_nested_attributes_for :campaigns` | `static campaigns = hasMany({ acceptsNested: true })` |
| Catches nothing at build time | Catches missing FKs, bad enums, broken STI at **compile time** |

---

## Quick Start

```bash
npm install active-drizzle drizzle-orm
```

```typescript
// app/models/asset.model.ts
import { ApplicationRecord, Attr, hasMany, belongsTo } from 'active-drizzle'
import { model, beforeSave, afterCommit, validate } from 'active-drizzle'

@model('assets')
export class Asset extends ApplicationRecord {
  // Enum: integer in DB, string label in your code
  static assetType = Attr.enum({ jpg: 116, png: 125, gif: 111, mp4: 202 } as const)

  // Typed attribute with inline validation
  static title = Attr.string({ validate: v => v ? null : 'required' })

  // JSON column as typed object
  static metadata = Attr.json<{ tags: string[]; width: number }>()

  // Associations
  static uploader = belongsTo()
  static attachments = hasMany()
  static tags = habtm('assets_tags')

  @beforeSave()
  normalizeTitle() {
    (this as any).title = (this as any).title?.trim()
  }

  @afterCommit()
  scheduleProcessing() {
    // Safe — fires only after the DB transaction commits
    queue.add('process-asset', { id: (this as any).id })
  }

  @validate()
  checkDimensions() {
    const m = (this as any).metadata
    if (m?.width > 10000) return 'Width exceeds maximum'
  }
}
```

```typescript
// app/boot.ts
import { boot } from 'active-drizzle'
import { db } from './db'
import * as schema from './schema'

boot(db, schema)
```

---

## Core Features

### ApplicationRecord — the Proxy-wrapped base class

Every model extends `ApplicationRecord`. A JavaScript Proxy wraps every instance, giving you transparent attribute transforms, dirty tracking, and enum helpers:

```typescript
const asset = await Asset.where({ uploaderId: userId }).first()

// Attribute transforms happen transparently
asset.assetType          // → 'jpg'  (integer 116 in DB)
asset.assetType = 'png'  // stores integer 125

// Codegen-generated enum predicates and bang setters
asset.isJpg()            // → false
asset.toPng()            // sets assetType = 'png', returns asset

// Dirty tracking
asset.assetTypeChanged() // → true
asset.assetTypeWas()     // → 'jpg'
asset.assetTypeChange()  // → ['jpg', 'png']
asset.isChanged()        // → true
asset.changedFields()    // → ['assetType']

// Persistence
await asset.save()       // INSERT or UPDATE, runs hooks, clears dirty state
await asset.reload()     // re-fetches from DB, discards in-memory changes
await asset.destroy()    // DELETE, runs beforeDestroy / afterDestroy

// Convenience
await asset.update({ title: 'New Title' })  // assign + save in one call
```

### Attr System

Declarative field transforms, defaults, and validations:

```typescript
static status    = Attr.enum({ draft: 0, sent: 1, failed: 2 } as const)
static price     = Attr.new({ get: v => v / 100, set: v => Math.round(v * 100) })
static title     = Attr.string({ validate: v => v ? null : 'required' })
static count     = Attr.integer()
static active    = Attr.boolean()
static settings  = Attr.json<UserSettings>()
static fullName  = Attr.for('full_name', { get: v => v?.trim(), set: v => v?.trim() })
```

Transforms apply transparently through the Proxy — `.get()` on read, `.set()` on write, compared against the raw DB value to track changes.

### Chainable Queries

```typescript
// Every method returns a Relation — nothing executes until you await
const drafts = await Post.where({ status: 'draft' })
                         .order('createdAt', 'desc')
                         .limit(10)

// Smart hash where — applies Attr.set() transforms automatically
Post.where({ status: 'sent' })         // WHERE status = 1
Post.where({ status: ['draft', 'sent'] })  // WHERE status IN (0, 1)
Post.where({ deletedAt: null })         // WHERE deleted_at IS NULL
Post.where({ id: Asset.videos() })      // WHERE id IN (SELECT id FROM assets WHERE ...)

// Execution methods
await Post.all()                         // all records
await Post.first()                       // first record
await Post.find(5)                       // by id, throws if not found
await Post.findBy({ email: 'x@x.com' }) // returns null if not found
await Post.pluck('id', 'title')          // array of values, no proxy overhead
await Post.where({}).updateAll({ status: 'archived' })  // bulk UPDATE
await Post.where({}).destroyAll()        // bulk DELETE

// Batching large datasets
await Post.where({ status: 'active' }).inBatches(500, async (batch) => {
  await batch.updateAll({ processedAt: new Date() })
})

// Pessimistic locking
await Asset.where({ id: assetId }).withLock(async (locked) => {
  const asset = await locked.first()
  await asset!.update({ status: 'processing' })
})
```

### Associations — lazy-loaded, zero config

```typescript
static creator = belongsTo()              // FK: creatorId on this table
static address = hasOne()                 // FK: ${modelName}Id on target
static posts   = hasMany()                // FK: ${modelName}Id on target
static tags    = habtm('posts_tags')      // join table
static creator = belongsTo('users', { foreignKey: 'authorId' })
static items   = hasMany({ through: 'order_items' })
static items   = hasMany({ dependent: 'destroy' })   // cascade on destroy()
static items   = hasMany({ acceptsNested: true })     // enables campaignsAttributes in Create type
```

Accessing an association on an instance returns a lazy value:
```typescript
const business = await asset.business         // Promise<Business | null>
const campaigns = await asset.campaigns       // awaitable Relation<Campaign>
const first = await asset.campaigns.first()   // chaining works
```

### Transactions

```typescript
await ApplicationRecord.transaction(async () => {
  const asset = await Asset.create({ title: 'New' })
  await business.update({ assetCount: business.assetCount + 1 })
  // All queries automatically route through the transaction client via AsyncLocalStorage
  // Roll back happens automatically if anything throws or AbortChain is thrown
})
```

### Lifecycle Hooks

```typescript
@beforeSave()   method() {}   // before every save
@afterSave()    method() {}   // after every save
@beforeCreate() method() {}   // INSERT only
@afterCreate()  method() {}   // INSERT only
@beforeUpdate() method() {}   // UPDATE only
@afterUpdate()  method() {}   // UPDATE only
@beforeDestroy() method() {}  // before delete
@afterDestroy()  method() {}  // after delete
@afterCommit()   method() {}  // after transaction commits (safe for side effects)
```

Conditional execution:
```typescript
@beforeSave({ if: 'statusChanged' })          // runs only when status changed
@afterCommit({ on: 'create' })                // runs only on first INSERT
@beforeSave({ if: () => this.isJpg() })       // lambda condition
```

Returning `false` from a `before*` hook aborts the operation.

### Validations

```typescript
// Inline — attached to a specific field
static email = Attr.string({ validate: v => v?.includes('@') ? null : 'invalid email' })
static price = Attr.new({ serverValidate: async v => {
  const taken = await Price.findBy({ amount: v })
  return taken ? 'price already in use' : null
}})

// Class-level — runs during save()
@validate()
checkDates() {
  if ((this as any).startDate > (this as any).endDate)
    return 'start must be before end'
}

@serverValidate()
async checkUniqueness() {
  const existing = await User.findBy({ email: (this as any).email })
  if (existing) (this as any).errors.email = ['already taken']
}
```

### STI — Single Table Inheritance

```typescript
@model('text_messages')
class TextMessage extends ApplicationRecord {}

@model('text_messages')
class OutboundTemplate extends TextMessage {
  static stiType = 1000  // auto-injects WHERE type = 1000 on all queries
}

// Loading from the parent table auto-instantiates the right subclass:
const msgs = await TextMessage.where({})
// msgs[0] might be OutboundTemplate, msgs[1] might be InboundMessage, etc.
```

---

## Build-Time Codegen (The Killer Feature)

active-drizzle's Vite plugin runs `ts-morph` on your schema and model files at build time, catching errors that Rails only finds in production at 3am.

```typescript
// vite.config.ts
import activeDrizzle from 'active-drizzle/vite'

export default defineConfig({
  plugins: [
    activeDrizzle({
      schema: 'db/schema.ts',
      models: 'src/models/**/*.model.ts',
    })
  ]
})
```

### What it catches

```
ERROR  Asset.model.ts — Association "imagePacks": table "image_packs" not found. Did you mean "assets"?
ERROR  Campaign.model.ts — Association "assets": column "campaignId" not found on table "assets"
ERROR  TextMessage.model.ts — Enum "status": expects INTEGER column but found "text"
ERROR  Post.model.ts — Hook "notifyTeam": condition "teamIdsChanged" references field not found on table
ERROR  Asset.model.ts — Attr.set() on "score" appears to return "string", but column "score" is typed as "integer"
WARN   Campaign.model.ts — no bidirectional belongsTo found on Asset. Consider adding it.
WARN   OutboundTemplate.model.ts — STI model: add `static stiType = <value>` for auto-scoping
WARN   Asset.model.ts — Scope "recent": references `this.nonExistent` which was not found as a column or Attr
```

### What it generates (per model)

Two files per model, placed next to the source:

**`Asset.model.gen.d.ts`** — TypeScript type declarations:
```typescript
declare module './Asset.model' {
  interface Asset {
    isJpg(): boolean; toPng(): AssetRecord   // enum predicates + bang setters
    assetTypeChanged(): boolean              // dirty tracking
    assetTypeWas(): number | null
    business: Promise<BusinessRecord>        // associations
    campaigns: Relation<CampaignRecord, CampaignAssociations>
  }
  namespace Asset {
    function where(condition?: AssetWhere): Relation<AssetRecord, AssetAssociations>
    const recent: Relation<AssetRecord, AssetAssociations>  // scopes
    class Client { ... }  // type for the isomorphic frontend class
  }
}
export interface AssetWhere { status?: ('draft' | 'sent' | number) | ... | Relation }
export interface AssetCreate { title?: string | null; businessId: number; ... }
export type AssetUpdate = Partial<AssetCreate> & { id: number }
```

**`Asset.model.gen.ts`** — Executable runtime code:
```typescript
// Attaches Asset.Client — an isomorphic data class for the frontend
export class AssetClient {
  constructor(payload = {}) { ... }   // auto-hydrates defaults + nested associations
  isChanged(): boolean                // client-side dirty tracking
  restoreAttributes(): void           // revert to last-loaded state
  validate(): Record<string, string[]> // runs inline validations, TanStack Form format
  toJSON(): Record<string, unknown>
}
;(Asset as any).Client = AssetClient
```

**`_registry.gen.ts`** — Imports all models + wires up `.Client` constructors:
```typescript
import { Asset } from './Asset.model.js'
import './Asset.model.gen.js'   // side-effect: attaches Asset.Client
export const registry = { Asset, Business, ... } as const
```

**`.active-drizzle/schema.md`** — LLM-optimized schema reference. Point your AI agent here for zero-hallucination context of the entire data model.

### `acceptsNestedAttributesFor` Runtime

When `hasMany({ acceptsNested: true })` is declared, `save()` automatically processes `*Attributes` arrays on the instance — creating, updating, or destroying child records:

```typescript
const order = new Order({
  status: 'pending',
  lineItemsAttributes: [
    { name: 'Widget', qty: 2 },        // → create
    { id: 5, name: 'Updated', qty: 1 }, // → update
    { id: 9, _destroy: true },          // → destroy
  ],
})
await order.save()  // inserts order, then creates/updates/destroys line items
```

The `lineItemsAttributes` key is stripped from the parent DB payload automatically.

### `hasMany` Declarative Order

Associations can declare a default sort order applied to every lazy-loaded Relation:

```typescript
static comments = hasMany({ order: { createdAt: 'desc' } })
// post.comments → Relation pre-ordered by createdAt DESC
```

### `counterCache`

Automatically keeps a count column on the parent in sync:

```typescript
// In Post model
static comments = hasMany({ counterCache: true })
// → column "commentsCount" on posts table is incremented on create, decremented on destroy

// Custom column name
static comments = hasMany({ counterCache: 'totalComments' })
```

The child model needs a `belongsTo` back-reference for the FK to be discovered automatically.

### `autosave`

Saving a parent automatically saves any already-loaded associations with pending changes:

```typescript
static comments = hasMany({ autosave: true })

post.comments[0].body = 'edited'
await post.save()  // → also saves the changed comment
```

### Plain Column Access (no `Attr.*` declaration)

Every DB column is readable and dirty-tracked through the proxy, even without an explicit `Attr.*` declaration. Columns with `Attr.*` gain transforms, coercion, and validation on top:

```typescript
// Works without any Attr declaration
post.title = 'updated'
post.isChanged()     // → true
post.titleWas()      // → 'original'
await post.save()    // → UPDATE includes title

// Explicit Attr adds transforms/coercion on top
static title = Attr.string()   // trims on write, null-safe on read
```

### The Isomorphic `Model.Client`

After importing from `_registry.gen.ts`, every model has a `.Client` class for use in React forms:

```typescript
// Create form — defaults auto-populated from Attr.default()
const asset = new Asset.Client()
// → { status: 'draft', retries: 0, ... }

// Re-hydrates nested associations from API payloads
const asset = new Asset.Client(apiPayload)
asset.campaigns[0]          // → Campaign.Client instance, not a plain object
asset.campaigns[0].isActive()  // → works immediately, no state mapping

// TanStack Form integration
<Button disabled={!asset.isChanged()}>Save</Button>
asset.restoreAttributes()   // user clicks Cancel — reverts to last-loaded state
const errors = asset.validate()  // → { title: ['required'], price: ['must be positive'] }
```

---

## Testing

```bash
npx vitest run           # run tests (258 passing)
npx vitest run --coverage  # with V8 line coverage
```

active-drizzle tests use `ts-morph` in-memory projects for codegen tests — no disk I/O, instantaneous. Runtime tests use mock DB instances that capture query parameters for assertion.
