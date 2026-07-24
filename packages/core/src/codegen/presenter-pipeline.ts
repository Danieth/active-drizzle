/**
 * THE PRESENTER PIPELINE — one call, the whole phase
 * (DESIGN-presenter-tree.md §0): scaffold what's missing, verify the
 * three laws, emit the registry/context/forms/manifest, return the
 * report. The vite plugin runs this every regen; `trails presenters`
 * runs the same regen. Nothing is registered by hand, ever.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import pluralize from 'pluralize'
import type { Project } from 'ts-morph'
import type { ProjectMeta } from './types.js'
import type { CtrlProjectMeta } from './controller-types.js'
import { scaffoldPresenterTree, collectKindsInUse } from './presenter-scaffold.js'
import { scanPresenterContexts, validatePresenterContexts, validateChromeCoverage, generatePresenterContextFile } from './presenter-context-generator.js'
import { scanKindModules, generatePresenterRegistry, generatePresenterManifest } from './presenter-registry.js'
import { scaffoldModelForms, scanFormManifest, validateFormManifest, bulbFieldsOf, generateFormsIndex } from './presenter-forms.js'

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === '.gen' || name === 'node_modules') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, match, out)
    else if (match(name)) out.push(full)
  }
  return out
}

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1)

export interface PresenterPipelineResult {
  report: string
  written: string[]
}

export function runPresenterPipeline(
  project: Project,
  projectMeta: ProjectMeta,
  ctrlMeta: CtrlProjectMeta | null,
  presentersDir: string,
): PresenterPipelineResult {
  const written: string[] = []
  const lines: string[] = []

  // 1. LAW 1 by construction: kind scaffolds + root context + model forms
  const scaffolds = scaffoldPresenterTree(projectMeta, presentersDir)
  const forms = scaffoldModelForms(projectMeta, presentersDir, projectMeta.models.map(m => m.className))
  lines.push(scaffolds.report)
  if (forms.created.length) lines.push(`forms      + ${forms.created.join(', ')}`)

  // 2. Contexts: scan the whole tree, enforce LAW 2 (no-shadow + server lane)
  const contextPaths = walk(presentersDir, n => n === 'context.ts' || n === 'context.tsx')
  const serverKeys = new Map<string, string>()
  for (const ctrl of ctrlMeta?.controllers ?? []) {
    for (const e of ctrl.frontendContext ?? []) serverKeys.set(e.key, e.owner)
  }
  const contextFiles = scanPresenterContexts(project, presentersDir, contextPaths)
  validatePresenterContexts(contextFiles, serverKeys)

  // 3. Kind modules: scan bulbs, enforce LAW 3 (chrome coverage, no doubles)
  const usages = collectKindsInUse(projectMeta)
  const kindFiles = usages
    .map(u => ({ kind: u.kind, filePath: join(presentersDir, 'attr', u.kind, 'index.tsx') }))
    .filter(f => existsSync(f.filePath))
  const scans = scanKindModules(project, kindFiles)
  validateChromeCoverage(
    contextFiles,
    usages.map(u => {
      const scan = scans.find(s => s.kind === u.kind)
      return { kind: u.kind, ...(scan?.handles ? { handles: scan.handles } : {}) }
    }),
  )
  const rootChrome = contextFiles.find(f => f.area === '')?.consumes ?? []
  lines.push(`layouts    ✓ chrome coverage complete (root consumes: ${rootChrome.join(', ') || '(none — bulbs handle their own)'})`)
  lines.push(`context    ✓ ${contextFiles.length} area${contextFiles.length === 1 ? '' : 's'}, no shadows, no server-lane collisions`)

  // 4. Form manifests: every form covers-or-omits; shows subset
  const formFiles = walk(presentersDir, n => n === 'form.tsx' || n === 'show.tsx')
  for (const filePath of formFiles) {
    const isForm = filePath.endsWith('form.tsx')
    const modelName = /models[\\/]([^\\/]+)[\\/]/.exec(filePath)?.[1]
      ?? ctrlMeta?.controllers.find(c => filePath.includes(join('controllers', ...c.scopes.map(s => cap(s.resource)))))?.modelClass
      ?? projectMeta.models[0]?.className ?? ''
    const fields = bulbFieldsOf(projectMeta, modelName)
    if (fields.length === 0) continue
    validateFormManifest(scanFormManifest(project, filePath), fields, isForm ? 'form' : 'show')
  }
  lines.push(`manifests  ✓ ${formFiles.length} form/show file${formFiles.length === 1 ? '' : 's'} — every field covered or omitted`)

  // 5. Emit the generated four
  const genDir = join(presentersDir, '.gen')
  mkdirSync(genDir, { recursive: true })
  const emit = (name: string, content: string): void => {
    writeFileSync(join(genDir, name), content)
    written.push(name)
  }
  emit('_pctx.gen.tsx', generatePresenterContextFile(contextFiles, join(genDir, '_pctx.gen.tsx')))
  const registry = generatePresenterRegistry(scans, join(genDir, '_registry.gen.tsx'), { pctxImport: './_pctx.gen.js' })
  emit('_registry.gen.tsx', registry)
  const doors = (ctrlMeta?.controllers ?? [])
    .filter(c => c.modelClass)
    .map(c => ({
      controller: c.className,
      segments: [...c.scopes.map(s => cap(s.resource)), cap(pluralize(c.className.replace(/Controller$/, '')))],
      model: c.modelClass!,
    }))
  emit('_forms.gen.tsx', generateFormsIndex(doors, presentersDir))
  emit('_manifest.gen.json', JSON.stringify(generatePresenterManifest(usages, scans, contextFiles), null, 2) + '\n')
  const total = scans.reduce((n, s) => n + s.components.length, 0)
  lines.push(`registry   ✓ ${total} presenters, ${doors.length} door${doors.length === 1 ? '' : 's'} resolved — zero hand-registration`)

  return { report: lines.join('\n'), written }
}
