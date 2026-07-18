/**
 * Default CRUD handler logic.
 * These are the 12-step index, get, create, update, destroy implementations.
 * Controllers that define their own methods override these automatically.
 */
import { BadRequest, Conflict, NotFound, ValidationError, toValidationError } from './errors.js'
import type { CrudConfig, IndexConfig } from './metadata.js'

// ── Forms envelope (expose / abilities / can / version) ───────────────────────

export interface RecordEnvelope {
  record: Record<string, any>
  abilities: Record<string, 'edit' | 'view'>
  can: Record<string, boolean>
  version: string | null
  /** Non-fatal write problems, e.g. stripped non-permitted fields. */
  issues?: Array<{ field: string; code: string }>
}

/** Optimistic-lock token — derived from updatedAt when the column exists. */
export function versionOf(record: any): string | null {
  const u = record?.updatedAt ?? record?._attributes?.updatedAt
  if (!u) return null
  const t = u instanceof Date ? u.getTime() : new Date(u).getTime()
  return Number.isFinite(t) ? String(t) : null
}

/** All Attr.state event names declared on the model (duck-typed, no core dep). */
function collectStateEvents(model: any): string[] {
  const events: string[] = []
  for (const key of Object.getOwnPropertyNames(model)) {
    const cfg = (model as any)[key]
    if (cfg && typeof cfg === 'object' && cfg._type === 'state' && cfg.transitions) {
      events.push(...Object.keys(cfg.transitions))
    }
  }
  return events
}

/**
 * Builds the Forms envelope for a record:
 *   { record, abilities, can, version }
 *
 * - record: serialized through the `expose` ceiling (+ get includes)
 * - abilities: 'edit' iff field ∈ update-permit resolved against THIS record;
 *   'view' iff field ∈ expose; absent otherwise. The mask only narrows the
 *   ceiling — the UI consumes permissions, it never creates them.
 * - can: server-computed verdict per Attr.state event (full data, no
 *   projection problem — the client's own can() only ever narrows this)
 * - version: optimistic-lock token
 */
export function buildRecordEnvelope(
  record: any,
  model: any,
  config: CrudConfig,
  ctx: any,
  ctrl: any,
  issues?: Array<{ field: string; code: string }>,
): RecordEnvelope {
  const expose = config.get?.expose ?? []
  const includes = config.get?.include ?? []

  const permitRaw = config.update?.permit
  const resolvedPermit = typeof permitRaw === 'function' ? permitRaw(ctx, ctrl, record) : (permitRaw ?? [])
  const editable = new Set(resolvedPermit)

  const abilities: Record<string, 'edit' | 'view'> = {}
  for (const f of expose) {
    abilities[f] = editable.has(f) ? 'edit' : 'view'
  }

  const can: Record<string, boolean> = {}
  for (const event of collectStateEvents(model)) {
    can[event] = typeof record.can === 'function' ? Boolean(record.can(event)) : false
  }

  const serialized = typeof record.toJSON === 'function'
    ? record.toJSON({ only: [...expose, ...includes] })
    : record

  const envelope: RecordEnvelope = {
    record: serialized,
    abilities,
    can,
    version: versionOf(record),
  }
  if (issues && issues.length > 0) envelope.issues = issues
  return envelope
}

/** True when this controller responds with the Forms envelope. */
export function usesEnvelope(config: CrudConfig): boolean {
  return Boolean(config.get?.abilities && config.get?.expose?.length)
}

export interface PaginationResult {
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

export interface IndexResult {
  data: any[]
  pagination: PaginationResult
}

export interface IndexParams {
  scopes?: string[]
  [paramScope: string]: any        // paramScope values
  filters?: Record<string, any>
  ids?: number[]
  sort?: { field: string; dir?: 'asc' | 'desc' }
  page?: number
  perPage?: number
}

// ── Index ─────────────────────────────────────────────────────────────────────

export async function defaultIndex(
  relation: any,
  model: any,
  config: CrudConfig,
  params: IndexParams,
): Promise<IndexResult> {
  const idx = config.index ?? {}
  let rel = relation

  // 1. defaultScopes (always applied)
  for (const s of idx.defaultScopes ?? []) {
    if (typeof (model as any)[s] !== 'function') throw new BadRequest(`Scope '${s}' not found on model`)
    // Call scope with `rel` as `this` — scope methods call this.where(...) which works on Relation too
    rel = (model as any)[s].call(rel)
  }

  // 2. Requested scopes (validated against allowed list)
  for (const s of params.scopes ?? []) {
    if (!(idx.scopes ?? []).includes(s)) throw new BadRequest(`Unknown scope: '${s}'`)
    if (typeof (model as any)[s] !== 'function') throw new BadRequest(`Scope '${s}' not found on model`)
    rel = (model as any)[s].call(rel)
  }

  // 3. paramScopes (scopes that take a string argument)
  for (const s of idx.paramScopes ?? []) {
    if (params[s] !== undefined && params[s] !== null && params[s] !== '') {
      if (typeof (model as any)[s] !== 'function') throw new BadRequest(`Scope '${s}' not found on model`)
      rel = (model as any)[s].call(rel, params[s])
    }
  }

  // 4. Column filters
  const filterableFields = idx.filterable ?? []
  const rawFilters = params.filters ?? {}
  for (const field of filterableFields) {
    const raw = rawFilters[field]
    if (raw === undefined || raw === null) continue
    const converted = convertFilterValue(model, field, raw)
    rel = rel.where({ [field]: converted })
  }
  // Reject unknown filter keys
  for (const key of Object.keys(rawFilters)) {
    if (!filterableFields.includes(key)) throw new BadRequest(`Cannot filter by '${key}'`)
  }

  // 5. ids param (for combobox hydration — still respects scope)
  if (params.ids?.length) {
    rel = rel.where({ id: params.ids })
  }

  // 6. Sort (validated against sortable list)
  if (params.sort) {
    const { field, dir = 'asc' } = params.sort
    if (!(idx.sortable ?? []).includes(field)) throw new BadRequest(`Cannot sort by '${field}'`)
    if (dir !== 'asc' && dir !== 'desc') throw new BadRequest(`Sort dir must be 'asc' or 'desc'`)
    rel = rel.order(field, dir)
  } else if (idx.defaultSort) {
    rel = rel.order(idx.defaultSort.field, idx.defaultSort.dir ?? 'asc')
  }

  // 7. Count BEFORE pagination
  const totalCount = await rel.count()

  // 8. Pagination
  const maxPerPage = idx.maxPerPage ?? 100
  const perPage = Math.min(params.perPage ?? idx.perPage ?? 25, maxPerPage)
  const page = params.page ?? 0
  rel = rel.limit(perPage).offset(page * perPage)

  // 9. Includes
  if (idx.include?.length) {
    rel = rel.includes(...idx.include)
  }

  // 10. Execute
  const data = await rel.load()

  return {
    data,
    pagination: {
      page,
      perPage,
      totalCount,
      totalPages: Math.ceil(totalCount / perPage),
      hasMore: (page + 1) * perPage < totalCount,
    },
  }
}

// ── Get ───────────────────────────────────────────────────────────────────────

export async function defaultGet(
  relation: any,
  model: any,
  config: CrudConfig,
  id: number | string,
  ctx?: any,
  ctrl?: any,
): Promise<any> {
  const includes = config.get?.include ?? []
  let rel = relation.where({ id })
  if (includes.length) rel = rel.includes(...includes)
  const record = await rel.first()
  if (!record) throw new NotFound(model.name)

  if (usesEnvelope(config)) return buildRecordEnvelope(record, model, config, ctx, ctrl)
  if (config.get?.expose?.length && typeof record.toJSON === 'function') {
    return record.toJSON({ only: [...config.get.expose, ...includes] })
  }
  return record
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function defaultCreate(
  relation: any,
  model: any,
  config: CrudConfig,
  rawInput: Record<string, any>,
  ctx: any,
  /** Scope fields (from URL params) — always set, not governed by permit list. */
  scopeOverrides: Record<string, any> = {},
  /** Controller instance — passed to permit/autoSet functions that accept it. */
  ctrl?: any,
): Promise<any> {
  // Record-aware permit on create receives a defaults-draft instance
  const draft = typeof model === 'function' ? new (model as any)({}, true) : undefined
  const permitted = buildPermittedData(rawInput, config.create, ctx, model, ctrl, draft)
  // Scope overrides are applied AFTER permit — they cannot be excluded or overridden
  const record = await model.create({ ...permitted, ...scopeOverrides })
  // ApplicationRecord.create returns the instance even if save failed.
  // isNewRecord stays true when save failed (validation or DB error).
  if (record.isNewRecord) throw toValidationError(record.errors)
  // Auto-attach: resolve permit list before passing (may be a function)
  const createPermit = typeof config.create?.permit === 'function'
    ? config.create.permit(ctx, ctrl, draft)
    : config.create?.permit
  await _autoAttach(record, model, rawInput, createPermit)
  if (usesEnvelope(config)) return buildRecordEnvelope(record, model, config, ctx, ctrl)
  return record
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function defaultUpdate(
  relation: any,
  model: any,
  config: CrudConfig,
  id: number | string,
  rawInput: Record<string, any>,
  ctx: any,
  /** Controller instance — passed to permit functions that accept it. */
  ctrl?: any,
  /** Optimistic-lock token echoed by the client (envelope controllers). */
  version?: string,
): Promise<any> {
  const record = await relation.where({ id }).first()
  if (!record) throw new NotFound(model.name)

  const envelope = usesEnvelope(config)

  // Optimistic locking: a stale token means the record changed under the
  // form — 409, never a silent overwrite.
  if (envelope && version !== undefined && version !== null) {
    const current = versionOf(record)
    if (current !== null && current !== String(version)) {
      throw new Conflict()
    }
  }

  // `_event` rides the PATCH but is a state-machine instruction, not a field
  const { _event, ...fields } = rawInput ?? {}

  const permitted = buildPermittedData(fields, config.update, ctx, model, ctrl, record)
  for (const [k, v] of Object.entries(permitted)) {
    (record as any)[k] = v
  }

  // Fire the transition in the SAME save as the field diff — there is no
  // saved-but-not-transitioned limbo. Guard failure ⇒ 422 transition_blocked.
  if (_event) {
    const fired = typeof (record as any)[_event] === 'function' ? (record as any)[_event]() : false
    if (!fired) {
      throw new ValidationError({ base: [`transition_blocked: cannot ${String(_event)} right now`] })
    }
  }

  if (!(await record.save())) throw toValidationError(record.errors)
  // Auto-attach: resolve permit list before passing (may be a function)
  const updatePermitRaw = config.update?.permit ?? config.create?.permit
  const updatePermit = typeof updatePermitRaw === 'function'
    ? updatePermitRaw(ctx, ctrl, record)
    : updatePermitRaw
  await _autoAttach(record, model, rawInput, updatePermit)

  if (envelope) {
    // Report stripped fields so the generated UI can't hide a permit bug
    const editable = new Set(Object.keys(permitted))
    const issues = Object.keys(fields)
      .filter(k => !editable.has(k) && k in fields)
      .map(field => ({ field, code: 'forbidden' }))
    // PATCH response = GET envelope — abilities recomputed on the SAVED
    // record, so a permit that narrowed after a transition re-masks the
    // same JSX read-only (post-transition self-locking).
    return buildRecordEnvelope(record, model, config, ctx, ctrl, issues)
  }
  return record
}

// ── Destroy ───────────────────────────────────────────────────────────────────

export async function defaultDestroy(
  relation: any,
  model: any,
  id: number | string,
): Promise<void> {
  const record = await relation.where({ id }).first()
  if (!record) throw new NotFound(model.name)
  await record.destroy()
}

// ── Permit / restrict helpers ─────────────────────────────────────────────────

const ALWAYS_EXCLUDED = ['id', 'createdAt', 'updatedAt', 'created_at', 'updated_at']

function buildPermittedData(
  input: Record<string, any>,
  writeConfig: {
    permit?: string[] | ((ctx: any, ctrl: any, record?: any) => string[])
    restrict?: string[]
    autoSet?: Record<string, (ctx: any, ctrl?: any) => any>
  } | undefined,
  ctx: any,
  model: any,
  ctrl?: any,
  /** Loaded record (update) or defaults-draft (create) — for record-state-aware permits. */
  record?: any,
): Record<string, any> {
  const { permit, restrict, autoSet } = writeConfig ?? {}

  // permit can be a static list or a dynamic function (role- and record-state-aware)
  const resolvedPermit = typeof permit === 'function' ? permit(ctx, ctrl, record) : permit

  let allowed: Set<string>
  if (resolvedPermit) {
    allowed = new Set(resolvedPermit)
  } else {
    allowed = new Set(Object.keys(input))
    for (const k of ALWAYS_EXCLUDED) allowed.delete(k)
    if (restrict) for (const k of restrict) allowed.delete(k)
  }

  const out: Record<string, any> = {}
  for (const key of allowed) {
    if (key in input) out[key] = input[key]
  }

  if (autoSet && ctx) {
    for (const [k, fn] of Object.entries(autoSet)) {
      out[k] = fn(ctx, ctrl)
    }
  }

  return out
}

// ── Enum filter conversion ────────────────────────────────────────────────────

/**
 * If the field has an Attr.enum on the model, convert label → integer.
 * Otherwise pass through as-is.
 */
export function convertFilterValue(model: any, field: string, value: any): any {
  const attr = (model as any)[field]
  if (attr?._type === 'enum' && attr.values) {
    if (Array.isArray(value)) {
      return value.map(v => (typeof v === 'string' ? (attr.values[v] ?? v) : v))
    }
    if (typeof value === 'string') return attr.values[value] ?? value
  }
  return value
}

// ── Singleton helpers ─────────────────────────────────────────────────────────

/**
 * Race-safe findOrCreate for singleton resources.
 * Uses INSERT ... then falls back to SELECT on unique constraint violation (23505).
 */
export async function singletonFindOrCreate(
  model: any,
  findByClause: Record<string, any>,
  defaultValues: Record<string, any>,
): Promise<any> {
  const existing = await model.findBy(findByClause)
  if (existing) return existing
  try {
    return await model.create({ ...defaultValues, ...findByClause })
  } catch (e: any) {
    // Unique constraint violation — another concurrent request created it
    if (e.code === '23505' || e.message?.includes('duplicate key')) {
      const retried = await model.findBy(findByClause)
      if (retried) return retried
    }
    throw e
  }
}

// ── Auto-attach helper ────────────────────────────────────────────────────────

/**
 * After create/update, checks if any permitted fields match attachment declarations.
 * hasOneAttachment 'logo' → looks for `logoAssetId` in input → calls record.attach('logo', id)
 * hasManyAttachments 'docs' → looks for `docsAssetIds` in input → syncs (detach removed, attach added)
 */
async function _autoAttach(
  record: any,
  model: any,
  rawInput: Record<string, any>,
  permit?: string[],
): Promise<void> {
  const resolvedPermit = permit ?? []
  let attachmentEntries: any[] | null = null

  try {
    const core = await import('@active-drizzle/core' as string) as any
    attachmentEntries = core.getAttachments(model.name)
  } catch {
    return
  }

  if (!attachmentEntries?.length) return

  for (const entry of attachmentEntries) {
    if (!resolvedPermit.includes(entry.name)) continue

    if (entry.kind === 'one') {
      const inputKey = `${entry.name}AssetId`
      const assetId = rawInput[inputKey]
      if (assetId !== undefined && assetId !== null) {
        await record.replace(entry.name, assetId)
      } else if (assetId === null) {
        await record.detach(entry.name)
      }
    } else {
      const inputKey = `${entry.name}AssetIds`
      const assetIds = rawInput[inputKey]
      if (Array.isArray(assetIds)) {
        await record.detach(entry.name)
        for (const id of assetIds) {
          await record.attach(entry.name, id)
        }
      }
    }
  }
}
