/**
 * Query-path errors must be observable.
 *
 * Read failures used to escape as a bare driver error and never reached
 * onError() at all — half of every app's DB errors were invisible to
 * Rollbar/Sentry. These lock in the enrichment added in Relation._exec():
 * context (model/table/operation/sql), the raw error preserved and rethrown,
 * and — a security property — bound params NEVER reported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startPostgres, type PgContext } from './_helpers/pg-setup.js'
import { Order } from './_helpers/models.js'
import { onError, clearErrorHandlers } from '../../src/runtime/error-reporting.js'

let ctx: PgContext
beforeAll(async () => { ctx = await startPostgres() }, 60_000)
afterAll(async () => { await ctx.stop() }, 30_000)

/** Runs `fn`, capturing everything the registered error handlers receive. */
async function capture(fn: () => Promise<unknown>) {
  clearErrorHandlers()
  const reported: Array<{ err: any; ctx: any }> = []
  const un = onError((err, context) => { reported.push({ err, ctx: context }) })
  let threw = false
  try { await fn() } catch { threw = true }
  un(); clearErrorHandlers()
  return { reported, threw }
}

describe('query-path error reporting', () => {
  it('a failing read reports model/table/operation/sql and is still rethrown', async () => {
    const { reported, threw } = await capture(() =>
      Order.all().where(sql`nonexistent_column = 1`).load(),
    )

    expect(reported).toHaveLength(1)
    const { err, ctx: cx } = reported[0]!

    expect(cx.model).toBe('Order')
    expect(cx.table).toBe('orders')
    expect(cx.operation).toBe('select')
    expect(String(cx.sql).toLowerCase()).toContain('select')

    expect(err.code).toBe('42703')   // raw driver error preserved, not wrapped
    expect(threw).toBe(true)         // and rethrown untouched to the caller
  }, 60_000)

  it('NEVER reports bound params (they carry user data / plaintext search terms)', async () => {
    const { reported } = await capture(() =>
      Order.all().where(sql`nonexistent_column = ${'sensitive-value'}`).load(),
    )

    const cx = reported[0]!.ctx
    expect('params' in cx).toBe(false)
    expect(JSON.stringify(cx)).not.toContain('sensitive-value')
  }, 60_000)

  it('aggregate failures report with operation: aggregate', async () => {
    const { reported } = await capture(() =>
      Order.all().where(sql`bad_col = 1`).count(),
    )
    expect(reported[0]?.ctx.operation).toBe('aggregate')
  }, 60_000)
})
