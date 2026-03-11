# Transactions

## `transaction(callback)`

Wrap any async work in a database transaction. On error, the transaction is automatically rolled back:

```ts
import { transaction } from 'active-drizzle'

await transaction(async () => {
  const order = await Order.create({ userId: 1, totalCents: 9999 })
  await Inventory.where({ productId: 1 }).updateAll({ reserved: sql`reserved + 1` })
  // If any line throws, the entire transaction rolls back
})
```

Or call it as a static method on any model (convenience alias):

```ts
await Order.transaction(async () => {
  // ...
})
```

## `@afterCommit` hook

Code inside an `afterCommit` hook runs **after** the outermost transaction successfully commits — it is never called on rollback:

```ts
import { afterCommit } from 'active-drizzle'

@model('orders')
export class Order extends ApplicationRecord {
  @afterCommit()
  async sendConfirmationEmail() {
    await EmailService.send(this.userId, 'order-confirmed')
  }
}
```

```ts
await transaction(async () => {
  const order = await Order.create({ userId: 1, totalCents: 9999 })
  // sendConfirmationEmail is queued but NOT yet called
})
// ← sendConfirmationEmail fires here, after commit
```

::: warning
`afterCommit` is only meaningful inside a `transaction()` call. If you call `order.save()` without an explicit transaction, `afterCommit` hooks fire immediately after the implicit statement-level transaction.
:::

## Nested transactions

ActiveDrizzle supports calling `transaction()` inside another `transaction()`. The inner transaction shares the same connection and does not create a savepoint — it merges into the outer transaction.

```ts
await transaction(async () => {
  await User.create({ email: 'alice@example.com', name: 'Alice' })

  await transaction(async () => {
    // This runs inside the same outer transaction
    await Profile.create({ userId: 1, bio: '...' })
  })
  // afterCommit hooks from the inner transaction are deferred
  // until the outermost transaction commits
})
// Both records committed together; all afterCommit hooks fire now
```

A `console.warn` is emitted in non-test environments when nesting is detected, to help you spot unintentional nesting.

## `@transactional` decorator

Automatically wraps a method in a transaction:

```ts
import { transactional } from 'active-drizzle'

@model('orders')
export class Order extends ApplicationRecord {
  @transactional
  async placeOrder(items: { productId: number; qty: number }[]) {
    // Everything here runs in a transaction
    const order = await Order.create({ userId: this.userId, totalCents: 0 })
    let total = 0

    for (const item of items) {
      const product = await Product.find(item.productId)
      await LineItem.create({ orderId: order.id, productId: item.productId, qty: item.qty })
      total += product.priceCents * item.qty
    }

    await order.update({ totalCents: total })
    return order
  }
}
```

```ts
const order = new Order({ userId: currentUser.id })
const placed = await order.placeOrder([
  { productId: 1, qty: 2 },
  { productId: 3, qty: 1 },
])
// All inserts + final update happen atomically
```

## `AbortChain`

Throw `AbortChain` inside a hook or callback to silently roll back without raising an error visible to callers:

```ts
import { AbortChain } from 'active-drizzle'

@model('orders')
export class Order extends ApplicationRecord {
  @beforeSave()
  checkInventory() {
    if (outOfStock) throw new AbortChain()
    // save() returns false — no exception propagated
  }
}

const result = await order.save()   // → false (not an exception)
```

## Error propagation

Any exception other than `AbortChain` propagates normally and rolls back the transaction:

```ts
try {
  await transaction(async () => {
    await Order.create({ userId: 1, totalCents: 0 })
    throw new Error('payment failed')
  })
} catch (e) {
  // Transaction was rolled back
  // Order was NOT inserted
}
```
