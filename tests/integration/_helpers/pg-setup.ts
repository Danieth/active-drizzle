/**
 * Spins up a real Postgres container via testcontainers,
 * creates tables, boots active-drizzle, and returns helpers.
 *
 * Usage:
 *   const ctx = await startPostgres()
 *   // ... tests ...
 *   await ctx.stop()
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { boot } from '../../../src/runtime/boot.js'
import { DDL, schema } from './schema.js'

export type PgContext = {
  db:    NodePgDatabase<typeof schema>
  pool:  pg.Pool
  stop:  () => Promise<void>
  /** Truncate all tables for a clean-slate between test suites */
  reset: () => Promise<void>
}

export async function startPostgres(): Promise<PgContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('active_drizzle_test')
    .withUsername('test')
    .withPassword('test')
    .start()

  const pool = new pg.Pool({
    connectionString: container.getConnectionUri(),
    ssl: false,  // testcontainers Postgres does not use SSL
  })

  // Run DDL — create all tables
  await pool.query(DDL)

  // drizzle-orm ≥0.36 prefers { client, schema } object form
  const db = drizzle({ client: pool, schema }) as NodePgDatabase<typeof schema>

  // Wire up active-drizzle
  boot(db as any, schema)

  const reset = async () => {
    await pool.query(`
      TRUNCATE
        reviews, line_items, products_tags,
        orders, products, tags, users
      RESTART IDENTITY CASCADE
    `)
  }

  const stop = async () => {
    await pool.end()
    await container.stop()
  }

  return { db, pool, stop, reset }
}
