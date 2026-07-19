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

  // Partial: drafts are built from projections and empty new-form payloads —
  // demanding the full attrs shape made every generated makeDraft a type
  // error while the runtime was always fine with sparse input
  constructor(attrs: Partial<TAttrs>) {
    this._attrs = Object.freeze({ ...attrs }) as TAttrs
    // Define attrs onto `this` so `model.name` works without explicit getters.
    // defineProperty (not Object.assign) — assignment would invoke prototype
    // accessors like `get id()` and throw; defining shadows them cleanly and
    // stays writable so form drafts can mutate.
    for (const [k, v] of Object.entries(this._attrs)) {
      Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true })
    }
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

  /**
   * `id` is a plain data property defined by the constructor when present.
   * (It was once a prototype accessor — which made `draft.id = 9` THROW on
   * drafts constructed from empty payloads, e.g. new-record forms receiving
   * their created id. Never again.)
   *
   * OPTIONAL: generated subclasses redeclare it `id?: number` (a new-form
   * draft genuinely has none) — a required base made every subclass a
   * TS2415 "incorrectly extends" error.
   */
  declare id?: any
}

// ── Envelope unwrap ───────────────────────────────────────────────────────────

/**
 * The record inside a controller `get()` response — whatever the shape.
 *
 * A controller with `abilities: true` responds with the Forms envelope
 * `{ record, abilities, can }`; one without responds with the bare row. A
 * picker (or any presenter) pointed at an arbitrary "door" must not care:
 *
 *   const row = recordOf(await DoorController.get({ id }))
 *   label = row?.name
 *
 * Without this every UI kit independently rediscovers `data.record ?? data`
 * — or worse, renders `#1` because `data.name` is undefined on an enveloped
 * door while working fine on a bare one.
 */
export function recordOf<T = Record<string, any>>(payload: unknown): T | null {
  if (payload == null || typeof payload !== 'object') return (payload ?? null) as T | null
  return ('record' in (payload as any) ? (payload as any).record : payload) as T
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
