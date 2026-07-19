/**
 * trails.config — one master file, environments as inline overrides,
 * deep-merge semantics pinned (objects merge, arrays replace, secrets
 * stay in process.env references — the loader never touches them).
 */
import { describe, it, expect } from 'vitest'
import { defineConfig, resolveConfig, mergeConfig } from '../../src/config.js'

describe('resolveConfig', () => {
  const file = defineConfig({
    server: { port: 8787, host: 'localhost' },
    channels: { bus: 'memory', revalidate: 30 },
    codegen: { include: ['server/models'] },
    environments: {
      production: {
        server: { port: 80 },                       // deep-merges: host survives
        channels: { bus: 'redis', revalidate: 'always' },
        codegen: { include: ['dist/models'] },      // arrays REPLACE wholesale
      },
      test: { server: { port: 0 } },
    },
  })

  it('development = the base, environments block stripped', () => {
    const c = resolveConfig(file, 'development')
    expect(c.server).toEqual({ port: 8787, host: 'localhost' })
    expect(c.channels).toEqual({ bus: 'memory', revalidate: 30 })
    expect((c as any).environments).toBeUndefined()
  })

  it('production deep-merges objects and replaces arrays', () => {
    const c = resolveConfig(file, 'production')
    expect(c.server).toEqual({ port: 80, host: 'localhost' })   // host survived the merge
    expect(c.channels).toEqual({ bus: 'redis', revalidate: 'always' })
    expect(c.codegen).toEqual({ include: ['dist/models'] })     // replaced, not concatenated
  })

  it('an unknown environment = the base; result is frozen', () => {
    const c = resolveConfig(file, 'staging')
    expect(c.server!.port).toBe(8787)
    expect(Object.isFrozen(c)).toBe(true)
  })

  it('app-defined sections ride along and merge like everything else', () => {
    const c = resolveConfig(defineConfig({
      mailer: { from: 'a@b.c', retries: 3 },
      environments: { production: { mailer: { retries: 10 } } },
    } as any), 'production')
    expect((c as any).mailer).toEqual({ from: 'a@b.c', retries: 10 })
  })
})

describe('mergeConfig', () => {
  it('null/scalars replace; nested objects merge recursively', () => {
    expect(mergeConfig({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 }, d: null }))
      .toEqual({ a: { b: 9, c: 2 }, d: null })
  })
})
