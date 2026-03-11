/**
 * Lifecycle hook tests.
 *
 * Tests that:
 *   - @beforeSave / @afterSave actually fire during save()
 *   - @beforeSave returning false aborts the save
 *   - Conditional hooks (if: string, if: fn) only fire when condition is true
 *   - on: 'create' / on: 'update' scoping works
 *   - Hooks fire in registration order (parent hooks before child hooks)
 *   - @afterCommit fires after a successful save
 *
 * Uses a minimal mock DB so no real Postgres connection is needed.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { ApplicationRecord } from '../../src/runtime/application-record.js'
import { boot } from '../../src/runtime/boot.js'
import {
  model,
  beforeSave,
  afterSave,
  beforeCreate,
  afterCreate,
  beforeUpdate,
  afterUpdate,
  beforeDestroy,
  afterDestroy,
  afterCommit,
  serverValidate,
  memoize,
  server,
  computed,
  scope,
} from '../../src/runtime/decorators.js'
import { Attr } from '../../src/runtime/attr.js'

// ── Mock database ────────────────────────────────────────────────────────────
// Mimics the drizzle chaining API just enough for save() to work.
// The mock ignores SQL expressions (eq, etc.) since .where() is stubbed.

function makeMockDb(returnRow: Record<string, any> = { id: 1, title: 'saved' }) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([returnRow]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([returnRow]),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([]),
    })),
  }
}

// Boot once before all hook tests with a fake schema.
// Each model class uses 'posts' as its table name (set via @model or fallback).
beforeAll(() => {
  const db = makeMockDb()
  const schema = {
    posts: { id: { name: 'id' }, title: { name: 'title' }, status: { name: 'status' } },
  }
  boot(db as any, schema)
})

// ---------------------------------------------------------------------------
// @beforeSave and @afterSave fire around save()
// ---------------------------------------------------------------------------

describe('@beforeSave / @afterSave', () => {
  it('fires @beforeSave before and @afterSave after persist', async () => {
    const callOrder: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave()
      onBefore() { callOrder.push('before') }

      @afterSave()
      onAfter() { callOrder.push('after') }
    }

    const post = new Post({ title: 'hello' }, true)
    ;(post as any).title = 'hello'
    await post.save()

    expect(callOrder).toEqual(['before', 'after'])
  })

  it('@beforeSave returning false aborts the save and @afterSave does NOT run', async () => {
    const afterRan = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave()
      block() { return false }

      @afterSave()
      onAfter() { afterRan() }
    }

    const post = new Post({ title: 'x' }, true)
    const result = await post.save()

    expect(result).toBe(false)
    expect(afterRan).not.toHaveBeenCalled()
  })

  it('@beforeSave can mutate the instance before it is saved', async () => {
    let titleSeenInHook = ''

    @model('posts')
    class Post extends ApplicationRecord {
      static title = Attr.string()

      @beforeSave()
      sanitize() {
        if ((this as any).title === 'bad') {
          ;(this as any).title = 'sanitized'
          // Capture what the hook sees — this is what flows into the DB payload
          titleSeenInHook = (this as any).title
        }
      }
    }

    const post = new Post({}, true)
    ;(post as any).title = 'bad'
    await post.save()

    // The mutation happened inside the hook before persist
    expect(titleSeenInHook).toBe('sanitized')
  })
})

// ---------------------------------------------------------------------------
// @beforeCreate / @afterCreate — only on new records
// ---------------------------------------------------------------------------

describe('@beforeCreate / @afterCreate', () => {
  it('@beforeCreate fires only on INSERT, not UPDATE', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeCreate()
      onlyNew() { log.push('create') }
    }

    // New record — should fire
    const newPost = new Post({ title: 'new' }, true)
    await newPost.save()
    expect(log).toEqual(['create'])

    // Existing record — should NOT fire
    log.length = 0
    const existing = new Post({ id: 1, title: 'old' }, false)
    ;(existing as any).title = 'updated'
    await existing.save()
    expect(log).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// @beforeUpdate / @afterUpdate — only on existing records
// ---------------------------------------------------------------------------

describe('@beforeUpdate / @afterUpdate', () => {
  it('@beforeUpdate fires only on UPDATE, not INSERT', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeUpdate()
      onlyExisting() { log.push('update') }
    }

    // Existing record — should fire
    const existing = new Post({ id: 1, title: 'original' }, false)
    ;(existing as any).title = 'changed'
    await existing.save()
    expect(log).toEqual(['update'])

    // New record — should NOT fire
    log.length = 0
    const newPost = new Post({ title: 'new' }, true)
    await newPost.save()
    expect(log).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Conditional hooks — if: string (field name)
// ---------------------------------------------------------------------------

describe('Conditional hooks — if: string', () => {
  it('fires when the named condition method returns true', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)

      @beforeSave({ if: 'statusChanged' })
      onStatusChange() { fired() }
    }

    const post = new Post({ id: 1, status: 0 }, false)
    ;(post as any).status = 'sent'        // changes status
    await post.save()

    expect(fired).toHaveBeenCalledOnce()
  })

  it('does NOT fire when the named condition is false', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      static status = Attr.enum({ draft: 0, sent: 1 } as const)

      @beforeSave({ if: 'statusChanged' })
      onStatusChange() { fired() }
    }

    // Only change title, not status
    const post = new Post({ id: 1, status: 0, title: 'old' }, false)
    ;(post as any).title = 'new title'
    await post.save()

    expect(fired).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Conditional hooks — if: () => boolean
// ---------------------------------------------------------------------------

describe('Conditional hooks — if: function', () => {
  it('fires when the lambda condition returns true', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave({ if: () => true })
      always() { fired() }
    }

    const post = new Post({ title: 'x' }, true)
    await post.save()
    expect(fired).toHaveBeenCalledOnce()
  })

  it('does NOT fire when the lambda condition returns false', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave({ if: () => false })
      never() { fired() }
    }

    const post = new Post({ title: 'x' }, true)
    await post.save()
    expect(fired).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Hook ordering — parent hooks fire before child hooks
// ---------------------------------------------------------------------------

describe('Hook ordering (inheritance)', () => {
  it('parent @beforeSave fires before child @beforeSave', async () => {
    const log: string[] = []

    @model('posts')
    class Parent extends ApplicationRecord {
      @beforeSave()
      parentHook() { log.push('parent') }
    }

    @model('posts')
    class Child extends Parent {
      @beforeSave()
      childHook() { log.push('child') }
    }

    const c = new Child({ title: 'x' }, true)
    await c.save()
    expect(log).toEqual(['parent', 'child'])
  })
})

// ---------------------------------------------------------------------------
// @afterCommit — fires after save completes (when no transaction is active)
// ---------------------------------------------------------------------------

describe('@afterCommit', () => {
  it('fires after save() resolves', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterSave()
      afterSaveHook() { log.push('afterSave') }

      @afterCommit()
      commitHook() { log.push('afterCommit') }
    }

    const post = new Post({ title: 'x' }, true)
    await post.save()

    expect(log).toContain('afterSave')
    expect(log).toContain('afterCommit')
    // afterSave fires before afterCommit
    expect(log.indexOf('afterSave')).toBeLessThan(log.indexOf('afterCommit'))
  })

  it('does NOT fire when beforeSave aborts', async () => {
    const commitFired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave()
      abort() { return false }

      @afterCommit()
      onCommit() { commitFired() }
    }

    const post = new Post({ title: 'x' }, true)
    await post.save()
    expect(commitFired).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Multiple hooks on the same event fire in registration order
// ---------------------------------------------------------------------------

describe('Multiple hooks on same event', () => {
  it('fire in declaration order', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave()
      first() { log.push('first') }

      @beforeSave()
      second() { log.push('second') }

      @beforeSave()
      third() { log.push('third') }
    }

    await new Post({ title: 'x' }, true).save()
    expect(log).toEqual(['first', 'second', 'third'])
  })
})

// ---------------------------------------------------------------------------
// @afterCreate — fires after INSERT only
// ---------------------------------------------------------------------------

describe('@afterCreate', () => {
  it('fires after a new record is saved', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterCreate()
      onCreated() { log.push('afterCreate') }
    }

    await new Post({ title: 'new' }, true).save()
    expect(log).toEqual(['afterCreate'])
  })

  it('does NOT fire on UPDATE', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterCreate()
      onCreated() { log.push('afterCreate') }
    }

    const existing = new Post({ id: 1, title: 'old' }, false)
    ;(existing as any).title = 'changed'
    await existing.save()
    expect(log).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// @afterUpdate — fires after UPDATE only
// ---------------------------------------------------------------------------

describe('@afterUpdate', () => {
  it('fires after an existing record is saved', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterUpdate()
      onUpdated() { log.push('afterUpdate') }
    }

    const existing = new Post({ id: 1, title: 'old' }, false)
    ;(existing as any).title = 'changed'
    await existing.save()
    expect(log).toEqual(['afterUpdate'])
  })

  it('does NOT fire on INSERT', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterUpdate()
      onUpdated() { log.push('afterUpdate') }
    }

    await new Post({ title: 'new' }, true).save()
    expect(log).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// @beforeDestroy / @afterDestroy — fire around destroy()
// ---------------------------------------------------------------------------

describe('@beforeDestroy / @afterDestroy', () => {
  it('@beforeDestroy fires before the record is deleted', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeDestroy()
      onBeforeDestroy() { log.push('beforeDestroy') }
    }

    const post = new Post({ id: 5, title: 'doomed' }, false)
    await post.destroy()
    expect(log).toEqual(['beforeDestroy'])
  })

  it('@afterDestroy fires after the record is deleted', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @afterDestroy()
      onAfterDestroy() { log.push('afterDestroy') }
    }

    const post = new Post({ id: 6, title: 'gone' }, false)
    await post.destroy()
    expect(log).toEqual(['afterDestroy'])
  })

  it('@beforeDestroy and @afterDestroy fire in order', async () => {
    const log: string[] = []

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeDestroy()
      before() { log.push('before') }

      @afterDestroy()
      after() { log.push('after') }
    }

    const post = new Post({ id: 7, title: 'x' }, false)
    await post.destroy()
    expect(log).toEqual(['before', 'after'])
  })
})

// ---------------------------------------------------------------------------
// @serverValidate — async validation during save()
// ---------------------------------------------------------------------------

describe('@serverValidate', () => {
  it('runs an async validation method during save()', async () => {
    let validationRan = false

    @model('posts')
    class Post extends ApplicationRecord {
      @serverValidate()
      async checkUniqueness() {
        validationRan = true
        // Simulate DB uniqueness check — no error here
      }
    }

    const post = new Post({ title: 'unique-title' }, true)
    await post.save()
    expect(validationRan).toBe(true)
  })

  it('adds an error when async validation fails', async () => {
    @model('posts')
    class Post extends ApplicationRecord {
      @serverValidate()
      async alwaysFails() {
        this.errors['title'] = ['is taken']
      }
    }

    const post = new Post({ title: 'taken' }, true)
    const saved = await post.save()
    expect(saved).toBe(false)
    expect(post.errors['title']).toContain('is taken')
  })
})

// ---------------------------------------------------------------------------
// Conditional hooks — if: string pointing to a plain boolean property
// ---------------------------------------------------------------------------

describe('Conditional hooks — if: string (plain property, not a method)', () => {
  it('fires when the named plain-boolean property is truthy', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave({ if: 'isSpecial' })
      specialHook() { fired() }
    }

    const post = new Post({ id: 1, title: 'x' }, false)
    ;(post as any)._attributes.isSpecial = true   // plain truthy value
    ;(post as any).title = 'changed'
    await post.save()
    expect(fired).toHaveBeenCalledOnce()
  })

  it('does NOT fire when the named plain-boolean property is falsy', async () => {
    const fired = vi.fn()

    @model('posts')
    class Post extends ApplicationRecord {
      @beforeSave({ if: 'isSpecial' })
      specialHook() { fired() }
    }

    const post = new Post({ id: 1, title: 'x', isSpecial: false }, false)
    ;(post as any).title = 'changed'
    await post.save()
    expect(fired).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Hook registered with a non-existent method name — skipped gracefully
// ---------------------------------------------------------------------------

describe('Hook with non-existent method name', () => {
  it('skips silently when the method is missing instead of throwing', async () => {
    // Manually register a hook for a method that will never be defined
    const { registerHook } = await import('../../src/runtime/hooks.js')
    const { runHooks } = await import('../../src/runtime/hooks.js')

    class GhostPost extends ApplicationRecord {
      // deliberately no 'ghostMethod' — the hook points to something missing
    }
    registerHook(GhostPost.prototype, 'beforeSave', 'ghostMethod')

    const post = new GhostPost({ title: 'x' }, true)
    // Should NOT throw; runHooks silently skips missing methods
    await expect(runHooks(post, 'beforeSave', true)).resolves.toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Noop decorators — @memoize, @server, @computed, @scope
// (annotation-only, no runtime behaviour; just ensure they don't throw)
// ---------------------------------------------------------------------------

describe('Noop annotation decorators', () => {
  it('@memoize does not throw when applied', () => {
    class Demo extends ApplicationRecord {
      get expensive() { return 42 }
    }
    // Apply memoize manually via the descriptor API to exercise the function body
    const desc = Object.getOwnPropertyDescriptor(Demo.prototype, 'expensive')
    expect(() => memoize(Demo.prototype, 'expensive', desc!)).not.toThrow()
  })

  it('@server does not throw when applied', () => {
    class Demo extends ApplicationRecord {
      serverMethod() { return 'secret' }
    }
    const desc = Object.getOwnPropertyDescriptor(Demo.prototype, 'serverMethod')
    expect(() => server(Demo.prototype, 'serverMethod', desc!)).not.toThrow()
  })

  it('@computed does not throw when applied', () => {
    class Demo extends ApplicationRecord {
      static computedScope() { return Demo.all() }
    }
    const desc = Object.getOwnPropertyDescriptor(Demo, 'computedScope')
    expect(() => computed(Demo, 'computedScope', desc!)).not.toThrow()
  })

  it('@scope does not throw when applied', () => {
    class Demo extends ApplicationRecord {
      static myScope() { return Demo.all() }
    }
    const desc = Object.getOwnPropertyDescriptor(Demo, 'myScope')
    expect(() => scope(Demo, 'myScope', desc!)).not.toThrow()
  })
})
