# CRUD Actions

`@crud` wires five default actions: `index`, `get`, `create`, `update`, and `destroy`. Each is configurable through the `@crud` options object, and any of them can be overridden by defining a method with the same name on the controller class.

## `index` — Collection Query

```ts
@crud(Campaign, {
  index: {
    // Named scopes the client can request (from @scope decorators on the model)
    scopes: ['active', 'draft', 'paused', 'completed', 'upcoming'],

    // Applied if the client doesn't specify scopes
    defaultScopes: ['active'],

    // Parameter-driven scopes — ?search=foo → Campaign.search('foo')
    paramScopes: {
      search: { type: 'string' },
      minBudget: { type: 'number' },
    },

    // Columns the client may sort by
    sortable: ['createdAt', 'name', 'budget', 'startDate'],

    // Applied if the client doesn't specify sort
    defaultSort: { field: 'createdAt', dir: 'desc' },

    // Simple equality filters — ?status=active
    filterable: ['status', 'creatorId'],

    // Always eager-loaded
    include: ['creator'],

    perPage:    25,
    maxPerPage: 100,
  },
})
```

### Request Parameters

The generated oRPC Zod schema accepts:

```ts
{
  scopes?:  string[]                         // ['active', 'draft']
  sort?:    { field: string; dir: 'asc' | 'desc' }
  filters?: Record<string, unknown>
  search?:  string                           // for paramScopes.search
  page?:    number                           // default 0
  perPage?: number                           // capped to maxPerPage
}
```

### Response Shape

```ts
{
  data:       CampaignAttrs[]
  pagination: {
    page:       number
    perPage:    number
    totalCount: number
    hasMore:    boolean
  }
}
```

### Overriding `index`

```ts
@controller()
@crud(Campaign, { index: { /* ... */ } })
export class CampaignController extends ActiveController<AppContext> {
  async index() {
    // this.relation is already scoped by @scope(teamId)
    const items = await this.relation
      .where({ status: 'active' })
      .includes('creator')
      .order('createdAt', 'desc')
      .limit(25)
      .load()
    return { data: items, pagination: { totalCount: items.length } }
  }
}
```

---

## `get` — Single Record

```ts
get: {
  // Eager-load for the detail view — can load more than index
  include: ['creator', 'team', 'assets'],
}
```

Fetches by `:id`, scoped to the current relation (meaning a user from another team cannot access a record that belongs to a different team). Throws `NOT_FOUND` if the record doesn't exist within the scope.

### Overriding `get`

```ts
async get() {
  const campaign = await this.relation
    .where({ id: this.params.id })
    .includes({ creator: true, team: { include: ['plan'] } })
    .firstBang()
  return campaign
}
```

---

## `create` — Insert a New Record

```ts
create: {
  // Fields the client is allowed to write
  permit: ['name', 'budget', 'status', 'startDate', 'assetIds'],

  // Fields injected from context (client cannot override)
  autoSet: {
    creatorId: (ctx) => ctx.user.id,
    teamId:    (ctx) => ctx.teamId,
  },
}
```

The `create` action:
1. Filters `data` to `permit`-listed fields only (everything else is silently dropped)
2. Merges `autoSet` fields (overwriting anything the client sent)
3. Calls `Model.create(filtered)` — this runs all `@validate` and `@serverValidate` hooks

On success: returns the created record.
On validation failure: throws `UNPROCESSABLE_ENTITY` with `{ fields: { fieldName: ['error'] } }`.

### Overriding `create`

```ts
async create() {
  const { data } = this.params
  const campaign = await Campaign.create({
    ...data,
    teamId:    this.params.teamId,
    creatorId: this.context.user.id,
  })
  await CampaignSearch.index(campaign)
  return campaign
}
```

---

## `update` — Partial Update

```ts
update: {
  permit: ['name', 'budget', 'status', 'startDate'],
  // Update permit can differ from create permit — common to omit sensitive fields
}
```

The `update` action:
1. Loads the record by `:id` from the scoped relation
2. Filters `data` to `permit`-listed fields
3. Calls `record.update(filtered)` — runs validations, updates only changed columns

On success: returns the updated record.
On validation failure: `UNPROCESSABLE_ENTITY`.
If not found: `NOT_FOUND`.

### Overriding `update`

```ts
async update() {
  const campaign = await this.relation.where({ id: this.params.id }).firstBang()
  const permitted = pick(this.params.data, ['name', 'budget', 'startDate'])
  await campaign.update(permitted)
  await CampaignSearch.reindex(campaign)
  return campaign
}
```

---

## `destroy` — Delete a Record

No configuration — `destroy` has no options in the `@crud` config.

The `destroy` action:
1. Loads the record by `:id`
2. Calls `record.destroy()` — runs `@beforeDestroy` and `@afterDestroy` hooks

Returns `{ success: true }` on completion.

### Overriding `destroy`

```ts
async destroy() {
  const campaign = await this.relation.where({ id: this.params.id }).firstBang()
  if (!campaign.isDraft()) throw new BadRequest('Only draft campaigns can be deleted')
  await campaign.destroy()
  return { success: true }
}
```

---

## Disabling Individual Actions

Pass `false` to disable a specific action:

```ts
@crud(Campaign, {
  index:   { scopes: ['active'] },
  get:     { include: ['creator'] },
  create:  { permit: ['name'] },
  update:  false,   // no PATCH route generated
  destroy: false,   // no DELETE route generated
})
```

---

## The `permit` Security Model

`permit` is a whitelist — if a field isn't listed, it's **silently dropped**. This means:

- `id` is never writable (always blocked, even if listed)
- `createdAt` / `updatedAt` are never writable (always blocked)
- Scope fields (`teamId`, `userId` from `@scope`) are never writable from the request body
- Any extra fields the client sends are discarded without error

The safety model is: the server defines what's writable, period. Clients can send anything — only `permit`-listed fields reach the model.

---

## Accessing Scope Params in Actions

Scope parameters are available in `this.params`:

```ts
async create() {
  const campaign = await Campaign.create({
    ...this.params.data,
    teamId: this.params.teamId,   // from @scope('teamId')
  })
  return campaign
}
```

The scope is also pre-applied to `this.relation` — so any query through `this.relation` is automatically filtered to the correct tenant without any manual `WHERE` clauses:

```ts
async index() {
  // This is already WHERE team_id = :teamId
  const items = await this.relation.order('createdAt', 'desc').load()
  return { data: items }
}
```
