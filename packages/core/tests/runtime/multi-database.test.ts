/**
 * Multi-database binding — DEFER-to-drizzle doctrine: connections are
 * drizzle's job; the framework owns BINDING (which tables live on which
 * instance) and the routing rules that keep transactions honest.
 */
import { describe, it, expect } from 'vitest'
import { boot, bindDatabase, getExecutor, transactionContext, transactionDbName } from '../../src/runtime/boot.js'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

const posts  = pgTable('posts',  { id: serial('id').primaryKey(), title: text('title') })
const events = pgTable('events', { id: serial('id').primaryKey(), kind: text('kind') })

const mainDb: any = { tag: 'main', transaction: async (fn: any) => fn(mainDb) }
const analyticsDb: any = { tag: 'analytics', transaction: async (fn: any) => fn(analyticsDb) }

boot(mainDb, { posts })
bindDatabase('analytics', analyticsDb, { events })

describe('table-routed executors', () => {
  it('unbound + default tables → the boot() db; bound tables → their db', () => {
    expect((getExecutor() as any).tag).toBe('main')
    expect((getExecutor('posts') as any).tag).toBe('main')
    expect((getExecutor('events') as any).tag).toBe('analytics')
  })

  it("rebinding 'default' by name is refused", () => {
    expect(() => bindDatabase('default', mainDb, {})).toThrow(/bound by boot/)
  })

  it('a transaction only captures queries AGAINST ITS OWN database', () => {
    const tx: any = { tag: 'main-tx' }
    transactionDbName.run('default', () => transactionContext.run(tx, () => {
      expect((getExecutor('posts') as any).tag).toBe('main-tx')       // captured
      expect((getExecutor('events') as any).tag).toBe('analytics')    // NOT captured — different connection
    }))
    const atx: any = { tag: 'analytics-tx' }
    transactionDbName.run('analytics', () => transactionContext.run(atx, () => {
      expect((getExecutor('events') as any).tag).toBe('analytics-tx')
      expect((getExecutor('posts') as any).tag).toBe('main')          // main stays un-captured
    }))
  })
})
