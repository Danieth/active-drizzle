/**
 * The membership lane — transport WS3, obligations O5 + O15 (T8).
 *
 * Two DIFFERENT jobs, both shipped, never conflated (landmine 10):
 *
 * 1. THE TAG (theorem grade, O5 decided): a door-scoped commit-ordered
 *    COUNTER. v1 keeps ONE counter row per door (not per paramsHash — no
 *    unbounded rows, no multiplied writes), bumped IN-COMMIT by the
 *    write-log's lifecycle write points (core/src/runtime/write-log.ts:
 *    bumpMembershipTags — the bump is transactional with the membership-
 *    changing write, because tag-equal ⇒ same-list requires snapshot
 *    atomicity; a sequence survives rollback and breaks it). Detection v1
 *    is the CONSERVATIVE BUMP: any create/destroy/lifecycle write to the
 *    door's root model bumps — spurious bumps cost a spurious membership
 *    refetch (hundreds of bytes of pk-array), never a wrong list; compiled
 *    scope-intersection is the later precision trim. Residual, stated: a
 *    plain VALUE update that moves a row across a filtered/scoped list does
 *    NOT bump in v1 — v1's splice is always replace-all, so nothing
 *    consumes tag-equality as a skip yet; the precision trim must land
 *    before real ops do.
 *
 * 2. THE STRUCTURE TOKEN (probabilistic grade, declared): the index-refetch
 *    304 guard — a STRONG truncated crypto hash (SHA-256/64-bit) of pk-set +
 *    order + count + pagination-cursor identity. NEVER row tokens (value
 *    churn must not bust it), facets EXCLUDED (aggregates legitimately move
 *    with values and are separately validatable — wire-identity §4). A
 *    short non-crypto hash here is landmine 10: neither theorem nor
 *    negligible-collision.
 *
 * 3. THE SPLICE endpoint ships its wire shape keyed (door, paramsHash,
 *    fromTag), but v1 always answers ops = [replace-all with list@to] —
 *    apply(list@from, ops) = list@to holds trivially, and the O15 property
 *    test pins the contract the real ops implementation must later satisfy.
 */
import { createHash } from 'node:crypto'
import { currentMembershipTag } from '@active-drizzle/core'
import { getScopes, getControllerMeta } from './metadata.js'
import { inferControllerPath } from './decorators.js'
import type { ColumnarMembership } from './columnar-envelope.js'

// ── Door identity ────────────────────────────────────────────────────────────

/**
 * THE door id — the same basePath buildRouter computes (scope prefixes +
 * controller path), so registration (router build) and reads (handlers that
 * only hold the controller instance) can never disagree.
 */
export function doorIdOf(ControllerClass: any): string {
  const meta = getControllerMeta(ControllerClass)
  const resourcePath = meta?.path ?? inferControllerPath(ControllerClass)
  const scopePrefix = getScopes(ControllerClass).map(s => `/${s.resource}/:${s.paramName}`).join('')
  return scopePrefix + resourcePath
}

/** The current commit-ordered membership tag of a door (0 before any bump). */
export function membershipTagOf(ControllerClass: any, tableName?: string): Promise<number> {
  return currentMembershipTag(doorIdOf(ControllerClass), tableName)
}

// ── Structure token ──────────────────────────────────────────────────────────

/**
 * The pure STRUCTURE token of one membership answer: pk-set + order + count +
 * pagination-cursor identity. Value churn cannot bust it; facets are
 * deliberately OUTSIDE it (separately validatable — a count moving from 12
 * to 11 must not refetch the pk list). 64 bits of SHA-256 — collision
 * probability negligible and DECLARED probabilistic (T8's second grade).
 */
export function structureTokenOf(membership: {
  pks: Array<number | string>
  pagination?: { page: number; perPage: number; totalCount: number; hasMore: boolean }
}): string {
  const p = membership.pagination
  const cursor = p ? `${p.page}|${p.perPage}|${p.totalCount}|${p.hasMore ? 1 : 0}` : ''
  const material = `${membership.pks.join(',')}#${membership.pks.length}#${cursor}`
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** Attach the structure token to a columnar index membership (in place). */
export function attachStructureToken(membership: ColumnarMembership): void {
  membership.structureToken = structureTokenOf(membership)
}

// ── paramsHash + splice ──────────────────────────────────────────────────────

/**
 * Canonical hash of the membership-determining index params (filters, scopes,
 * search, sort, page window) — the splice key's paramsHash. Stable across key
 * order; presentation-only params excluded.
 */
export function paramsHashOf(params: Record<string, any> | undefined): string {
  const p = params ?? {}
  const material = JSON.stringify({
    scopes: p['scopes'] ?? null,
    filters: canonical(p['filters'] ?? null),
    q: p['q'] ?? null,
    ids: p['ids'] ?? null,
    sort: canonical(p['sort'] ?? null),
    page: p['page'] ?? 0,
    perPage: p['perPage'] ?? null,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function canonical(v: any): any {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonical)
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]))
}

export type SpliceOp = { op: 'replace-all'; pks: Array<number | string> }

export interface SpliceResult {
  door: string
  paramsHash: string
  fromTag: number
  toTag: number
  /** v1: always [replace-all with list@to]. The O15 axiom
   *  apply(list@from, ops) = list@to therefore holds trivially — and the
   *  property test pins it as the contract real ops must later satisfy. */
  ops: SpliceOp[]
}

/** Build the v1 splice answer from the door's CURRENT list (list@to). */
export function buildSplice(
  door: string,
  paramsHash: string,
  fromTag: number,
  toTag: number,
  listAtTo: Array<number | string>,
): SpliceResult {
  return { door, paramsHash, fromTag, toTag, ops: [{ op: 'replace-all', pks: listAtTo }] }
}

/**
 * THE splice application function (client twin lives in the generated hooks;
 * this one exists so O15's property test runs server-side against the same
 * semantics). Membership is REPLACED, never merged (T8).
 */
export function applySplice(
  listAtFrom: Array<number | string>,
  ops: SpliceOp[],
): Array<number | string> {
  let list = listAtFrom
  for (const op of ops) {
    if (op.op === 'replace-all') list = [...op.pks]
    else {
      // Future op kinds must extend this switch AND the O15 property test
      // BEFORE the server ever emits them — an unknown op falls back to the
      // full fetch client-side; here it is a hard error so the test catches
      // the drift first.
      throw new Error(`[active-drizzle] applySplice: unknown op '${(op as any).op}'`)
    }
  }
  return list
}
