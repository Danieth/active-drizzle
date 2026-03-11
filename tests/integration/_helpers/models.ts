/**
 * active-drizzle model definitions for integration tests.
 *
 * Each class intentionally exercises a different set of features:
 *   User         – basic CRUD, scopes, role enum via Attr.new
 *   Product      – price cents↔dollars via Attr.new, JSON metadata, habtm tags
 *   DigitalProduct – STI subclass, adds downloadUrl
 *   BundleProduct  – STI subclass, no extras
 *   Tag          – simple, used for habtm
 *   Order        – integer enum, acceptsNested, counterCache, lifecycle hooks
 *   LineItem     – belongsTo order+product, price cents↔dollars
 *   Review       – polymorphic belongsTo
 */
import { ApplicationRecord } from '../../../src/runtime/application-record.js'
import { model, beforeSave, afterSave, afterCommit, validate } from '../../../src/runtime/decorators.js'
import { Attr } from '../../../src/runtime/attr.js'
import { hasMany, belongsTo, habtm } from '../../../src/runtime/markers.js'

// ── User ─────────────────────────────────────────────────────────────────────

@model('users')
export class User extends ApplicationRecord {
  static orders   = hasMany()
  static reviews  = hasMany()

  /** role column → boolean admin accessor via Attr.for() */
  static admin = Attr.for('role', {
    get: (v: string | null) => v === 'admin',
    set: (v: boolean)       => (v ? 'admin' : 'customer'),
  })

  /** Scope: customers only */
  static customers() {
    return this.where({ role: 'customer' })
  }

  /** Scope: admins only */
  static admins() {
    return this.where({ role: 'admin' })
  }
}

// ── Product (base) ────────────────────────────────────────────────────────────

@model('products')
export class Product extends ApplicationRecord {
  static tags      = habtm('products_tags')
  static lineItems = hasMany('line_items')
  static reviews   = hasMany()

  /** priceInCents column → dollars via Attr.for() */
  static price = Attr.for('priceInCents', {
    get: (v: number | null) => (v == null ? null : v / 100),
    set: (v: number)        => Math.round(v * 100),
  })

  /** Rich metadata as a typed JSON blob */
  static metadata = Attr.json<{ weight?: number; dims?: string; tags?: string[] }>()

  /** Scope: only active products */
  static active() {
    return this.where({ isActive: true })
  }

  /** Scope: products below a price threshold (dollars) */
  static underPrice(maxDollars: number) {
    return this.where({ priceInCents: { lte: maxDollars * 100 } as any })
  }

  @validate()
  checkStock() {
    if ((this as any).stock < 0) return 'stock cannot be negative'
  }

  @beforeSave()
  snapNameToUpperCase() {
    // demonstration: a real app might slugify here
    if ((this as any).name) {
      const trimmed = String((this as any).name).trim()
      ;(this as any).name = trimmed
    }
  }
}

// ── STI: DigitalProduct ───────────────────────────────────────────────────────

@model('products')
export class DigitalProduct extends Product {
  static stiType      = 'DigitalProduct'
  static downloadUrl  = Attr.string()
}

// ── STI: BundleProduct ────────────────────────────────────────────────────────

@model('products')
export class BundleProduct extends Product {
  static stiType = 'BundleProduct'
}

// ── Tag ───────────────────────────────────────────────────────────────────────

@model('tags')
export class Tag extends ApplicationRecord {}

// ── Order ─────────────────────────────────────────────────────────────────────

let afterCommitFired: string[] = []  // captured in tests
export function resetAfterCommitLog() { afterCommitFired = [] }
export function getAfterCommitLog()   { return afterCommitFired }

@model('orders')
export class Order extends ApplicationRecord {
  static user      = belongsTo()
  static lineItems = hasMany('line_items', { acceptsNested: true, counterCache: true } as any)

  static status = Attr.enum({
    pending:   0,
    confirmed: 1,
    shipped:   2,
    cancelled: 3,
  } as const)

  /** totalInCents column → dollars via Attr.for() */
  static total = Attr.for('totalInCents', {
    get: (v: number | null) => (v == null ? null : v / 100),
    set: (v: number)        => Math.round(v * 100),
  })

  /** Scope: open orders (pending or confirmed) */
  static open() {
    return this.all()
  }

  /** Scope: by user */
  static forUser(userId: number) {
    return this.where({ userId })
  }

  @afterCommit()
  async notifyCustomer() {
    afterCommitFired.push(`order:${(this as any).id}:${(this as any).status}`)
  }
}

// ── LineItem ──────────────────────────────────────────────────────────────────

@model('line_items')
export class LineItem extends ApplicationRecord {
  static order   = belongsTo()
  static product = belongsTo()

  static price = Attr.for('priceInCents', {
    get: (v: number | null) => (v == null ? null : v / 100),
    set: (v: number)        => Math.round(v * 100),
  })

  /** Computed convenience: line total in dollars */
  get subtotal(): number {
    return ((this as any).price ?? 0) * ((this as any).qty ?? 1)
  }
}

// ── Review ────────────────────────────────────────────────────────────────────

@model('reviews')
export class Review extends ApplicationRecord {
  static reviewable = belongsTo({ polymorphic: true } as any)
  static user       = belongsTo()
}
