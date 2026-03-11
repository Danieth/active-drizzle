# Single Table Inheritance (STI)

STI stores multiple model types in one table, using a discriminator column (usually `type`) to identify which subclass a row belongs to.

## Schema setup

The parent table needs a `type` column. All subclass-specific columns live on the same table (nullable for rows that don't use them).

```ts
// schema.ts
import { pgTable, integer, text, boolean } from 'drizzle-orm/pg-core'

export const products = pgTable('products', {
  id:          integer('id').primaryKey().generatedAlwaysAsIdentity(),
  type:        text('type').notNull(),          // discriminator — 'Product' | 'DigitalProduct' | 'PhysicalProduct'
  name:        text('name').notNull(),
  priceCents:  integer('price_cents').notNull().default(0),

  // Physical-only columns (null for digital products)
  weightGrams: integer('weight_grams'),
  shippable:   boolean('shippable').default(false),

  // Digital-only columns (null for physical products)
  downloadUrl: text('download_url'),
})
```

## Parent model

The parent class represents the whole table and queries across all types:

```ts
// models/Product.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'
import { Attr }              from 'active-drizzle'

@model('products')
export class Product extends ApplicationRecord {
  static priceCents = Attr.new({
    get: (v: number) => v / 100,
    set: (v: number) => Math.round(v * 100),
  })
}
```

## Subclass models

Each subclass:
1. Extends the parent model class (not `ApplicationRecord` directly)
2. Sets `static stiType` to the string stored in the `type` column

```ts
// models/DigitalProduct.model.ts
import { model } from 'active-drizzle'
import { Product } from './Product.model.js'

@model('products')
export class DigitalProduct extends Product {
  static stiType = 'DigitalProduct'
  // Queries automatically get WHERE type = 'DigitalProduct'
}
```

```ts
// models/PhysicalProduct.model.ts
import { model } from 'active-drizzle'
import { Product } from './Product.model.js'

@model('products')
export class PhysicalProduct extends Product {
  static stiType = 'PhysicalProduct'
}
```

## How queries work

Each subclass silently adds a `WHERE type = '...'` clause:

```ts
// These each query from the same 'products' table:

const all      = await Product.all()            // all types
const digital  = await DigitalProduct.all()     // WHERE type = 'DigitalProduct'
const physical = await PhysicalProduct.all()    // WHERE type = 'PhysicalProduct'
```

## Creating subclass records

When you `create` via a subclass, the `type` column is automatically set:

```ts
const d = await DigitalProduct.create({
  name: 'TypeScript Handbook PDF',
  priceCents: 29.99,
  downloadUrl: 'https://cdn.example.com/ts-handbook.pdf',
})

d.type   // → 'DigitalProduct'  (set automatically, no need to pass it)
```

## Loading from the parent table

When you load records via the parent class, ActiveDrizzle instantiates the correct subclass:

```ts
const products = await Product.all()

products.forEach(p => {
  if (p instanceof DigitalProduct) {
    console.log('digital:', p.downloadUrl)
  } else if (p instanceof PhysicalProduct) {
    console.log('physical weight:', p.weightGrams)
  }
})
```

## Custom discriminator column

If your type column is named something other than `type`, set `stiTypeColumn`:

```ts
// schema.ts
export const vehicles = pgTable('vehicles', {
  id:      integer('id').primaryKey().generatedAlwaysAsIdentity(),
  kind:    text('kind').notNull(),   // 'Car' | 'Truck' | 'Motorcycle'
  name:    text('name').notNull(),
})
```

```ts
// models/Vehicle.model.ts
@model('vehicles')
export class Vehicle extends ApplicationRecord {
  static stiTypeColumn = 'kind'   // ← override here on the parent
}
```

```ts
// models/Car.model.ts
@model('vehicles')
export class Car extends Vehicle {
  static stiType = 'Car'
  // queries: WHERE kind = 'Car'
}
```

## STI with scopes and associations

Subclasses inherit all parent scopes and associations. You can add subclass-specific ones too:

```ts
// models/DigitalProduct.model.ts
@model('products')
export class DigitalProduct extends Product {
  static stiType = 'DigitalProduct'

  // Scope only on digital products
  static withDownload() {
    return this.where({ downloadUrl: sql`IS NOT NULL` })
  }
}
```

## Full example

```ts
// schema.ts
export const vehicles = pgTable('vehicles', {
  id:          integer('id').primaryKey().generatedAlwaysAsIdentity(),
  type:        text('type').notNull(),
  make:        text('make').notNull(),
  model:       text('model').notNull(),
  doors:       integer('doors'),         // cars only
  payloadTons: integer('payload_tons'),  // trucks only
})
```

```ts
// models/Vehicle.model.ts
@model('vehicles')
export class Vehicle extends ApplicationRecord {}

// models/Car.model.ts
@model('vehicles')
export class Car extends Vehicle {
  static stiType = 'Car'

  static sedans() {
    return this.where({ doors: 4 })
  }
}

// models/Truck.model.ts
@model('vehicles')
export class Truck extends Vehicle {
  static stiType = 'Truck'
}
```

```ts
const car   = await Car.create({ make: 'Toyota', model: 'Camry', doors: 4 })
const truck = await Truck.create({ make: 'Ford', model: 'F-150', payloadTons: 1 })

const allVehicles = await Vehicle.all()      // [Car instance, Truck instance]
const cars        = await Car.sedans().load()
```
