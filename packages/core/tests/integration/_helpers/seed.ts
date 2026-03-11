/**
 * Seed helpers — create baseline data for integration tests.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { schema } from './schema.js'
import { User, Product, DigitalProduct, Tag, Order, LineItem, Review } from './models.js'

type Db = NodePgDatabase<typeof schema>

export async function seedUsers(_db: Db) {
  const alice = await User.create({ email: 'alice@example.com', name: 'Alice', role: 'admin' })
  const bob   = await User.create({ email: 'bob@example.com',   name: 'Bob',   role: 'customer' })
  const carol = await User.create({ email: 'carol@example.com', name: 'Carol', role: 'customer' })
  return { alice, bob, carol }
}

export async function seedProducts(_db: Db) {
  const tshirt = await Product.create({
    name: 'Classic T-Shirt',
    priceInCents: 1999,
    stock: 100,
    isActive: true,
    metadata: JSON.stringify({ weight: 0.2, dims: '30x40cm' }),
  })

  const hoodie = await Product.create({
    name: 'Premium Hoodie',
    priceInCents: 5999,
    stock: 50,
    isActive: true,
    metadata: JSON.stringify({ weight: 0.6, dims: '45x60cm' }),
  })

  const ebook = await DigitalProduct.create({
    name: 'TypeScript Mastery',
    priceInCents: 1499,
    stock: 9999,
    isActive: true,
    downloadUrl: 'https://cdn.example.com/ts-mastery.pdf',
  })

  const discontinued = await Product.create({
    name: 'Old Model',
    priceInCents: 999,
    stock: 0,
    isActive: false,
  })

  return { tshirt, hoodie, ebook, discontinued }
}

export async function seedTags(_db: Db) {
  const apparel     = await Tag.create({ name: 'apparel' })
  const digital     = await Tag.create({ name: 'digital' })
  const bestseller  = await Tag.create({ name: 'bestseller' })
  return { apparel, digital, bestseller }
}

export async function seedProductTags(
  db: Db,
  products: Record<string, any>,
  tags: Record<string, any>,
) {
  await db.insert(schema.products_tags).values([
    { productId: products.tshirt.id,  tagId: tags.apparel.id },
    { productId: products.tshirt.id,  tagId: tags.bestseller.id },
    { productId: products.hoodie.id,  tagId: tags.apparel.id },
    { productId: products.ebook.id,   tagId: tags.digital.id },
    { productId: products.ebook.id,   tagId: tags.bestseller.id },
  ])
}

export async function seedOrders(_db: Db, users: Record<string, any>, products: Record<string, any>) {
  // Order with line items via acceptsNestedAttributesFor
  const order1 = new (Order as any)({
    userId:         users.bob.id,
    status:         0,
    totalInCents:   (products.tshirt._attributes.priceInCents * 2) + products.hoodie._attributes.priceInCents,
    lineItemsAttributes: [
      { productId: products.tshirt.id, name: products.tshirt._attributes.name, priceInCents: products.tshirt._attributes.priceInCents, qty: 2 },
      { productId: products.hoodie.id, name: products.hoodie._attributes.name, priceInCents: products.hoodie._attributes.priceInCents, qty: 1 },
    ],
  })
  await order1.save()

  const order2 = await Order.create({
    userId:       users.carol.id,
    status:       1,
    totalInCents: products.ebook._attributes.priceInCents,
  })

  // Individual line item for order2
  await LineItem.create({
    orderId:      order2.id,
    productId:    products.ebook.id,
    name:         products.ebook._attributes.name,
    priceInCents: products.ebook._attributes.priceInCents,
    qty:          1,
  })

  return { order1, order2 }
}

export async function seedReviews(_db: Db, users: Record<string, any>, products: Record<string, any>) {
  const r1 = await Review.create({
    reviewableType: 'Product',
    reviewableId:   products.tshirt.id,
    userId:         users.bob.id,
    rating:         5,
    body:           'Great quality, very comfortable!',
  })

  const r2 = await Review.create({
    reviewableType: 'Product',
    reviewableId:   products.ebook.id,
    userId:         users.carol.id,
    rating:         4,
    body:           'Excellent content, could use more examples.',
  })

  return { r1, r2 }
}

/** Seed everything and return it all */
export async function seedAll(db: Db) {
  const users    = await seedUsers(db)
  const products = await seedProducts(db)
  const tags     = await seedTags(db)
  await seedProductTags(db, products, tags)
  const orders   = await seedOrders(db, users, products)
  const reviews  = await seedReviews(db, users, products)
  return { users, products, tags, orders, reviews }
}
