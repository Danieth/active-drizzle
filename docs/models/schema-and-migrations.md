# Schema & Migrations

**Drizzle owns your database. ActiveDrizzle owns your behavior.**

This is a deliberate design decision, not a missing feature. ActiveDrizzle never generates DDL, never writes migrations, and never touches your database structure. It **reads** your Drizzle schema and layers ActiveRecord behavior (attributes, associations, validations, callbacks, state machines) on top.

| Concern | Owned by |
|---|---|
| Table + column definitions (`pgTable`) | **Drizzle** — your `schema.ts` |
| Migrations (generate / run / roll back) | **Drizzle Kit** — `drizzle-kit` |
| Attributes, associations, validations, callbacks, scopes, state machines | **ActiveDrizzle** — your `*.model.ts` |
| Generated types + client runtime | **ActiveDrizzle codegen** |

::: tip Why this is a feature
Rails infers almost everything implicitly from the database. Here the schema is an explicit, version-controlled, fully-typed TypeScript file you already own — and you keep Drizzle's entire migration toolchain instead of inheriting a second, competing one.
:::

## The workflow

Adding a column is two steps plus automatic codegen:

**1. Change the Drizzle schema** — the source of truth.

```ts
// src/db/schema.ts
export const users = pgTable('users', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull(),
  bio:   text('bio'),          // ← new column
})
```

**2. Generate and run the migration with Drizzle Kit.**

```bash
npx drizzle-kit generate   # writes a SQL migration from the schema diff
npx drizzle-kit migrate    # applies it
```

**3. (Optional) declare an `Attr` on the model** — only if the column needs a transform, validation, or presentational metadata. Plain columns need no declaration at all; they're already typed and readable.

```ts
// src/models/User.model.ts
@model('users')
export class User extends ApplicationRecord {
  static bio = Attr.string({ label: 'Biography' })   // optional
}
```

Codegen picks the change up automatically — the Vite plugin regenerates on save, so `user.bio` is typed immediately. See [Codegen & CLI](/codegen/vite-plugin).

## Drift is a build error, not a runtime surprise

Because codegen reads the real schema, a model referencing a column that doesn't exist fails at build time with a pointer to the file — you find out when you save, not in production.

```
[active-drizzle] ERROR src/models/User.model.ts: column "bo" not found on table "users"
  → did you mean "bio"?
```

That check is what makes the two-file split safe: the schema and the model can't silently disagree.

## Drizzle documentation

Everything about declaring tables and running migrations lives in Drizzle's own docs:

- [Drizzle ORM — overview](https://orm.drizzle.team/docs/overview)
- [Schema declaration (`pgTable`, columns, indexes)](https://orm.drizzle.team/docs/sql-schema-declaration)
- [Drizzle Kit — migrations](https://orm.drizzle.team/docs/kit-overview)

## What ActiveDrizzle needs from your schema

Two small requirements:

1. **Export your tables**, and pass the schema object to `boot()` — table lookup goes through the export name, so `@model('users')` resolves `schema.users`. See [Installation & Boot](/guide/installation).
2. **Declare Drizzle `relations()`** for any association you want to eager-load with `.includes()` — that's the relational query API Drizzle uses to build the join.

```ts
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}))
```

Everything else — foreign keys, indexes, constraints, enums, defaults — is plain Drizzle, exactly as their docs describe.
