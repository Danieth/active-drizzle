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
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'fs'
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
import { extractControllers } from '../codegen/controller-extractor.js'
import { generateRoutesFile, generateRoutesDoc } from '../codegen/controller-generator.js'
import { generateReactHooks } from '../codegen/react-generator.js'

export type ActiveDrizzlePluginOptions = {
  /** Absolute or relative path to your Drizzle schema file */
  schema: string
  /** Glob pattern for model files, e.g. 'src/models/**\/*.model.ts' */
  models: string
  /**
   * Optional glob pattern for controller files.
   * When provided, controller metadata is extracted and _routes.gen.ts is generated.
   * e.g. 'src/controllers/**\/*.ctrl.ts'
   */
  controllers?: string
  /** Where to write _registry.gen.ts (defaults to directory of first model file) */
  outputDir?: string
  /**
   * When true, generates React hooks alongside controller files.
   * Requires `controllers` option to be set.
   */
  reactHooks?: boolean
  /** tsconfig.json path (defaults to ./tsconfig.json) */
  tsconfig?: string
  /**
   * Generated-output home. Default '.gen': every generated file lands in
   * `<genDir>/models` + `<genDir>/controllers` instead of beside its
   * source, and the plugin injects a vite alias `@gen` → `<genDir>` so
   * apps write `import { Deals } from '@gen/controllers'`. Add the
   * matching tsconfig paths entry for editor resolution:
   *   "baseUrl": ".", "paths": { "@gen/*": [".gen/*"] }
   * Set `false` for the legacy co-located layout.
   */
  genDir?: string | false
  /**
   * The presenter tree root (DESIGN-presenter-tree.md). When set, every
   * regen runs the presenter PIPELINE: scaffold missing kind bulbs +
   * model forms (generate-then-keep), verify the three laws (coverage,
   * no-shadow, chrome), and emit the registry/context/forms/manifest
   * into <presenters>/.gen. Example: presenters: 'presenters' (or the
   * demo's 'src/presenters').
   */
  presenters?: string
}

/** Relative import specifier from one dir to another (posix, ./-prefixed). */
function relImport(fromDir: string, toDir: string): string {
  let rel = relative(fromDir, toDir).split('\\').join('/')
  if (rel === '') rel = '.'
  if (!rel.startsWith('.')) rel = './' + rel
  return rel
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

  // ── Controller state ─────────────────────────────────────────────────────────
  const ctrlCache = new Map<string, { mtime: number }>()
  let lastRouteHash: string | null = null

  // ── Dev-watcher scheduler state ────────────────────────────────────────────
  // The watcher must never let a codegen error escape as an unhandled rejection
  // (over a long dev session that wedges auto-regeneration — it "just stops").
  // Runs are serialized + coalesced; on failure we reset all caches so the next
  // save rebuilds from a clean slate.
  let codegenInFlight: Promise<void> | null = null
  let pendingRun: null | (() => Promise<boolean>) = null
  let reloadPage: () => void = () => {}

  /** Drop every cache so the next codegen run rebuilds the ts-morph project + metadata from scratch. */
  function resetCodegenState(): void {
    schemaCache    = null
    lastGlobalHash = null
    lastRouteHash  = null
    modelCache.clear()
    diagCache.clear()
    ctrlCache.clear()
    project = null
  }

  /**
   * Serialized, crash-proof codegen scheduler for the dev watcher.
   * Coalesces rapid saves to a single trailing run; a thrown codegen error is
   * logged and self-healed (caches reset) instead of rejecting the handler.
   * Fires a full-reload only when the run reports a runtime file actually changed.
   */
  // Returns the in-flight drain promise. It NEVER rejects (errors are caught
  // and self-healed below), so Vite's watcher can ignore it while tests await it.
  function scheduleCodegen(run: () => Promise<boolean>): Promise<void> {
    pendingRun = run
    if (!codegenInFlight) codegenInFlight = drainCodegen()
    return codegenInFlight
  }
  async function drainCodegen(): Promise<void> {
    try {
      while (pendingRun) {
        const run = pendingRun
        pendingRun = null
        let runtimeChanged = false
        try {
          runtimeChanged = await run()
        } catch (err) {
          console.error(
            `\x1b[31m[active-drizzle] codegen failed — auto-regeneration will retry on the next save.\x1b[0m`,
            err instanceof Error ? (err.stack ?? err.message) : err,
          )
          resetCodegenState()
        }
        if (runtimeChanged) reloadPage()
      }
    } finally {
      codegenInFlight = null
    }
  }

  /**
   * Whether a changed path IS the configured schema file. Exact string equality
   * (`file === resolve(root, options.schema)`) silently misses schema edits when
   * the watcher emits a path that differs only by symlink/normalization — a
   * symlinked root (macOS /tmp→/private/tmp), a pnpm store, or differing
   * separators. Fall back to comparing realpaths so those still regenerate.
   * (Model files are immune — matched by `.endsWith('.model.ts')`.)
   */
  function isSchemaFile(file: string): boolean {
    const schemaAbs = resolve(root, options.schema)
    if (file === schemaAbs) return true
    try {
      return realpathSync(file) === realpathSync(schemaAbs)
    } catch {
      return false
    }
  }

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

  /** Runs the full model codegen pipeline. Returns whether any *runtime* file (a `.gen.ts`, not a `.d.ts`) changed — i.e. whether a page reload is warranted. */
  async function runCodegen(): Promise<boolean> {
    const schemaPath = resolve(root, options.schema)
    const modelGlob  = resolve(root, options.models)

    if (!existsSync(schemaPath)) {
      console.error(`\x1b[31m[active-drizzle] Schema file not found: ${schemaPath}\x1b[0m`)
      return false
    }

    const modelPaths = await glob(modelGlob.replace(/\\/g, '/'))
    if (modelPaths.length === 0) {
      console.warn(`\x1b[33m[active-drizzle] No model files found matching: ${options.models}\x1b[0m`)
      return false
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
    if (!schemaChanged && changedFilePaths.size === 0) return false

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
    const firstModelDir = dirname(modelPaths[0]!)
    // .gen mode (default): generated files live under <genDir>/models,
    // OUT of the source tree; imports back to sources use a computed prefix
    const genRoot = options.genDir === false ? null : resolve(root, options.genDir ?? '.gen')
    const outDir = genRoot ? join(genRoot, 'models') : resolve(root, options.outputDir ?? firstModelDir)
    const srcPrefix = genRoot ? relImport(outDir, firstModelDir) : '.'
    mkdirSync(outDir, { recursive: true })

    for (const model of models) {
      const base = model.filePath.split('/').pop()!.replace('.model.ts', '.model.gen')
      // .types.gen.d.ts — NOT `${base}.d.ts`: a d.ts sharing its basename
      // with the sibling .gen.ts is treated by tsc's include rules as that
      // file's build output and silently dropped from the program, which
      // killed every `declare module` augmentation under `tsc --noEmit`.
      const typesBase = base.replace(/\.model\.gen$/, '.model.types.gen')
      files.push({ path: `${typesBase}.d.ts`, content: generateModelTypes(model, projectMeta, srcPrefix) })
      files.push({ path: `${base}.ts`,   content: generateClientRuntime(model, projectMeta, srcPrefix) })
    }

    if (globalsNeedRegen) {
      files.push({ path: '_registry.gen.ts',       content: generateRegistry(projectMeta, outDir) })
      files.push({ path: '.active-drizzle/schema.md', content: generateDocs(projectMeta) })
      files.push({ path: '_globals.gen.d.ts',      content: generateGlobals(projectMeta, outDir) })
      if (genRoot) {
        // models barrel → import { DealClient } from '@gen/models'
        const barrel = ['// AUTO-GENERATED — DO NOT EDIT', '',
          ...models.map(m => `export * from './${m.filePath.split('/').pop()!.replace('.model.ts', '.model.gen')}'`), '']
        files.push({ path: 'index.ts', content: barrel.join('\n') })
      }
    }

    // ── Write — skip unchanged files ─────────────────────────────────────────
    let writtenCount = 0
    // A page reload is only warranted when an *executable* artifact changes.
    // `.d.ts` (types) and `.md` (docs) don't affect the running bundle, so a
    // save that only touches those must NOT trigger a full-reload.
    let runtimeChanged = false

    for (const file of files) {
      let targetPath: string
      if (file.path === '.active-drizzle/schema.md') {
        const docsDir = resolve(root, '.active-drizzle')
        mkdirSync(docsDir, { recursive: true })
        targetPath = resolve(root, file.path)
      } else if (file.path === '_registry.gen.ts' || file.path === '_globals.gen.d.ts') {
        targetPath = join(outDir, file.path)
      } else if (genRoot) {
        targetPath = join(outDir, file.path)
      } else {
        const modelFile = modelPaths.find(mp =>
          mp.endsWith(file.path.replace('.types.gen.d.ts', '.ts').replace('.gen.d.ts', '.ts').replace('.gen.ts', '.ts'))
        )
        const dir = modelFile ? dirname(modelFile) : outDir
        targetPath = join(dir, file.path)
      }

      const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
      if (existing !== file.content) {
        writeFileSync(targetPath, file.content, 'utf8')
        writtenCount++
        if (targetPath.endsWith('.ts') && !targetPath.endsWith('.d.ts')) runtimeChanged = true
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

    // ── Controller codegen (optional) ─────────────────────────────────────────
    let ctrlRuntimeChanged = false
    if (options.controllers) {
      ctrlRuntimeChanged = await runControllerCodegen()
    }
    return runtimeChanged || ctrlRuntimeChanged
  }

  /** Runs controller/route codegen. Returns whether a runtime file (_routes.gen.ts or a React hook) changed. */
  async function runControllerCodegen(): Promise<boolean> {
    if (!options.controllers) return false
    const ctrlGlob = resolve(root, options.controllers)
    const ctrlPaths = await glob(ctrlGlob.replace(/\\/g, '/'))
    if (ctrlPaths.length === 0) return false

    // Check if any ctrl file changed
    let anyChanged = false
    for (const cp of ctrlPaths) {
      const mtime = statSync(cp).mtimeMs
      const cached = ctrlCache.get(cp)
      if (!cached || cached.mtime !== mtime) {
        ctrlCache.set(cp, { mtime })
        anyChanged = true
      }
    }

    // Prune deleted controller files
    for (const [path] of ctrlCache) {
      if (!ctrlPaths.includes(path)) { ctrlCache.delete(path); anyChanged = true }
    }

    // Global hash guard — skip regeneration if routes haven't changed
    const routeHash = ctrlPaths.sort().join(':')
    if (!anyChanged && routeHash === lastRouteHash) return false
    lastRouteHash = routeHash

    const p = getOrCreateProject()
    const ctrlMeta = extractControllers(p, ctrlPaths)

    // Output dir: <genDir>/controllers (default), or legacy co-located
    const genRoot = options.genDir === false ? null : resolve(root, options.genDir ?? '.gen')
    const ctrlSrcDir = dirname(ctrlPaths[0]!)
    const outDir = genRoot ? join(genRoot, 'controllers')
      : options.outputDir ? resolve(root, options.outputDir)
      : ctrlSrcDir
    // _client.ts is USER-OWNED wiring — it stays in the source controllers
    // dir (never inside a sweepable/gitignored generated tree); generated
    // files import it through this prefix
    const clientDir = genRoot ? ctrlSrcDir : outDir
    const clientImportPrefix = genRoot ? relImport(outDir, ctrlSrcDir) : '.'

    mkdirSync(outDir, { recursive: true })

    const routesFilePath = join(outDir, '_routes.gen.ts')
    const routesDocPath  = join(outDir, '_routes.gen.md')

    const routesContent  = generateRoutesFile(ctrlMeta, routesFilePath)
    const routesDocContent = generateRoutesDoc(ctrlMeta)
    // USING.gen.md — the per-app usage guide (one source, projected at
    // prose): hooks-factory pattern, wire shapes, wire vocabulary — the
    // conventions a file-reading LLM can't discover from types alone
    const { generateUsingDoc } = await import('../codegen/using-doc.js')
    writeIfChanged(join(outDir, 'USING.gen.md'), generateUsingDoc(ctrlMeta, null))

    // _routes.gen.ts is executable (runtime) → reload-worthy; the .md is docs.
    const routesChanged = writeIfChanged(routesFilePath, routesContent)
    writeIfChanged(routesDocPath, routesDocContent)

    let hookCount = 0
    if (options.reactHooks) {
      // Build a minimal ProjectMeta for model column information
      const modelGlob = resolve(root, options.models)
      const modelPaths = await glob(modelGlob.replace(/\\/g, '/'))
      const p2 = getOrCreateProject()
      const extractedModels = modelPaths.map(mp => {
        const cached = modelCache.get(mp)
        if (cached) return cached.meta
        const sf = p2.getSourceFile(mp)
        if (sf) sf.refreshFromFileSystemSync()
        else p2.addSourceFileAtPath(mp)
        return extractModel(p2, mp)
      })
      // Reuse schemaCache if available
      const schemaPath = resolve(root, options.schema)
      let schemaMeta = schemaCache?.meta
      if (!schemaMeta) {
        const p3 = getOrCreateProject()
        p3.addSourceFileAtPath(schemaPath)
        const { extractSchema: es } = await import('../codegen/extractor.js')
        schemaMeta = es(p3, schemaPath)
      }
      const projectMeta = { schema: schemaMeta!, models: extractedModels }

      const hookFiles = generateReactHooks(ctrlMeta, projectMeta, outDir, { clientDir, clientImportPrefix })
      for (const f of hookFiles) {
        // _client.ts is user-owned — only write if it doesn't exist yet
        if (f.skipIfExists) {
          const { existsSync } = await import('node:fs')
          if (existsSync(f.filePath)) continue
        }
        const changed = writeIfChanged(f.filePath, f.content)
        if (changed) hookCount++
      }
    }

    // ── The presenter pipeline (DESIGN-presenter-tree) ───────────────────
    if (options.presenters && options.reactHooks) {
      const presentersDir = resolve(root, options.presenters)
      const { runPresenterPipeline } = await import('../codegen/presenter-pipeline.js')
      const modelGlob2 = resolve(root, options.models)
      const modelPaths2 = await glob(modelGlob2.replace(/\\/g, '/'))
      const p4 = getOrCreateProject()
      const models2 = modelPaths2.map(mp => {
        const cached = modelCache.get(mp)
        if (cached) return cached.meta
        return extractModel(p4, mp)
      })
      const projectMeta2 = { schema: schemaCache?.meta ?? { tables: {}, filePath: '' }, models: models2 } as any
      const { report } = runPresenterPipeline(p4, projectMeta2, ctrlMeta, presentersDir)
      console.log(`\x1b[32m[active-drizzle] presenter tree\x1b[0m\n${report.split('\n').map(l => '  ' + l).join('\n')}`)
    }

    console.log(
      `\x1b[32m[active-drizzle] ✓ Routes — ${ctrlMeta.controllers.length} controllers → _routes.gen.ts` +
      (hookCount > 0 ? ` + ${hookCount} React hooks` : '') +
      '\x1b[0m',
    )

    return routesChanged || hookCount > 0
  }

  return {
    name: 'active-drizzle',
    enforce: 'pre' as const,

    config(userConfig: { root?: string }) {
      if (options.genDir === false) return undefined
      // `import { Deals } from '@gen/controllers'` — everywhere, no ../..
      const r = userConfig.root ? resolve(userConfig.root) : process.cwd()
      return { resolve: { alias: { '@gen': resolve(r, options.genDir ?? '.gen') } } }
    },

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
      reloadPage = () => server.ws.send({ type: 'full-reload' })

      // NOTE: hand each event to scheduleCodegen (crash-proof + serialized +
      // coalesced). We deliberately do NOT `await` here or send an unconditional
      // full-reload — the scheduler reloads only when a runtime file changed,
      // and swallows/heals codegen errors so a bad mid-edit save can't wedge
      // auto-regeneration for the rest of the session.
      // Returns the scheduler promise so tests (and any awaiting caller) can
      // wait for the run; Vite's watcher ignores the return value.
      const onChange = (file: string): Promise<void> | undefined => {
        if (file.endsWith('.model.ts') || isSchemaFile(file)) {
          return scheduleCodegen(runCodegen)
        } else if (file.endsWith('.ctrl.ts') && options.controllers) {
          return scheduleCodegen(runControllerCodegen)
        }
        return undefined
      }
      server.watcher.on('change', onChange)
      server.watcher.on('add', onChange)
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

// ── File write helpers ────────────────────────────────────────────────────────

function writeIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf8') === content) return false
    } catch { /* fall through */ }
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
  return true
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
