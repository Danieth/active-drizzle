/**
 * trails.config.ts — the ONE configuration file, loaded at boot.
 *
 * Design (vs Rails):
 *   - Rails splits config/application.rb + config/environments/*.rb because
 *     Ruby config is imperative patching of a live framework object. A typed
 *     JS value doesn't need the split — so environments live INSIDE the one
 *     master file as override blocks, deep-merged over the base by NODE_ENV
 *     at boot. One screen, one grep, whole story.
 *   - Secrets NEVER live in the file. The file REFERENCES process.env
 *     (`redisUrl: process.env.REDIS_URL`) — the file is committable, the
 *     values are deploy-time. This is the other half of what Rails'
 *     credentials split protects, kept without the machinery.
 *   - It is JavaScript on purpose: computed values, comments, and the type
 *     checker all work. It is NOT a place for logic — export data.
 *
 *   // trails.config.ts
 *   import { defineConfig } from 'active-drizzle'
 *   export default defineConfig({
 *     server:   { port: 8787 },
 *     database: { url: process.env.DATABASE_URL ?? 'postgres://localhost/dev' },
 *     channels: { bus: 'memory' },   // multi-process: opt into 'pg-notify'
 *     environments: {
 *       production: { channels: { revalidate: 'always' } },
 *       test:       { server: { port: 0 } },
 *     },
 *   })
 */

export interface ChannelsConfig {
  /**
   * Fan-out bus tier (transport WS4). 'memory' (default) = single process,
   * zero infrastructure. 'pg-notify' = multi-process FALLBACK over Postgres
   * LISTEN/NOTIFY — deliberately opt-in, never a silent default: NOTIFY
   * takes a global commit-order lock (the `class 1262 … database 0`
   * lock-wait is the overload signal) and needs a session-mode connection
   * (PgBouncer transaction pooling breaks LISTEN). 'redis' / 'nats' are
   * typed adapter stubs today (their constructors teach).
   */
  bus?: 'memory' | 'pg-notify' | 'redis' | 'nats'
  redisUrl?: string | undefined
  /** WS mount path on the HTTP server. Default '/cable'. */
  path?: string
  /**
   * Browser Origins allowed to open the WebSocket (CSWSH — the upgrade
   * request rides ambient cookies, so Origin is the ONLY thing separating
   * your app from evil.example embedding a socket to it; landmine 6).
   * REQUIRED in production when serving; development defaults to localhost.
   */
  originAllowlist?: string[]
  /**
   * Server heartbeat interval, ms (default 25000). Protocol-level ws pings —
   * values above 55000 outlive common proxy idle timeouts (Cloudflare 100s,
   * ALB/nginx 60s default) and are warned about at boot.
   */
  heartbeatMs?: number
  /**
   * Frame coalescing window per channel, ms (default 25, clamped 20–50):
   * same-pk commits inside the window supersede; multi-row batches share
   * one CHANGE frame. Safe ONLY because frames are absolute values with
   * tokens under Rule M (C1) — a future delta lane must bypass coalescing.
   */
  coalesceMs?: number
  /**
   * Door re-verification on emit: seconds of TTL cache (default 30), or
   * 'always' (the paranoid tier). Gates BOTH lanes: record subs re-check by
   * reloading through the door; index subs re-run the index dry-run; an
   * expired-pass destroy frame downgrades to RESET (the re-SUB re-answers
   * it through the door's validate/tombstone fences). Inside the TTL a
   * just-revoked subscriber can receive up to this many seconds of frames —
   * the T9 bounded leak, accepted and stated here rather than discovered.
   */
  revalidate?: number | 'always'
  /**
   * Resource caps per gateway process (authenticated-DoS bounds; every SUB
   * dry-run is a real DB query and every connection holds buffers):
   * maxConnections refuses upgrades with 503 at the cap (default 10000);
   * maxSubsPerConnection refuses further SUBs with SUB_LIMIT (default 256)
   * — it is also the SUB rate-limiter's burst size (a reconnect re-SUBs
   * everything at once; sustained abuse beyond ~20 SUB/s answers
   * RATE_LIMITED). Client payload frames are capped at 64KB (`ws`
   * maxPayload — control frames are tiny; CHANGE is server→client only).
   */
  maxConnections?: number
  maxSubsPerConnection?: number
  /** 'serve' = hold sockets here (default). 'publish-only' = API processes
   *  in the dedicated channels-role topology (tier 3). */
  role?: 'serve' | 'publish-only'
  /**
   * One-time WS upgrade token TTL, ms (default 10000). Minted over authed
   * HTTP, consumed once at upgrade — short + single-use is why a
   * query-string token is acceptable here (browsers cannot set upgrade
   * headers; the never-in-query-strings rule targets long-lived
   * credentials). NOTE: the token map is in-memory — mint and upgrade must
   * hit the SAME process (sticky LB) until a shared store ships.
   */
  tokenTtlMs?: number
}

/** ChannelsConfig with every default applied — what the gateway/bus read. */
export interface ResolvedChannelsConfig {
  bus: 'memory' | 'pg-notify' | 'redis' | 'nats'
  redisUrl: string | undefined
  path: string
  originAllowlist: string[] | undefined
  heartbeatMs: number
  coalesceMs: number
  revalidate: number | 'always'
  role: 'serve' | 'publish-only'
  tokenTtlMs: number
  maxConnections: number
  maxSubsPerConnection: number
}

/**
 * Apply the channel defaults (transport WS4 — ChannelsConfig's first
 * consumer). Pure: refusals live in assertChannelsServable so read-only
 * tooling can resolve without booting a gateway.
 */
export function resolveChannelsConfig(channels: ChannelsConfig = {}): ResolvedChannelsConfig {
  const coalesceRaw = channels.coalesceMs ?? 25
  return {
    bus: channels.bus ?? 'memory',
    redisUrl: channels.redisUrl,
    path: channels.path ?? '/cable',
    originAllowlist: channels.originAllowlist,
    heartbeatMs: channels.heartbeatMs ?? 25_000,
    // Clamp 20–50: below 20ms coalescing stops paying for itself (frame per
    // keystroke), above 50ms typing latency is human-visible.
    coalesceMs: Math.min(50, Math.max(20, coalesceRaw)),
    revalidate: channels.revalidate ?? 30,
    role: channels.role ?? 'serve',
    tokenTtlMs: channels.tokenTtlMs ?? 10_000,
    maxConnections: channels.maxConnections ?? 10_000,
    maxSubsPerConnection: channels.maxSubsPerConnection ?? 256,
  }
}

/**
 * Boot-time teaching gates for a SERVING gateway. Throws (never warns) on
 * configurations that would run while silently broken; warns on the
 * heartbeat foot-gun. `env` defaults to NODE_ENV.
 */
export function assertChannelsServable(
  resolved: ResolvedChannelsConfig,
  env: string = process.env.NODE_ENV || 'development',
): void {
  if (resolved.role === 'publish-only' && resolved.bus === 'memory') {
    throw new Error(
      `trails.config channels: role 'publish-only' with bus 'memory' publishes frames to nowhere — ` +
      `an in-memory bus never leaves this process, and a publish-only process holds no sockets. ` +
      `Set a cross-process bus (bus: 'pg-notify') or drop role: 'publish-only'.`,
    )
  }
  if (env === 'production' && resolved.role === 'serve'
      && (!resolved.originAllowlist || resolved.originAllowlist.length === 0)) {
    throw new Error(
      `trails.config channels: originAllowlist is required in production. The WS upgrade request ` +
      `carries the browser's ambient cookies, so WITHOUT an Origin check any site the user visits ` +
      `can open an authenticated socket to your app (cross-site WebSocket hijacking). List your ` +
      `app origins: channels: { originAllowlist: ['https://app.example.com'] }.`,
    )
  }
  if (resolved.heartbeatMs > 55_000) {
    // eslint-disable-next-line no-console
    console.warn(
      `[active-drizzle] channels.heartbeatMs = ${resolved.heartbeatMs} outlives common proxy idle ` +
      `timeouts (Cloudflare 100s fixed, ALB and nginx 60s default) — idle sockets will be severed ` +
      `by infrastructure between heartbeats. 25000 (the default) is a safe ceiling.`,
    )
  }
}

export interface TrailsConfig {
  server?: { port?: number; host?: string }
  database?: { url?: string }
  channels?: ChannelsConfig
  codegen?: {
    /** Extra directories scanned for models/controllers (vite plugin). */
    include?: string[]
  }
  /** App-defined settings ride along, typed by the app via declaration
   *  merging if it wants — the loader deep-merges them like everything. */
  [section: string]: unknown
}

export interface TrailsConfigFile extends TrailsConfig {
  /** Per-environment overrides, deep-merged over the base by NODE_ENV. */
  environments?: Partial<Record<string, TrailsConfig>>
}

/** Identity with types — exists so the config file autocompletes and
 *  typechecks without importing anything else. */
export function defineConfig(config: TrailsConfigFile): TrailsConfigFile {
  return config
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Environment blocks override the base: objects merge deep, everything
 *  else (arrays included) replaces wholesale — an env that sets a list
 *  MEANS that list. */
export function mergeConfig<T extends Record<string, any>>(base: T, over: Record<string, any> | undefined): T {
  if (!over) return base
  const out: Record<string, any> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : v
  }
  return out as T
}

/**
 * Resolve the config VALUE for an environment: base + environments[env],
 * with the `environments` block itself stripped from the result. Pure —
 * file loading stays in loadConfig so this is trivially testable.
 */
/** Sections the framework reads. App-defined sections are welcome (the
 *  config is an open bag) — but a NEAR-MISS of a framework key is a typo,
 *  and a typo'd `databse:` silently booting against defaults is the
 *  highest-blast-radius silent failure a config can have. */
const KNOWN_SECTIONS = ['server', 'database', 'channels', 'codegen', 'environments']

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

/** Teaching gate: an unknown top-level key that is 1–2 edits from a
 *  framework section is a TYPO, not an app extension — throw with the fix. */
export function assertNoConfigTypos(file: Record<string, unknown>): void {
  for (const key of Object.keys(file)) {
    if (KNOWN_SECTIONS.includes(key)) continue
    const near = KNOWN_SECTIONS.find(k => editDistance(key.toLowerCase(), k) <= 2)
    if (near) {
      throw new Error(
        `trails.config: unknown section '${key}' — did you mean '${near}'? ` +
        `(A truly custom section is fine, but this one is ${key.length < 10 ? 'suspiciously' : ''} ` +
        `close to a framework key, and a typo'd '${near}' silently boots against defaults.)`,
      )
    }
  }
}

export function resolveConfig(file: TrailsConfigFile, env: string): TrailsConfig {
  assertNoConfigTypos(file as Record<string, unknown>)
  const { environments, ...base } = file
  return Object.freeze(mergeConfig(base, environments?.[env]))
}

/** The resolved config, cached after the first load. */
let _config: TrailsConfig | null = null

/**
 * Load trails.config.ts (or .js/.mts/.mjs) from the app root at boot.
 * Missing file → empty config (everything defaults) — the file is an
 * offer, not a requirement. NODE_ENV picks the environment block
 * (default 'development').
 */
export async function loadConfig(rootDir: string = process.cwd()): Promise<TrailsConfig> {
  if (_config) return _config
  const env = process.env.NODE_ENV || 'development'
  const { existsSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  const { join } = await import('node:path')
  for (const name of ['trails.config.ts', 'trails.config.mts', 'trails.config.js', 'trails.config.mjs']) {
    const full = join(rootDir, name)
    if (!existsSync(full)) continue
    const mod = await import(/* @vite-ignore */ pathToFileURL(full).href)
    const file: TrailsConfigFile = mod.default ?? mod.config ?? {}
    _config = resolveConfig(file, env)
    return _config
  }
  _config = Object.freeze({})
  return _config
}

/** Test seam / hot-reload escape hatch. */
export function resetConfig(): void {
  _config = null
}
