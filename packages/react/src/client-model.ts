/**
 * ClientModel — immutable, type-safe client-side view of a server record.
 *
 * Two type parameters enforce the write/read distinction:
 *
 *   TAttrs  — everything readable: all columns + any eager-loaded associations
 *             the backend returns (from @crud get/index `include: [...]`)
 *
 *   TWrite  — only what the backend accepts for writes, derived at codegen time
 *             from the controller's `permit` list. Attempting to `.set()` a
 *             field that isn't in the permit list is a compile-time error.
 *             Defaults to `never` so the base class is read-only until a
 *             generated subclass supplies the correct shape.
 *
 * Example (generated subclass):
 *
 *   export type CampaignWrite = Pick<CampaignAttrs, 'name' | 'budget' | 'status'>
 *
 *   export class CampaignClient extends ClientModel<CampaignAttrs, CampaignWrite> {
 *     declare id: number
 *     declare name: string
 *     declare status: 'draft' | 'active' | 'paused' | 'completed'
 *     declare creator?: UserAttrs  // from include: ['creator']
 *
 *     isDraft()  { return this.status === 'draft' }
 *     isActive() { return this.status === 'active' }
 *   }
 *
 *   const c = CampaignClient.from(serverPayload)
 *   c.set({ name: 'New' })        // ✓ 'name' is in CampaignWrite
 *   c.set({ id: 99 })             // ✗ TS error — 'id' not in CampaignWrite
 *   c.set({ createdAt: new Date() }) // ✗ TS error — not in permit list
 *   c.creator?.name               // ✓ typed from the include
 */

// TWrite defaults to `never` → set() is a no-op type until the generated
// subclass provides a real write shape.
export class ClientModel<
  TAttrs extends Record<string, any> = Record<string, any>,
  TWrite extends Partial<TAttrs> = never,
> {
  protected readonly _attrs: TAttrs

  constructor(attrs: TAttrs) {
    this._attrs = Object.freeze({ ...attrs })
    // Spread attrs onto `this` so `model.name` works without explicit getters.
    // The generated `declare` statements give TypeScript visibility into this.
    Object.assign(this, this._attrs)
  }

  /** Create a typed instance from a plain server payload. */
  static from<T extends ClientModel<any, any>>(
    this: new (attrs: any) => T,
    attrs: any,
  ): T {
    return new this(attrs)
  }

  /** Create a typed array from a plain server payload array. */
  static fromArray<T extends ClientModel<any, any>>(
    this: new (attrs: any) => T,
    items: any[],
  ): T[] {
    return items.map(a => new (this as any)(a))
  }

  /**
   * Returns a NEW instance with the given fields merged in.
   *
   * Only fields in TWrite (the controller's permit list) are accepted.
   * Attempting to pass `id`, `createdAt`, or any unpermitted field is a
   * compile-time error.
   */
  set(updates: Partial<TWrite>): this {
    return new (this.constructor as any)({ ...this._attrs, ...updates }) as this
  }

  /** Raw attribute access — bypasses any virtual getters in subclasses. */
  raw<K extends keyof TAttrs>(key: K): TAttrs[K] {
    return this._attrs[key]
  }

  /** Serialise to a plain object (useful for form initial values). */
  toObject(): TAttrs {
    return { ...this._attrs }
  }

  get id(): any {
    return this._attrs['id']
  }
}

// ── Cache key factories ───────────────────────────────────────────────────────

/**
 * Generates consistent, scoped cache key arrays for React Query.
 *
 * Generated usage:
 *   const campaignKeys = modelCacheKeys<{ teamId: number }>('campaigns')
 *   campaignKeys.list({ teamId: 1 }, searchParams)
 *   // → ['campaigns', { teamId: 1 }, 'list', searchParams]
 */
export interface ModelCacheKeys<TScopes extends Record<string, number>> {
  root: (scopes: TScopes) => [string, TScopes]
  list: (scopes: TScopes, params?: Record<string, any>) =>
    [string, TScopes, 'list'] | [string, TScopes, 'list', Record<string, any>]
  detail: (id: number | string, scopes: TScopes) => [string, TScopes, number | string]
  search: (scopes: TScopes, query: string) => [string, TScopes, 'search', string]
  singleton: (scopes: TScopes) => [string, TScopes, 'singleton']
}

export function modelCacheKeys<TScopes extends Record<string, number>>(
  resourceName: string,
): ModelCacheKeys<TScopes> {
  return {
    root:      (scopes)          => [resourceName, scopes],
    list:      (scopes, params)  => params
      ? [resourceName, scopes, 'list', params]
      : [resourceName, scopes, 'list'],
    detail:    (id, scopes)      => [resourceName, scopes, id],
    search:    (scopes, query)   => [resourceName, scopes, 'search', query],
    singleton: (scopes)          => [resourceName, scopes, 'singleton'],
  }
}

// ── Pagination meta ───────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

export interface ModelIndexResult<T> {
  data: T[]
  pagination: PaginationMeta
}
