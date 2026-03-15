/**
 * Realistic e-commerce schema for integration tests.
 * Variable names match table names (snake_case) so db.query keys align perfectly.
 */
import {
  pgTable, serial, varchar, integer, boolean,
  text, timestamp, primaryKey,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const users = pgTable('users', {
  id:        serial('id').primaryKey(),
  email:     varchar('email', { length: 255 }).notNull(),
  name:      varchar('name', { length: 255 }),
  role:      varchar('role', { length: 50 }).notNull().default('customer'),
  createdAt: timestamp('created_at').defaultNow(),
})

export const assets = pgTable('assets', {
  id:          serial('id').primaryKey(),
  key:         varchar('key', { length: 255 }).notNull(),
  filename:    varchar('filename', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  byteSize:    integer('byte_size').notNull(),
  checksum:    varchar('checksum', { length: 255 }).notNull(),
  status:      varchar('status', { length: 50 }).notNull().default('pending'),
  access:      varchar('access', { length: 50 }).notNull().default('private'),
  createdAt:   timestamp('created_at').defaultNow(),
})

export const attachments = pgTable('attachments', {
  id:             serial('id').primaryKey(),
  name:           varchar('name', { length: 255 }).notNull(),
  attachableType: varchar('attachable_type', { length: 255 }).notNull(),
  attachableId:   integer('attachable_id').notNull(),
  assetId:        integer('asset_id').notNull(),
  position:       integer('position').notNull().default(0),
  createdAt:      timestamp('created_at').defaultNow(),
})

/** STI: type column discriminates Product / DigitalProduct / BundleProduct */
export const products = pgTable('products', {
  id:           serial('id').primaryKey(),
  type:         varchar('type', { length: 50 }).notNull().default('Product'),
  name:         varchar('name', { length: 255 }).notNull(),
  priceInCents: integer('price_in_cents').notNull(),
  stock:        integer('stock').notNull().default(0),
  isActive:     boolean('is_active').notNull().default(true),
  metadata:     text('metadata'),
  downloadUrl:  varchar('download_url', { length: 500 }),
  createdAt:    timestamp('created_at').defaultNow(),
})

export const tags = pgTable('tags', {
  id:   serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
})

/** habtm join table — variable name matches the @model table name */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const products_tags = pgTable('products_tags', {
  productId: integer('product_id').notNull(),
  tagId:     integer('tag_id').notNull(),
}, t => [primaryKey({ columns: [t.productId, t.tagId] })])

export const orders = pgTable('orders', {
  id:             serial('id').primaryKey(),
  userId:         integer('user_id').notNull(),
  status:         integer('status').notNull().default(0),
  totalInCents:   integer('total_in_cents').notNull().default(0),
  lineItemsCount: integer('line_items_count').notNull().default(0),
  notes:          text('notes'),
  placedAt:       timestamp('placed_at'),
  createdAt:      timestamp('created_at').defaultNow(),
})

// eslint-disable-next-line @typescript-eslint/naming-convention
export const line_items = pgTable('line_items', {
  id:           serial('id').primaryKey(),
  orderId:      integer('order_id').notNull(),
  productId:    integer('product_id').notNull(),
  name:         varchar('name', { length: 255 }).notNull(),
  priceInCents: integer('price_in_cents').notNull(),
  qty:          integer('qty').notNull().default(1),
})

export const reviews = pgTable('reviews', {
  id:             serial('id').primaryKey(),
  reviewableType: varchar('reviewable_type', { length: 100 }).notNull(),
  reviewableId:   integer('reviewable_id').notNull(),
  userId:         integer('user_id').notNull(),
  rating:         integer('rating').notNull(),
  body:           text('body'),
  createdAt:      timestamp('created_at').defaultNow(),
})

// ── Drizzle relations (required for db.query X.findMany({ with: {...} })) ───

export const usersRelations = relations(users, ({ many }) => ({
  orders:  many(orders),
  reviews: many(reviews),
}))

export const productsRelations = relations(products, ({ many }) => ({
  line_items:    many(line_items),
  reviews:       many(reviews),
  products_tags: many(products_tags),
}))

export const tagsRelations = relations(tags, ({ many }) => ({
  products_tags: many(products_tags),
}))

export const products_tagsRelations = relations(products_tags, ({ one }) => ({
  product: one(products, { fields: [products_tags.productId], references: [products.id] }),
  tag:     one(tags,     { fields: [products_tags.tagId],     references: [tags.id] }),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user:       one(users,      { fields: [orders.userId],  references: [users.id] }),
  line_items: many(line_items),
}))

export const line_itemsRelations = relations(line_items, ({ one }) => ({
  order:   one(orders,   { fields: [line_items.orderId],   references: [orders.id] }),
  product: one(products, { fields: [line_items.productId], references: [products.id] }),
}))

export const reviewsRelations = relations(reviews, ({ one }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
}))

/**
 * All table + relation definitions.
 * Keys MUST match the @model() table name strings exactly —
 * active-drizzle uses getSchema()[model.tableName] for lookup.
 */
export const schema = {
  users,        usersRelations,
  products,     productsRelations,
  tags,         tagsRelations,
  products_tags, products_tagsRelations,
  orders,       ordersRelations,
  line_items,   line_itemsRelations,
  reviews,      reviewsRelations,
  assets,       active_drizzle_assets: assets,
  attachments,  active_drizzle_attachments: attachments,
}

/** DDL — create all tables in the test Postgres container */
export const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  name       VARCHAR(255),
  role       VARCHAR(50) NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id             SERIAL PRIMARY KEY,
  type           VARCHAR(50) NOT NULL DEFAULT 'Product',
  name           VARCHAR(255) NOT NULL,
  price_in_cents INTEGER NOT NULL,
  stock          INTEGER NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  metadata       TEXT,
  download_url   VARCHAR(500),
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS products_tags (
  product_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (product_id, tag_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL,
  status           INTEGER NOT NULL DEFAULT 0,
  total_in_cents   INTEGER NOT NULL DEFAULT 0,
  line_items_count INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  placed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS line_items (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL,
  product_id     INTEGER NOT NULL,
  name           VARCHAR(255) NOT NULL,
  price_in_cents INTEGER NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reviews (
  id              SERIAL PRIMARY KEY,
  reviewable_type VARCHAR(100) NOT NULL,
  reviewable_id   INTEGER NOT NULL,
  user_id         INTEGER NOT NULL,
  rating          INTEGER NOT NULL,
  body            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id           SERIAL PRIMARY KEY,
  key          VARCHAR(255) NOT NULL,
  filename     VARCHAR(255) NOT NULL,
  content_type VARCHAR(255) NOT NULL,
  byte_size    INTEGER NOT NULL,
  checksum     VARCHAR(255) NOT NULL,
  status       VARCHAR(50) NOT NULL DEFAULT 'pending',
  access       VARCHAR(50) NOT NULL DEFAULT 'private',
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  attachable_type VARCHAR(255) NOT NULL,
  attachable_id   INTEGER NOT NULL,
  asset_id        INTEGER NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);
`
