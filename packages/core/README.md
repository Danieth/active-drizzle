# @active-drizzle/core

Rails-style ActiveRecord for [Drizzle ORM](https://orm.drizzle.team). Associations, lifecycle hooks, dirty tracking, enum transforms, scopes, STI, and full TypeScript codegen via a Vite plugin.

```ts
@model('campaigns')
export class Campaign extends ApplicationRecord {
  static team   = belongsTo()
  static status = Attr.enum({ draft: 0, active: 1, paused: 2 } as const)

  @scope static active() { return this.where({ status: 1 }) }
  @pure isEditable() { return ['draft', 'paused'].includes(this.status) }
}
```

**[Full documentation →](https://danieth.github.io/active-drizzle/)**

## Install

```bash
npm install @active-drizzle/core drizzle-orm
```

## Part of ActiveDrizzle

| Package | What it is |
|---------|-----------|
| **@active-drizzle/core** | Models, associations, hooks, Attr, codegen, Vite plugin |
| @active-drizzle/controller | CRUD controllers, oRPC, REST, multi-tenant |
| @active-drizzle/react | React Query hooks, form integration, error parsing |

MIT — Daniel Ackerman
