# Defining Models

Every model is a class that extends `ApplicationRecord` and is decorated with `@model('table_name')`.

## Minimal model

```ts
// schema.ts
import { pgTable, integer, text } from 'drizzle-orm/pg-core'

export const articles = pgTable('articles', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: text('title').notNull(),
  slug:  text('slug').notNull(),
})
```

```ts
// models/Article.model.ts
import { ApplicationRecord } from 'active-drizzle'
import { model }             from 'active-drizzle'

@model('articles')
export class Article extends ApplicationRecord {}
```

That's enough for full CRUD:

```ts
const article = await Article.create({ title: 'Hello', slug: 'hello' })
const found   = await Article.find(article.id)
await article.update({ title: 'Hello World' })
await article.destroy()
```

## The `@model` decorator

`@model('table_name')` does two things:

1. Binds the class to its database table.
2. Registers it in the global `MODEL_REGISTRY` — used for association resolution and STI.

The table name must match the key in your schema file exactly (as Drizzle uses it for `db.query.<table>`).

## Registering all models

You must import every model at startup so the decorators run and the registry is populated:

```ts
// models/index.ts
export { User }    from './User.model.js'
export { Post }    from './Post.model.js'
export { Comment } from './Comment.model.js'
```

```ts
// app.ts
import { boot } from 'active-drizzle'
import * as schema from './schema.js'
import './models/index.js'   // ← side-effect import; runs all @model decorators

boot(db, schema)
```

## Static properties

Any `static` property on the class that is **not** a function, association marker, or Attr config is treated as a plain class constant:

```ts
@model('products')
export class Product extends ApplicationRecord {
  static readonly TAX_RATE = 0.08
}
```

Static methods become scopes or computed properties — see [Scopes](/querying/scopes).
