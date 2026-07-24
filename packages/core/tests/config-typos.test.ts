/** The config typo gate — `databse:` must never silently boot defaults. */
import { describe, it, expect } from 'vitest'
import { assertNoConfigTypos, resolveConfig } from '../src/config.js'

describe('trails.config typo gate', () => {
  it('near-misses of framework sections throw with did-you-mean', () => {
    expect(() => assertNoConfigTypos({ databse: {} })).toThrow(/did you mean 'database'/)
    expect(() => assertNoConfigTypos({ serverr: {} })).toThrow(/did you mean 'server'/)
    expect(() => resolveConfig({ chanels: {} } as any, 'development')).toThrow(/channels/)
  })
  it('genuinely custom sections pass (the config stays an open bag)', () => {
    expect(() => assertNoConfigTypos({ stripe: { key: 'x' }, myFeatureFlags: {} })).not.toThrow()
    expect(() => resolveConfig({ server: { port: 1 }, stripe: {} } as any, 'development')).not.toThrow()
  })
})
