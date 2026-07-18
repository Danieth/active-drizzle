import repl from 'node:repl'
import vm from 'node:vm'
import { boot } from './boot.js'

export interface ConsoleOptions {
  db: any
  schema: Record<string, any>
  /** Model classes to expose as globals in the REPL, e.g. { User, Campaign }. */
  models: Record<string, any>
  prompt?: string
  /** Extra values to expose in the REPL context (helpers, services, etc). */
  context?: Record<string, any>
}

/**
 * Starts a Rails-console-style REPL.
 *
 * Every expression that returns a thenable (a Promise or a Relation, which is
 * thenable) is automatically awaited, so queries execute without `await`:
 *
 *   app> User.all()
 *   app> User.where({ active: true }).order('name')
 *   app> User.find(1)
 *
 * Usage — create `bin/console.ts` in your project:
 *
 *   import { createConsole } from '@active-drizzle/core'
 *   import { db } from '../db/index.js'
 *   import * as schema from '../db/schema.js'
 *   import { User } from '../models/User.model.js'
 *
 *   createConsole({ db, schema, models: { User } })
 */
export function createConsole(options: ConsoleOptions): repl.REPLServer {
  const { db, schema, models, prompt = 'app> ', context = {} } = options
  boot(db, schema)

  const server = repl.start({
    prompt,
    useColors: true,
    eval: async (cmd, replContext, _filename, callback) => {
      try {
        let result = vm.runInContext(cmd, replContext)
        // Auto-await any thenable (Relation, Promise, etc.)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result = await result
        }
        callback(null, result)
      } catch (e: any) {
        // Let the REPL prompt for more input on incomplete expressions
        if (isRecoverableError(e)) {
          callback(new repl.Recoverable(e), undefined)
          return
        }
        callback(e, undefined)
      }
    },
  })

  Object.assign(server.context, models, context)

  const modelNames = Object.keys(models).join(', ')
  console.log('\nActiveDrizzle Console')
  console.log(`Models: ${modelNames}\n`)
  server.displayPrompt()

  return server
}

function isRecoverableError(e: unknown): boolean {
  return (
    e instanceof SyntaxError &&
    /Unexpected end of input|Unterminated template/.test(e.message)
  )
}
