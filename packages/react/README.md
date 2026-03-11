# @active-drizzle/react

React Query hooks for [ActiveDrizzle](https://danieth.github.io/active-drizzle/) controllers. Generated at build time — typed queries, mutations, form configs, and error parsing from your model + controller definitions.

```tsx
const ctrl = CampaignController.use({ teamId })

const { data } = ctrl.index({ scopes: ['active'] })
const launch = ctrl.mutateLaunch()

return data?.items.map(c => (
  <div key={c.id}>
    {c.name} — {c.status}
    {c.isEditable() && <button onClick={() => launch.mutate(c.id)}>Launch</button>}
  </div>
))
```

**[Full documentation →](https://danieth.github.io/active-drizzle/react/overview)**

## Install

```bash
npm install @active-drizzle/react @active-drizzle/core @active-drizzle/controller
```

## Part of ActiveDrizzle

| Package | What it is |
|---------|-----------|
| @active-drizzle/core | Models, associations, hooks, Attr, codegen, Vite plugin |
| @active-drizzle/controller | CRUD controllers, oRPC, REST, multi-tenant |
| **@active-drizzle/react** | React Query hooks, form integration, error parsing |

MIT — Daniel Ackerman
