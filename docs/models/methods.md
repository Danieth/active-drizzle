# Model Methods

The signature-and-example reference for the `ApplicationRecord` public API. Conceptual guides live in the other Models pages; this is the terse method companion. Chainable query-builder methods (`where().order().group()…`, aggregates, windows) live under [Querying](/querying/basics).

# Class Methods

Methods called on a model class (e.g. `User`, `Product`, `Order`). Chainable query methods (`where`, `order`, `limit`, aggregates, `group`, windows…) return a `Relation` and are covered under **Querying entry points** — see that section rather than re-documenting the whole builder here.

## Finders

### `find(id: number | string): Promise<T>`
Fetch one row by primary key; raises `RecordNotFound` if none matches. Rails `find` — raises when missing. Use `findBy({ id })` or `first()` for a nullable lookup.
```ts
const user = await User.find(1)              // → User, or throws RecordNotFound
```

### `findBang(id: number | string): Promise<T>`  — alias `find!`
Identical to `find` — raises `RecordNotFound`. The explicit-bang spelling of Rails `find`.
```ts
const order = await Order.findBang(42)       // throws if 42 doesn't exist
```

### `findBy(attrs: Record<string, any>): Promise<T | null>`
Fetch the first row matching an attribute hash; returns `null` if none. Rails `find_by` — returns nil when missing.
```ts
const admin = await User.findBy({ email: 'alice@example.com' })   // → User | null
```

### `findOrInitializeBy(attrs: Record<string, any>): Promise<T>`
Return the first match, or a new **unsaved** instance pre-filled with `attrs`. Rails `find_or_initialize_by`.
```ts
const tag = await Tag.findOrInitializeBy({ name: 'apparel' })     // saved or brand-new
```

### `findOrCreateBy(attrs: Record<string, any>): Promise<T>`
Return the first match, or create and persist a new row from `attrs`. Rails `find_or_create_by`.
```ts
const tag = await Tag.findOrCreateBy({ name: 'digital' })         // always persisted
```

### `first(): Promise<T | null>`
First row by primary-key order; `null` when the table/scope is empty. Rails `first`.
```ts
const oldest = await Order.first()
```

### `last(n?: number): Promise<T | T[] | null>`
Last row (or last `n` rows) by primary-key order. Rails `last`.
```ts
const latest    = await Order.last()          // → Order | null
const lastThree = await Order.last(3)         // → Order[]
```

### `take(n?: number): Promise<T | T[] | null>`
One row (or `n` rows) with no implicit ordering — cheapest "just give me a record". Rails `take`.
```ts
const anyUser = await User.take()
```

### `exists(cond?: Record<string, any>): Promise<boolean>`
True if any row matches (optionally filtered by `cond`). Rails `exists?`.
```ts
if (await User.exists({ role: 'admin' })) { /* … */ }
```

### `any()` · `many()` · `one()` · `empty()`  → `Promise<boolean>`
Cardinality predicates over the whole table. Rails `any?` / `many?` / `one?` / `none?`(inverse). `many` is "> 1 row", `one` is "exactly 1".
```ts
await Product.any()   // at least one product?
await Order.empty()   // no orders at all?
```

### `ids(): Promise<any[]>`
Array of primary-key values for every row. Rails `ids`.
```ts
const allIds = await Product.ids()   // → [1, 2, 3, …]
```

### `pluck(...fields: string[]): Promise<any[]>`
Column values without instantiating records — one array (single field) or tuples (multiple). Rails `pluck`.
```ts
const names = await Product.pluck('name')                // → string[]
const pairs = await Product.pluck('id', 'priceInCents')  // → [id, cents][]
```

### `pick(...cols: string[]): Promise<any>`
The requested columns of the **first** matching row only. Rails `pick`.
```ts
const [id, name] = await Product.pick('id', 'name')
```

## Building & creating

### `new Model(attrs?: Record<string, any>): T`
Construct an **unsaved** record; constructor input is model-space and runs through each `Attr.set` (dollars→cents, label→raw). Rails `Model.new`. Call `save()` to persist.
```ts
const product = new Product({ name: 'Hoodie', price: 49.99 })   // unsaved; priceInCents = 4999
await product.save()
```

### `create(attrs: Record<string, any>): Promise<T>`
Build, validate, and persist in one call; **throws** if validation fails. Rails `create!` — raises on invalid.
```ts
const user = await User.create({ email: 'bob@example.com', name: 'Bob', role: 'customer' })
```

### `insertAll(records: Record<string, any>[]): Promise<number>`
Bulk INSERT that bypasses instantiation, validations, and callbacks; returns the row count. Applies each `Attr.set`. Rails `insert_all`.
```ts
const n = await Tag.insertAll([{ name: 'sale' }, { name: 'new' }])   // → 2
```

## Querying entry points

Each returns a chainable `Relation` (awaitable / `.load()`-able). The full builder surface — `joins`, `includes`, `group`, `having`, `distinct`, `select`, `union`, `seek`, `aggregate`, window functions — lives on `Relation`; these are just the model-class doorways into it.

### `all(): Relation<T>`
Unscoped relation over the whole table. Rails `all`.
```ts
const products = await Product.all()          // → Product[]
const total    = await Order.all().count()
```

### `where(conditions?: Record<string, any> | SQL | null): Relation<T>`
Start a filtered relation; hash values support operators (`lte`, `gte`, arrays → `IN`, `null` → `IS NULL`). Rails `where`.
```ts
const active = await Product.where({ isActive: true }).limit(25).load()
const cheap  = await Product.where({ priceInCents: { lte: 5000 } }).order('priceInCents').load()
```

### `order(field: string, direction?: 'asc' | 'desc'): Relation<T>`
Add an ORDER BY clause. Rails `order`.
```ts
const newest = await Order.order('createdAt', 'desc').load()
```

### `limit(n)` · `offset(n)`  → `Relation<T>`
Cap / skip rows (pagination). Rails `limit` / `offset`.
```ts
const page2 = await Product.limit(20).offset(20).load()
```

### `includes(...assocs: any[]): Relation<T>`
Eager-load associations to avoid N+1. Rails `includes`.
```ts
const orders = await Order.includes('lineItems', 'user').load()
```

### `unscoped(concernName?: string): Relation<T>`
Drop default scopes (all, or one named concern's). Rails `unscoped`.
```ts
const everything = await Order.unscoped().load()
```

### `none(): Relation<T>`
A relation guaranteed to return zero rows without hitting the DB. Rails `none`.
```ts
const empty = await Product.none().load()   // → []
```

### Scopes (user-defined statics)
A `static` method returning a relation is a scope; it chains like any builder call. Rails `scope`.
```ts
// models.ts:  static active() { return this.where({ isActive: true }) }
const live   = await Product.active().underPrice(50).load()
const admins = await User.admins().count()
```

## Aggregates

### `count(): Promise<number>`
Row count. Rails `count`.
```ts
const orders = await Order.count()
```

### `sum(col)` · `average(col)` · `minimum(col)` · `maximum(col)`
Column aggregates over the table/scope. Rails `sum` / `average` / `minimum` / `maximum`.
```ts
const revenue = await Order.sum('totalInCents')
const avg     = await Product.average('priceInCents')   // → number | null
const top     = await Product.maximum('priceInCents')
```

### `tally(col: string): Promise<Record<string, number>>`
Group-by-value counts for one column. Rails `group(col).count` / Enumerable `tally`.
```ts
const byRole = await User.tally('role')   // → { admin: 1, customer: 2 }
```

### `updateAll(updates: Record<string, any>): Promise<number>`
Bulk UPDATE bypassing validations/callbacks; returns affected row count. Rails `update_all`.
```ts
const n = await Product.where({ isActive: false }).updateAll({ stock: 0 })
```

### `findEach(batchSize: number, fn: (record: T) => Promise<void>): Promise<void>`
Stream the table in batches, invoking `fn` per record — memory-safe iteration. Rails `find_each`.
```ts
await Product.findEach(500, async (p) => { await reindex(p) })
```

## Transactions

### `transaction<R>(callback: () => Promise<R>): Promise<R>`
Run `callback` inside a DB transaction; any throw (including an aborted save chain) rolls back. `@afterCommit` hooks fire only after commit. Rails `transaction`.
```ts
await Order.transaction(async () => {
  const order = await Order.create({ userId: 1, status: 'pending' })
  await LineItem.create({ orderId: order.id, productId: 3, qty: 2 })
})   // both persist, or neither does
```

# Instance Methods

Methods called on a record (a model instance).

## Persistence

### `save(options?: { validate?: boolean }): Promise<boolean>`
Validate then INSERT (new) or UPDATE (changed columns only); returns `false` on validation/DB failure with messages on `errors`. Rails `save` — returns false, does not raise. Pass `{ validate: false }` to skip validations.
```ts
const product = new Product({ name: 'Cap', price: 19.99 })
if (await product.save()) { /* persisted */ } else { console.log(product.errors.full()) }
```

### `update(attrs: Record<string, any>): Promise<boolean>`
Assign the given attributes then `save()`; returns `false` on failure. Rails `update` — returns false, does not raise.
```ts
const order = await Order.find(1)
await order.update({ status: 'shipped' })
```

### `destroy(): Promise<boolean>`
Delete the row, running `beforeDestroy`/`afterDestroy` hooks and cascading any `dependent: 'destroy'` associations. Returns `false` for a new record. Rails `destroy`.
```ts
const tag = await Tag.find(7)
await tag.destroy()
```

### `reload(): Promise<this>`
Re-fetch from the DB, discarding in-memory changes; throws if the record is new or was deleted. Rails `reload`.
```ts
await order.reload()   // dirty changes dropped, fresh DB values
```

## Attributes & assignment

### attribute read / assignment
Reading applies the `Attr.get` transform (raw→model-space); assigning applies `Attr.set` and dirty-tracks under the underlying column. Rails attribute accessors.
```ts
product.price          // 49.99  (priceInCents 4999 → dollars)
product.price = 59.99  // stored as priceInCents 5999, marks dirty
user.admin             // true   (role === 'admin')
```

### `attributes: Record<string, any>` (getter)
Plain object of all attributes in **model-space** (get-transformed), with pending changes applied. Rails `attributes`.
```ts
order.attributes   // { id: 1, status: 'shipped', total: 72.00, … }
```

### `toJSON(opts?: { only?: string[]; except?: string[]; include?: string[] }): Record<string, any>`
Serialize to a plain object; `only`/`except` filter columns, `include` embeds already-loaded associations. Rails `as_json`.
```ts
order.toJSON({ except: ['userId'] })
order.toJSON({ only: ['id', 'status'], include: ['lineItems'] })
```

### `isNewRecord: boolean` · `isDestroyed: boolean`
`isNewRecord` is true until first save; `isDestroyed` is set true after `destroy()`. Rails `new_record?` / `destroyed?`.
```ts
const p = new Product({ name: 'x' })
p.isNewRecord   // true
await p.save()
p.isNewRecord   // false
```

## Dirty tracking

### `isChanged(): boolean`
True if any attribute has an unsaved change. Rails `changed?`.
```ts
user.name = 'Alicia'
user.isChanged()   // true
```

### `changedFields(): string[]`
Names of the columns with pending changes. Rails `changed`.
```ts
user.changedFields()   // ['name']
```

### `changes: Record<string, [was, is]>` (getter)
Map of every pending change to a `[was, is]` tuple. Rails `changes`.
```ts
user.changes   // { name: ['Alice', 'Alicia'] }
```

### `previousChanges: Record<string, [was, is]>` (getter)
The `changes` as they were just **before** the last successful save. Rails `previous_changes`.
```ts
await user.save()
user.previousChanges   // { name: ['Alice', 'Alicia'] }
```

### `restoreAttributes(): void`
Revert all pending changes back to their original values. Rails `restore_attributes`.
```ts
user.name = 'Typo'
user.restoreAttributes()   // name back to 'Alice', nothing dirty
```

### `<column>Changed()` · `<column>Was()` · `<column>Change()`
Per-attribute dirty helpers synthesized on the underlying **column** name. Rails `name_changed?` / `name_was` / `name_change`.
```ts
user.name = 'Alicia'
user.nameChanged()   // true
user.nameWas()       // 'Alice'
user.nameChange()    // ['Alice', 'Alicia']
```

## Validation & errors

### `validate(): Promise<boolean>`
Run all validations (Attr-level, `@validate`/`@serverValidate`, state-transition legality, schema-implicit rules), populating `errors`; returns true when valid. Rails `validate` / `valid?`.
```ts
if (!(await product.validate())) console.log(product.errors.all())
```

### `isValid(): Promise<boolean>` · `isInvalid(): Promise<boolean>`
Convenience wrappers over `validate()`. Rails `valid?` / `invalid?`.
```ts
await order.isValid()     // true / false
await order.isInvalid()   // inverse
```

### `errors: ValidationErrors`
Validation errors collected by the last `validate()`/`save()`. Key methods: `on(field)`, `all()`, `full()`, `isEmpty()`, `any()`, `count()`, `add(field, msg)`. Rails `errors`.
```ts
await product.save()
product.errors.on('stock')   // ['stock cannot be negative']
product.errors.full()        // ['stock stock cannot be negative']
product.errors.any()         // true
```

## State machine

For an `Attr.state` column (e.g. `status` with events `submit` / `approve`).

### `can(event: string): boolean`  ·  `can<Event>(): boolean`
Whether `event` can fire from the current state (checks `from` set + guard); `can<Event>()` is the synthesized sugar. Rails-ish `may_<event>?` (state_machine gem).
```ts
loan.can('submit')   // true
loan.canSubmit()     // synthesized equivalent
```

### `advance(event: string): Promise<boolean>`
Fire `event` **and** persist in one call; illegal/unknown events return `false` with a reason on `errors` and no DB round-trip.
```ts
const ok = await loan.advance('submit')   // assigns target state + save(); → true
```

### `<event>()` · `is<Label>()` · `to<Label>()` · `<attr>Formatted(locale?)`
Synthesized per state/enum/money Attr: `<event>()` assigns the target state **without** saving; `is<Label>()` is a state/enum predicate; `to<Label>()` assigns and returns the record; `<attr>Formatted()` renders an `Attr.money` value.
```ts
loan.submit()                    // assign 'submitted', not saved
loan.isSubmitted()               // true
order.toShipped()                // assign 'shipped', returns order
product.priceFormatted('en-US')  // '$49.99'
```

## Associations

Accessors are synthesized from `belongsTo` / `hasOne` / `hasMany` / `habtm` markers.

### belongsTo / hasOne accessor → `Promise<T | null>`
Lazily resolves the single related record. Rails singular association reader.
```ts
const order = await Order.find(1)
const buyer = await order.user   // belongsTo → User | null
```

### hasMany / habtm accessor → `Relation<T>`
Returns a scoped, awaitable relation you can further chain. Rails collection association.
```ts
const items = await order.lineItems         // await → LineItem[]
const count = await order.lineItems.count() // or chain the builder
const tags  = await product.tags            // habtm → Tag[]
```

### association-scoped `.create(attrs)` / `.build(attrs)`
On a `hasMany` relation, `create` persists and `build` returns an unsaved child — both inherit the owner's foreign key (and polymorphic type). Rails `owner.things.create` / `.build`.
```ts
const line  = await order.lineItems.create({ productId: 3, qty: 2 })   // orderId set automatically
const draft = order.lineItems.build({ productId: 5 })                  // unsaved child
```

## Attachments

For `hasOneAttachment` / `hasManyAttachments` declarations. Each requires a persisted record and a `ready` `Asset`.

### `attach(name: string, assetId: number): Promise<void>`
Attach an asset to a named slot; enforces `accepts`/`maxSize`/`max` and replaces the existing one for a `hasOne` slot. Rails `record.name.attach`.
```ts
await product.attach('coverImage', asset.id)
```

### `detach(name: string, assetId?: number): Promise<void>`
Remove attachment(s) from a slot — one specific asset, or all when `assetId` is omitted. Rails `record.name.purge` / `detach`.
```ts
await product.detach('coverImage')   // hasOne: remove the one
await product.detach('gallery', 3)   // hasMany: remove asset 3 only
```

### `replace(name: string, assetId: number): Promise<void>`
Atomic detach-then-attach for a slot, wrapped in a transaction.
```ts
await product.replace('coverImage', newAsset.id)
```

### `reorder(name: string, orderedAssetIds: number[]): Promise<void>`
Set the `position` of each asset in a `hasManyAttachments` slot; the id list must be a complete, duplicate-free permutation of the currently attached assets.
```ts
await product.reorder('gallery', [3, 1, 2])
```
