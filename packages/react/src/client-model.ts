/**
 * ClientModel — immutable client-side view of a server model record.
 *
 * On the server, ApplicationRecord instances are mutable proxies with dirty
 * tracking. On the client, we want immutable snapshots that work nicely with
 * React's rendering model (no mutation, no proxy, referential equality is
 * meaningful).
 *
 * Usage (generated subclass):
 *
 *   export class Campaign extends ClientModel<CampaignAttrs> {
 *     isDraft() { return this.status === 'draft' }
 *     isActive() { return this.status === 'active' }
 *     assetCount() { return (this.assetIds ?? []).length }
 *   }
 *
 *   const c = Campaign.from(serverData)
 *   const updated = c.set({ name: 'New name' })  // returns NEW instance
 */

export class ClientModel<TAttrs extends Record<string, any> = Record<string, any>> {
  protected readonly _attrs: TAttrs

  constructor(attrs: TAttrs) {
    this._attrs = Object.freeze({ ...attrs })
    // Expose all attrs directly on `this` for ergonomic access: model.name, model.id
    Object.assign(this, this._attrs)
  }

  /** Create a new instance of this model from plain server data. */
  static from<T extends ClientModel<any>>(
    this: new (attrs: any) => T,
    attrs: any,
  ): T {
    return new this(attrs)
  }

  /** Create an array of instances. */
  static fromArray<T extends ClientModel<any>>(
    this: new (attrs: any) => T,
    items: any[],
  ): T[] {
    return items.map(a => new (this as any)(a))
  }

  /**
   * Returns a NEW instance with the given fields merged in.
   * Preserves immutability — does NOT mutate `this`.
   */
  set(updates: Partial<TAttrs>): this {
    return new (this.constructor as any)({ ...this._attrs, ...updates }) as this
  }

  /** Raw attribute access (bypasses any virtual getters defined in subclasses). */
  raw<K extends keyof TAttrs>(key: K): TAttrs[K] {
    return this._attrs[key]
  }

  /** Serialise to a plain object (useful for form initial values, etc.). */
  toObject(): TAttrs {
    return { ...this._attrs }
  }

  get id(): any {
    return this._attrs['id']
  }
}

// ── Cache key factories ───────────────────────────────────────────────────────

/**
 * Generates consistent, predictable cache key arrays for React Query.
 *
 * Usage (generated):
 *   export const campaignKeys = modelCacheKeys('campaigns', { teamId: true })
 *   // campaignKeys.list({ teamId: 1 }) → ['campaigns', { teamId: 1 }, 'list']
 *   // campaignKeys.detail(1, { teamId: 1 }) → ['campaigns', { teamId: 1 }, 1]
 */
export interface ModelCacheKeys<TScopes extends Record<string, number>> {
  root: (scopes: TScopes) => [string, TScopes]
  list: (scopes: TScopes, params?: Record<string, any>) => [string, TScopes, 'list', Record<string, any>?]
  detail: (id: number | string, scopes: TScopes) => [string, TScopes, number | string]
  search: (scopes: TScopes, query: string) => [string, TScopes, 'search', string]
  singleton: (scopes: TScopes) => [string, TScopes, 'singleton']
}

export function modelCacheKeys<TScopes extends Record<string, number>>(
  resourceName: string,
  _scopeShape?: Record<string, boolean>,
): ModelCacheKeys<TScopes> {
  return {
    root: (scopes) => [resourceName, scopes],
    list: (scopes, params) => params
      ? [resourceName, scopes, 'list', params]
      : [resourceName, scopes, 'list'],
    detail: (id, scopes) => [resourceName, scopes, id],
    search: (scopes, query) => [resourceName, scopes, 'search', query],
    singleton: (scopes) => [resourceName, scopes, 'singleton'],
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

// ── Index result type ─────────────────────────────────────────────────────────

export interface ModelIndexResult<T> {
  data: T[]
  pagination: PaginationMeta
}
