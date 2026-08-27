/**
 * ChannelsConfig — transport WS4's first consumer of the scaffolded config
 * section: defaults, the coalesce clamp, and the boot teaching gates
 * (publish-only+memory, production-without-allowlist, oversized heartbeat).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveChannelsConfig, assertChannelsServable } from '../../src/config.js'

describe('resolveChannelsConfig', () => {
  it('applies every default', () => {
    const c = resolveChannelsConfig()
    expect(c).toEqual({
      bus: 'memory',
      redisUrl: undefined,
      path: '/cable',
      originAllowlist: undefined,
      heartbeatMs: 25_000,
      coalesceMs: 25,
      revalidate: 30,
      role: 'serve',
      tokenTtlMs: 10_000,
      maxConnections: 10_000,
      maxSubsPerConnection: 256,
    })
  })

  it('keeps explicit resource caps', () => {
    const c = resolveChannelsConfig({ maxConnections: 5, maxSubsPerConnection: 3 })
    expect(c.maxConnections).toBe(5)
    expect(c.maxSubsPerConnection).toBe(3)
  })

  it('keeps explicit values', () => {
    const c = resolveChannelsConfig({
      bus: 'pg-notify', path: '/live', heartbeatMs: 10_000,
      revalidate: 'always', role: 'publish-only', tokenTtlMs: 5_000,
      originAllowlist: ['https://app.example.com'],
    })
    expect(c.bus).toBe('pg-notify')
    expect(c.path).toBe('/live')
    expect(c.heartbeatMs).toBe(10_000)
    expect(c.revalidate).toBe('always')
    expect(c.role).toBe('publish-only')
    expect(c.tokenTtlMs).toBe(5_000)
    expect(c.originAllowlist).toEqual(['https://app.example.com'])
  })

  it('clamps coalesceMs to 20–50', () => {
    expect(resolveChannelsConfig({ coalesceMs: 5 }).coalesceMs).toBe(20)
    expect(resolveChannelsConfig({ coalesceMs: 500 }).coalesceMs).toBe(50)
    expect(resolveChannelsConfig({ coalesceMs: 30 }).coalesceMs).toBe(30)
  })
})

describe('assertChannelsServable', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses publish-only + memory (frames would go nowhere)', () => {
    const c = resolveChannelsConfig({ role: 'publish-only' })
    expect(() => assertChannelsServable(c, 'development')).toThrow(/publish-only.*memory.*nowhere/s)
  })

  it('refuses production serving without an origin allowlist (CSWSH)', () => {
    const c = resolveChannelsConfig({})
    expect(() => assertChannelsServable(c, 'production')).toThrow(/originAllowlist.*hijacking/s)
  })

  it('production passes WITH an allowlist; development passes without', () => {
    expect(() => assertChannelsServable(
      resolveChannelsConfig({ originAllowlist: ['https://app.example.com'] }), 'production',
    )).not.toThrow()
    expect(() => assertChannelsServable(resolveChannelsConfig({}), 'development')).not.toThrow()
  })

  it("refuses bus 'redis' without redisUrl; passes with one (env-referenced)", () => {
    expect(() => assertChannelsServable(resolveChannelsConfig({ bus: 'redis' }), 'development'))
      .toThrow(/redis.*redisUrl.*TWO dedicated.*process\.env\.REDIS_URL/s)
    expect(() => assertChannelsServable(
      resolveChannelsConfig({ bus: 'redis', redisUrl: 'redis://localhost:6379' }), 'development',
    )).not.toThrow()
  })

  it('warns (never throws) on a heartbeat that outlives proxy idle timeouts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    assertChannelsServable(resolveChannelsConfig({ heartbeatMs: 60_000 }), 'development')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/heartbeatMs.*idle/s))
    warn.mockClear()
    assertChannelsServable(resolveChannelsConfig({ heartbeatMs: 25_000 }), 'development')
    expect(warn).not.toHaveBeenCalled()
  })
})
