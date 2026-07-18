# Console

active-drizzle ships a Rails-console-style REPL. Every expression that returns a Promise or a `Relation` is automatically awaited, so you can run queries interactively without typing `await`.

```
app> User.all()
[ User { id: 1, name: 'Alice' }, User { id: 2, name: 'Bob' } ]

app> User.where({ active: true }).order('name')
[ User { id: 1, name: 'Alice' } ]

app> User.find(1)
User { id: 1, name: 'Alice' }

app> User.count()
42
```

## Setup

Create `bin/console.ts` in your project:

```ts
import { createConsole } from '@active-drizzle/core'
import { db } from '../db/index.js'
import * as schema from '../db/schema.js'
import { User } from '../models/User.model.js'
import { Campaign } from '../models/Campaign.model.js'

createConsole({
  db,
  schema,
  models: { User, Campaign },
})
```

Then add a script to `package.json`:

```json
{
  "scripts": {
    "console": "tsx bin/console.ts"
  }
}
```

And run it:

```bash
npm run console
```

## Options

| Option | Type | Description |
| --- | --- | --- |
| `db` | Drizzle database | Your Drizzle instance. `boot()` is called for you. |
| `schema` | object | Your Drizzle schema module. |
| `models` | object | Model classes to expose as globals in the REPL. |
| `prompt` | string | Prompt string. Defaults to `app> `. |
| `context` | object | Extra values (helpers, services) to expose in the REPL. |

## How auto-await works

`Relation` is thenable — it has a `.then()` that dispatches the query. The console's custom eval checks each result: if it's a thenable, it awaits it before printing. That means chains like `User.where({ active: true }).order('name')` execute immediately at the prompt, exactly like `rails c`.

If you want the query result as an explicit Promise inside a script (rather than the console), use `.all()`:

```ts
const users = await User.where({ active: true }).all()
```

## Multi-step sessions

Because assignments work like normal Node.js REPL assignments, you can hold onto records and mutate them:

```
app> u = User.find(1)
app> u.name = 'Alice Cooper'
app> u.save()
true
```

Note the standard Node.js REPL caveats: `const`/`let` declarations return `undefined` (the value is still assigned), and you need `()` on method calls — unlike Ruby, JavaScript doesn't call methods implicitly.
