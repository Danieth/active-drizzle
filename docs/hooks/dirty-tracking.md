# Dirty Tracking

ActiveDrizzle tracks every attribute change from the moment a record is loaded or created. You can inspect what changed, what the previous value was, and whether anything changed at all.

## Setup

```ts
// schema.ts
export const products = pgTable('products', {
  id:         integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name:       text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  status:     integer('status').notNull().default(0),
})
```

```ts
// models/Product.model.ts
@model('products')
export class Product extends ApplicationRecord {
  static status = Attr.enum({ draft: 0, published: 1, archived: 2 } as const)
}
```

## `isChanged()` / `hasChanges()`

```ts
const product = await Product.find(1)
product.isChanged()   // → false

product.name = 'New Name'
product.isChanged()   // → true
```

## `changedAttributes()`

Returns an object of `{ field: [previous, current] }` pairs:

```ts
product.name = 'New Name'
product.priceCents = 2999

product.changedAttributes()
// → { name: ['Old Name', 'New Name'], priceCents: [1999, 2999] }
```

## `<field>Changed()` — per-field dirty check

Every column gets a corresponding `<field>Changed()` method:

```ts
product.nameChanged()       // → true
product.priceChanged()      // → false  (priceCents changed, but priceChanged checks priceCents)
product.statusChanged()     // → false
```

For `Attr.enum` fields, the check is based on the **label** (string):

```ts
product.status = 'published'
product.statusChanged()   // → true
product.statusWas()       // → 'draft'  (previous label)
```

## `<field>Was()` — previous value

```ts
product.name = 'New Name'
product.nameWas()    // → 'Old Name'  (value before this change)
```

## `previousChanges()` — what changed in the last save

After calling `save()`, the `_previousChanges` captures what was just changed:

```ts
product.name = 'New Name'
await product.save()

product.isChanged()          // → false (changes cleared)
product.previousChanges()    // → { name: ['Old Name', 'New Name'] }
product.nameChanged()        // → false (no current unsaved change)
```

Useful in `@afterSave` hooks to know what just happened:

```ts
@afterSave()
handleStatusChange() {
  const changes = this.previousChanges()
  if ('status' in changes) {
    const [from, to] = changes.status
    AuditLog.create({ model: 'Product', field: 'status', from, to })
  }
}
```

## `wasChanged(field)` — check previous save

```ts
product.name = 'New Name'
await product.save()

product.wasChanged('name')   // → true (name changed in last save)
product.wasChanged('price')  // → false
```

## Dirty tracking in hooks

```ts
@beforeSave('priceChanged')   // only runs if priceCents changed
async notifyPriceChange() {
  await PriceAlert.trigger({
    productId: this.id,
    oldPrice:  this.priceWas(),
    newPrice:  this.priceCents,
  })
}

@afterUpdate('statusChanged')
async logStatusTransition() {
  const { status: [from, to] } = this.previousChanges()
  await AuditLog.create({ entity: 'Product', id: this.id, from, to })
}
```

## New records and dirty tracking

For new records, `<field>Was()` returns `undefined` (there is no previous value):

```ts
const p = new Product({ name: 'Widget' })
p.nameChanged()   // → true (it was set from undefined)
p.nameWas()       // → undefined
```

After `save()` on a new record:

```ts
await p.save()
p.isNewRecord     // → false
p.isChanged()     // → false
p.previousChanges()   // → { name: [undefined, 'Widget'], ... }
```
