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
 *     channels: { bus: process.env.REDIS_URL ? 'redis' : 'memory',
 *                 redisUrl: process.env.REDIS_URL },
 *     environments: {
 *       production: { channels: { revalidate: 'always' } },
 *       test:       { server: { port: 0 } },
 *     },
 *   })
 */

export interface ChannelsConfig {
  /** Fan-out bus. 'memory' = single process. 'redis' = multi-process:
   *  every server publishes commits AND forwards bus frames to its own
   *  sockets — set REDIS_URL and it works (DESIGN-ws-channels §8). */
  bus?: 'memory' | 'redis'
  redisUrl?: string | undefined
  /** WS mount path on the HTTP server. */
  path?: string
  /** Door re-verification on emit: seconds of TTL cache, or 'always'. */
  revalidate?: number | 'always'
  /** 'serve' = hold sockets here (default). 'publish-only' = API processes
   *  in the dedicated channels-role topology (tier 3). */
  role?: 'serve' | 'publish-only'
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
