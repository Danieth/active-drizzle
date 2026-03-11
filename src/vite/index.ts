/**
 * Vite plugin for active-drizzle.
 *
 * - Runs the full codegen pipeline on dev server start and on every `.model.ts` save
 * - Emits build errors for invalid associations, missing columns, enum type mismatches
 * - Writes generated files directly next to each model file
 * - Generates `_registry.gen.ts` and `.active-drizzle/schema.md` at the root
 *
 * Performance strategy:
 *   1. Persistent ts-morph Project — created once, refreshed per changed file.
 *   2. mtime-based ModelMeta cache — only changed files are re-extracted.
 *   3. Incremental validation — only models that changed plus their bidirectional
 *      association neighbours are re-validated; all others are served from a
 *      per-model diagnostic cache.
 *   4. Global-file hash guard — _registry.gen.ts / schema.md are regenerated only
 *      when the model list or schema actually changed.
 *   5. Write-only-if-changed — generated files are written to disk only when their
 *      content differs, preventing spurious Vite HMR rounds.
 *   6. Early exit — if neither schema nor any model file changed, the run is a no-op.
 */

import { Project, type CompilerOptions } from 'ts-morph'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { dirname, join, resolve, relative } from 'path'
import { glob } from 'glob'
import { extractSchema, extractModel } from '../codegen/extractor.js'
import { validate } from '../codegen/validator.js'
import {
  generateModelTypes,
  generateClientRuntime,
  generateRegistry,
  generateGlobals,
  generateDocs,
  type GeneratedFile,
} from '../codegen/generator.js'
import type { ProjectMeta, ModelMeta, SchemaMeta, Diagnostic } from '../codegen/types.js'

export type ActiveDrizzlePluginOptions = {
  /** Absolute or relative path to your Drizzle schema file */
  schema: string
  /** Glob pattern for model files, e.g. 'src/models/**\/*.model.ts' */
  models: string
  /** Where to write _registry.gen.ts (defaults to directory of first model file) */
  outputDir?: string
  /** tsconfig.json path (defaults to ./tsconfig.json) */
  tsconfig?: string
}

export default function activeDrizzle(options: ActiveDrizzlePluginOptions) {
  let root = process.cwd()

  // ── Per-plugin-instance state (survives hot-reloads, reset each build) ──────
  let project: Project | null = null
  let schemaCache: { path: string; mtime: number; meta: SchemaMeta } | null = null
  const modelCache   = new Map<string, { mtime: number; meta: ModelMeta }>()
  /** Per-model diagnostic cache — keyed by model filePath. */
  const diagCache    = new Map<string, Diagnostic[]>()
  /**
   * Hash of `className:tableName` for every model, in declaration order.
   * Used to guard whether global files (_registry, schema.md) need regeneration.
   */
  let lastGlobalHash: string | null = null

  function getOrCreateProject(): Project {
    if (project) return project
    const tsconfigPath = resolve(root, options.tsconfig ?? 'tsconfig.json')
    const compilerOptions: CompilerOptions = { strict: true, experimentalDecorators: true }
    const hasTsconfig = existsSync(tsconfigPath)
    project = new Project(
      hasTsconfig
        ? { tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: true }
        : { compilerOptions, skipAddingFilesFromTsConfig: true },
    )
    return project
  }

  async function runCodegen(): Promise<void> {
    const schemaPath = resolve(root, options.schema)
    const modelGlob  = resolve(root, options.models)

    if (!existsSync(schemaPath)) {
      console.error(`\x1b[31m[active-drizzle] Schema file not found: ${schemaPath}\x1b[0m`)
      return
    }

    const modelPaths = await glob(modelGlob.replace(/\\/g, '/'))
    if (modelPaths.length === 0) {
      console.warn(`\x1b[33m[active-drizzle] No model files found matching: ${options.models}\x1b[0m`)
      return
    }

    const p = getOrCreateProject()

    // ── Schema ───────────────────────────────────────────────────────────────
    const schemaMtime = statSync(schemaPath).mtimeMs
    let schema: SchemaMeta
    let schemaChanged = false
    if (schemaCache?.path === schemaPath && schemaCache.mtime === schemaMtime) {
      schema = schemaCache.meta
    } else {
      schemaChanged = true
      const sf = p.getSourceFile(schemaPath)
      if (sf) sf.refreshFromFileSystemSync()
      else p.addSourceFileAtPath(schemaPath)
      schema = extractSchema(p, schemaPath)
      schemaCache = { path: schemaPath, mtime: schemaMtime, meta: schema }
    }

    // ── Models ───────────────────────────────────────────────────────────────
    const models: ModelMeta[] = []
    const changedFilePaths = new Set<string>()

    for (const mp of modelPaths) {
      const mtime = statSync(mp).mtimeMs
      const cached = modelCache.get(mp)
      if (cached && cached.mtime === mtime) {
        models.push(cached.meta)
        continue
      }
      changedFilePaths.add(mp)
      const sf = p.getSourceFile(mp)
      if (sf) sf.refreshFromFileSystemSync()
      else p.addSourceFileAtPath(mp)
      const meta = extractModel(p, mp)
      modelCache.set(mp, { mtime, meta })
      models.push(meta)
    }

    // Prune deleted model files
    const modelPathSet = new Set(modelPaths)
    let modelListChanged = changedFilePaths.size > 0  // new files always change the list
    for (const [path] of modelCache) {
      if (!modelPathSet.has(path)) {
        modelCache.delete(path)
        diagCache.delete(path)
        p.getSourceFile(path)?.delete()
        modelListChanged = true
      }
    }

    // ── Early exit — nothing relevant changed ────────────────────────────────
    if (!schemaChanged && changedFilePaths.size === 0) return

    resolveAssociations(models, schema.tables)
    const projectMeta: ProjectMeta = { schema, models }

    // ── Validate (incremental) ───────────────────────────────────────────────
    //
    // When the schema changes, all cached diagnostics are stale (column checks
    // depend on the schema). Otherwise only re-validate:
    //   • models whose file changed
    //   • models that have an association pointing *to* a changed model's table
    //     (their bidirectional inverse check may now be stale)
    //   • models that a changed model associates *with* (same reason)
    if (schemaChanged) diagCache.clear()

    const toRevalidate = computeModelsToRevalidate(changedFilePaths, models, schemaChanged)

    const freshDiags = validate(projectMeta, toRevalidate)

    // Update per-model cache for every re-validated model
    for (const filePath of toRevalidate) {
      diagCache.set(filePath, freshDiags.filter(d => d.modelFile === filePath))
    }

    // Merge: fresh + still-cached
    const allDiags: Diagnostic[] = [...freshDiags]
    for (const model of models) {
      if (toRevalidate.has(model.filePath)) continue
      const cached = diagCache.get(model.filePath)
      if (cached) allDiags.push(...cached)
    }

    printDiagnostics(allDiags, root)

    // ── Generate ─────────────────────────────────────────────────────────────
    //
    // Per-model files are always regenerated (pure string concat, negligible cost).
    // Global files (_registry, schema.md, _globals) are skipped when the model
    // list and schema are both unchanged — their output would be identical.
    const globalHash = models.map(m => `${m.className}:${m.tableName}`).join('|')
    const globalsNeedRegen = schemaChanged || modelListChanged || globalHash !== lastGlobalHash
    lastGlobalHash = globalHash

    const files: GeneratedFile[] = []

    for (const model of models) {
      const base = model.filePath.split('/').pop()!.replace('.model.ts', '.model.gen')
      files.push({ path: `${base}.d.ts`, content: generateModelTypes(model, projectMeta) })
      files.push({ path: `${base}.ts`,   content: generateClientRuntime(model, projectMeta) })
    }

    if (globalsNeedRegen) {
      files.push({ path: '_registry.gen.ts',       content: generateRegistry(projectMeta) })
      files.push({ path: '.active-drizzle/schema.md', content: generateDocs(projectMeta) })
      files.push({ path: '_globals.gen.d.ts',      content: generateGlobals(projectMeta) })
    }

    // ── Write — skip unchanged files ─────────────────────────────────────────
    const firstModelDir = dirname(modelPaths[0]!)
    const outDir = resolve(root, options.outputDir ?? firstModelDir)
    let writtenCount = 0

    for (const file of files) {
      let targetPath: string
      if (file.path === '.active-drizzle/schema.md') {
        const docsDir = resolve(root, '.active-drizzle')
        mkdirSync(docsDir, { recursive: true })
        targetPath = resolve(root, file.path)
      } else if (file.path === '_registry.gen.ts' || file.path === '_globals.gen.d.ts') {
        targetPath = join(outDir, file.path)
      } else {
        const modelFile = modelPaths.find(mp =>
          mp.endsWith(file.path.replace('.gen.d.ts', '.ts').replace('.gen.ts', '.ts'))
        )
        const dir = modelFile ? dirname(modelFile) : outDir
        targetPath = join(dir, file.path)
      }

      const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
      if (existing !== file.content) {
        writeFileSync(targetPath, file.content, 'utf8')
        writtenCount++
      }
    }

    const errCount  = allDiags.filter(d => d.severity === 'error').length
    const warnCount = allDiags.filter(d => d.severity === 'warning').length

    if (errCount === 0) {
      const revalidated = toRevalidate.size
      const skippedVal  = models.length - revalidated
      const skippedWrite = files.length - writtenCount
      console.log(
        `\x1b[32m[active-drizzle] ✓ Codegen — ${models.length} models` +
        (skippedVal > 0 ? `, ${revalidated} validated (${skippedVal} cached)` : ', all validated') +
        `, ${writtenCount} file${writtenCount !== 1 ? 's' : ''} written` +
        (skippedWrite > 0 ? `, ${skippedWrite} unchanged` : '') +
        (warnCount > 0 ? ` (${warnCount} warnings)` : '') +
        '\x1b[0m',
      )
    }
  }

  return {
    name: 'active-drizzle',
    enforce: 'pre' as const,

    configResolved(config: { root: string }) {
      root = config.root
    },

    async buildStart() {
      // Production builds always start clean
      schemaCache  = null
      lastGlobalHash = null
      modelCache.clear()
      diagCache.clear()
      project = null
      await runCodegen()
    },

    configureServer(server: { watcher: any; ws: any; config: { root: string } }) {
      root = server.config.root

      server.watcher.on('change', async (file: string) => {
        if (file.endsWith('.model.ts') || file === resolve(root, options.schema)) {
          await runCodegen()
          server.ws.send({ type: 'full-reload' })
        }
      })

      server.watcher.on('add', async (file: string) => {
        if (file.endsWith('.model.ts')) {
          await runCodegen()
        }
      })
    },
  }
}

// ── Incremental validation helpers ───────────────────────────────────────────

/**
 * Returns the set of model filePaths that need re-validation after a set of
 * files changed.
 *
 * Beyond the directly changed models, two neighbour categories are included:
 *   1. Models that have an association *pointing to* a changed model's table —
 *      their bidirectional inverse check may now be stale.
 *   2. Models that a changed model *associates with* — same reason (the changed
 *      model may have added/removed the inverse the target expects).
 *
 * When the schema changed, every model is affected (column checks depend on it),
 * so the full set is returned immediately.
 */
function computeModelsToRevalidate(
  changedFilePaths: Set<string>,
  models: ModelMeta[],
  schemaChanged: boolean,
): Set<string> {
  if (schemaChanged) return new Set(models.map(m => m.filePath))

  const toRevalidate = new Set<string>(changedFilePaths)

  for (const filePath of changedFilePaths) {
    const changed = models.find(m => m.filePath === filePath)
    if (!changed) continue

    for (const other of models) {
      if (other.filePath === filePath) continue

      // other → changed  (other has an assoc pointing at changed's table)
      const refersToChanged = other.associations.some(
        a => a.resolvedTable === changed.tableName || a.explicitTable === changed.tableName,
      )
      if (refersToChanged) toRevalidate.add(other.filePath)

      // changed → other  (changed has an assoc pointing at other's table)
      const changedRefersToOther = changed.associations.some(
        a => a.resolvedTable === other.tableName || a.explicitTable === other.tableName,
      )
      if (changedRefersToOther) toRevalidate.add(other.filePath)
    }
  }

  return toRevalidate
}

// ── Diagnostic printer ────────────────────────────────────────────────────────

function printDiagnostics(diagnostics: Diagnostic[], root: string): void {
  for (const d of diagnostics) {
    const relPath = relative(root, d.modelFile)
    const prefix = d.severity === 'error'
      ? '\x1b[31m[active-drizzle] ERROR'
      : '\x1b[33m[active-drizzle] WARN'
    const suffix = d.suggestion ? `\n  → ${d.suggestion}` : ''
    console.log(`${prefix} ${relPath}: ${d.message}${suffix}\x1b[0m`)
  }
}

// ── Association resolver ──────────────────────────────────────────────────────

/**
 * Fills in `resolvedTable` on each AssociationMeta by:
 * 1. Using the explicit table if provided
 * 2. Searching the schema tables for a matching pluralized / singularized name
 */
function resolveAssociations(
  models: import('../codegen/types.js').ModelMeta[],
  tables: Record<string, unknown>
): void {
  for (const model of models) {
    for (const assoc of model.associations) {
      if (assoc.resolvedTable) continue

      const candidate = assoc.explicitTable ?? inferTableName(assoc.propertyName)
      if (candidate && candidate in tables) {
        assoc.resolvedTable = candidate
      }
    }
  }
}

function inferTableName(propertyName: string): string {
  // Simple pluralization: already plural → keep; singular → add 's'
  // The extractor's pluralize handles the full logic; here we just check the obvious case
  return propertyName.endsWith('s') ? propertyName : propertyName + 's'
}
