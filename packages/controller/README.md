# @active-drizzle/controller

Rails-style controllers for [ActiveDrizzle](https://danieth.github.io/active-drizzle/). Declare CRUD, mutations, and actions with decorators — get oRPC procedures, Zod validation, and REST routes automatically.

```ts
@controller('/campaigns')
@crud(Campaign, {
  scopeBy: (ctrl) => ({ organizationId: ctrl.state.org.id }),
  index:  { scopes: ['active'], sortable: ['createdAt'], include: ['creator'] },
  create: { permit: ['name', 'budget'], autoSet: { creatorId: ctx => ctx.userId } },
})
@scope('teamId')
export class CampaignController extends OrgController {
  @mutation()
  async launch(campaign: Campaign) {
    campaign.status = 'active'
    return campaign.save()
  }
}
```

**[Full documentation →](https://danieth.github.io/active-drizzle/controllers/overview)**

## Install

```bash
npm install @active-drizzle/controller @active-drizzle/core
```

## Part of ActiveDrizzle

| Package | What it is |
|---------|-----------|
| @active-drizzle/core | Models, associations, hooks, Attr, codegen, Vite plugin |
| **@active-drizzle/controller** | CRUD controllers, oRPC, REST, multi-tenant |
| @active-drizzle/react | React Query hooks, form integration, error parsing |

MIT — Daniel Ackerman
