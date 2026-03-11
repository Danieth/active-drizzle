#!/usr/bin/env node
/**
 * Bump all @active-drizzle/* packages to the same version, build, and publish to npm.
 *
 * Usage:
 *   npm run release              # bumps patch (0.1.0 → 0.1.1)
 *   npm run release -- minor     # bumps minor (0.1.0 → 0.2.0)
 *   npm run release -- major     # bumps major (0.1.0 → 1.0.0)
 *   npm run release -- 0.3.5     # sets an exact version
 *   npm run release -- --dry-run # does everything except `npm publish`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const PACKAGES = [
  'packages/core/package.json',
  'packages/controller/package.json',
  'packages/react/package.json',
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bumpArg = args.find(a => a !== '--dry-run') ?? 'patch'

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  if (dryRun && cmd.startsWith('npm publish')) {
    console.log('  [dry-run] skipped')
    return
  }
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

function bumpVersion(current, bump) {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump
  const [major, minor, patch] = current.split('.').map(Number)
  switch (bump) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
    default: throw new Error(`Unknown bump type: ${bump}`)
  }
}

// ── Resolve new version ────────────────────────────────────────────────────

const currentVersion = readJson(resolve(root, PACKAGES[0])).version
const newVersion = bumpVersion(currentVersion, bumpArg)

console.log()
console.log(`  active-drizzle release`)
console.log(`  ${currentVersion} → ${newVersion}${dryRun ? ' (dry run)' : ''}`)
console.log()

// ── Bump all package.json files ────────────────────────────────────────────

for (const rel of PACKAGES) {
  const abs = resolve(root, rel)
  const pkg = readJson(abs)
  pkg.version = newVersion
  writeJson(abs, pkg)
  console.log(`  ✓ ${pkg.name} → ${newVersion}`)
}

// Also bump root package.json to keep it in sync
const rootPkg = readJson(resolve(root, 'package.json'))
rootPkg.version = newVersion
writeJson(resolve(root, 'package.json'), rootPkg)
console.log(`  ✓ root → ${newVersion}`)
console.log()

// ── Build all packages ─────────────────────────────────────────────────────

console.log('  Building...')
run('npm run build')
console.log()

// ── Publish in dependency order (core → controller → react) ────────────────

console.log('  Publishing...')
for (const rel of PACKAGES) {
  const abs = resolve(root, rel)
  const dir = dirname(abs)
  const pkg = readJson(abs)
  console.log(`  → ${pkg.name}@${newVersion}`)
  run(`npm publish --access public`, { cwd: dir })
}
console.log()

// ── Git tag ────────────────────────────────────────────────────────────────

const tag = `v${newVersion}`
console.log(`  Tagging ${tag}...`)
if (!dryRun) {
  run(`git add -A`)
  run(`git commit -m "release: ${tag}"`)
  run(`git tag ${tag}`)
  console.log(`  ✓ Tagged. Push with: git push && git push --tags`)
} else {
  console.log('  [dry-run] skipped git operations')
}

console.log()
console.log(`  Done! 🚀  ${dryRun ? '(dry run — nothing was actually published)' : ''}`)
console.log()
