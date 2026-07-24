/**
 * Presenter-tree slice 5 (DESIGN-presenter-tree.md §1, §9): forms, shows,
 * and the RESOLUTION LADDER.
 *
 * - models/<Model>/form.tsx + show.tsx scaffolds — generate-then-keep,
 *   composed over the typed handle, with the covers/omits manifest
 * - covers/omits validation: every bulb field is COVERED or explicitly
 *   OMITTED (forms); shows may subset but never invent
 * - the ladder: controllers/<Ctrl>/<Nested>/form.tsx → walk OUTWARD →
 *   models/<Model>/form.tsx → nothing (the scaffold IS the fallback,
 *   because generation already guaranteed the model dir). Resolution is
 *   STATIC — codegen resolves files at regen and emits _forms.gen.tsx,
 *   so "which form renders this door" is an import, not a runtime search.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { Node, type Project } from 'ts-morph'
import type { ProjectMeta } from './types.js'

const NON_BULB_KINDS = new Set(['nested', 'nestedOne'])

/** Bulb-rendered fields of one model (the covers/omits universe). */
export function bulbFieldsOf(project: ProjectMeta, modelName: string): string[] {
  const model = project.models.find(m => m.className === modelName)
  if (!model) return []
  return Object.entries(model.fieldMeta ?? {})
    .filter(([, meta]) => {
      const kind = (meta as any).semantic ?? (meta as any).kind
      return kind && !NON_BULB_KINDS.has(kind)
    })
    .map(([field]) => field)
}

function formScaffold(modelName: string, fields: string[]): string {
  const lc = modelName[0]!.toLowerCase() + modelName.slice(1)
  return `/**
 * SCAFFOLD — yours now, compose it. The ${modelName} FORM: the default
 * composition every door falls back to (the ladder:
 * controllers/<Ctrl>/form.tsx overrides this; this overrides nothing —
 * it IS the floor). Regen validates the manifest below: every bulb field
 * of ${modelName} is either COVERED here or explicitly OMITTED — a field
 * you forgot is a teaching error, not a silently missing input.
 */
import React from 'react'

/** Fields this form renders — regen checks covers ∪ omits = every bulb field. */
export const covers = [${fields.map(f => `'${f}'`).join(', ')}] as const
/** Fields deliberately NOT rendered here (still validated as real fields). */
export const omits = [] as const

export default function ${modelName}Form({ ${lc} }: { ${lc}: any }) {
  return (
    <${lc}.Form>
${fields.map(f => `      <${lc}.${f} edit />`).join('\n')}
      <${lc}.Submit>Save</${lc}.Submit>
    </${lc}.Form>
  )
}
`
}

function showScaffold(modelName: string, fields: string[]): string {
  const lc = modelName[0]!.toLowerCase() + modelName.slice(1)
  const shown = fields.slice(0, 4)
  return `/**
 * SCAFFOLD — yours now, style it. The ${modelName} SHOW: how one row of
 * ${modelName} presents in an index/Board/Table. Shows may SUBSET the
 * model (covers ⊆ bulb fields — an index row is supposed to be a
 * subset); naming a field that doesn't exist is still an error.
 */
import React from 'react'

export const covers = [${shown.map(f => `'${f}'`).join(', ')}] as const

export default function ${modelName}Show({ ${lc} }: { ${lc}: any }) {
  return (
    <div data-show="${modelName}">
${shown.map(f => `      <${lc}.${f} />`).join('\n')}
    </div>
  )
}
`
}

export interface FormsScaffoldResult { created: string[]; kept: string[] }

/** Generate-then-keep form.tsx + show.tsx for the given models. */
export function scaffoldModelForms(
  project: ProjectMeta,
  presentersDir: string,
  modelNames: string[],
): FormsScaffoldResult {
  const created: string[] = []
  const kept: string[] = []
  for (const name of modelNames) {
    const fields = bulbFieldsOf(project, name)
    if (fields.length === 0) continue
    const dir = join(presentersDir, 'models', name)
    mkdirSync(dir, { recursive: true })
    for (const [file, content] of [
      ['form.tsx', formScaffold(name, fields)],
      ['show.tsx', showScaffold(name, fields)],
    ] as const) {
      const full = join(dir, file)
      if (existsSync(full)) { kept.push(`models/${name}/${file}`); continue }
      writeFileSync(full, content)
      created.push(`models/${name}/${file}`)
    }
  }
  return { created, kept }
}

// ── covers/omits validation ──────────────────────────────────────────────────

export interface FormManifest { filePath: string; covers: string[]; omits: string[] }

/** Read the exported covers/omits arrays from a form/show file. */
export function scanFormManifest(project: Project, filePath: string): FormManifest {
  const sf = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath)
  const readArray = (name: string): string[] => {
    const decls = sf.getExportedDeclarations().get(name)
    const d = decls?.[0]
    if (!d || !Node.isVariableDeclaration(d)) return []
    let init = d.getInitializer()
    if (init && Node.isAsExpression(init)) init = init.getExpression()
    if (!init || !Node.isArrayLiteralExpression(init)) return []
    return init.getElements().map(e => e.getText().replace(/['"`]/g, ''))
  }
  return { filePath, covers: readArray('covers'), omits: readArray('omits') }
}

/**
 * FORM law: covers ∪ omits = EVERY bulb field (explicitly handled or
 * explicitly omitted — never forgotten). SHOW law: covers ⊆ bulb fields
 * (subsets are the point; inventions are typos). Teaching errors name
 * the field, the file, and both fixes.
 */
export function validateFormManifest(
  manifest: FormManifest,
  bulbFields: string[],
  mode: 'form' | 'show',
): void {
  const known = new Set(bulbFields)
  const dist = (a: string, b: string): number => {
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
  for (const f of [...manifest.covers, ...manifest.omits]) {
    if (!known.has(f)) {
      const near = bulbFields.find(b => dist(b.toLowerCase(), f.toLowerCase()) <= 2)
      throw new Error(
        `${manifest.filePath}: '${f}' is not a field of this model` +
        `${near ? ` — did you mean '${near}'?` : ''} (fields: ${bulbFields.join(', ')}).`,
      )
    }
  }
  if (mode === 'form') {
    const handled = new Set([...manifest.covers, ...manifest.omits])
    const forgotten = bulbFields.filter(f => !handled.has(f))
    if (forgotten.length > 0) {
      throw new Error(
        `${manifest.filePath}: ${forgotten.map(f => `'${f}'`).join(', ')} ` +
        `${forgotten.length > 1 ? 'are' : 'is'} neither covered nor omitted. A form handles ` +
        `EVERY field or says why not — add to \`covers\` (and render it) or to \`omits\` ` +
        `(deliberate, visible, greppable).`,
      )
    }
    const doubled = manifest.covers.filter(f => manifest.omits.includes(f))
    if (doubled.length > 0) {
      throw new Error(
        `${manifest.filePath}: ${doubled.map(f => `'${f}'`).join(', ')} in BOTH covers and omits — pick one.`,
      )
    }
  }
}

// ── the resolution ladder ────────────────────────────────────────────────────

/**
 * Resolve which form/show file serves a door: most-nested controller dir,
 * walking OUTWARD, then the model dir. Nested doors mirror @scope
 * nesting: /teams/:teamId/deals → ['Teams', 'Deals'].
 */
export function resolveLadder(
  presentersDir: string,
  ctrlSegments: string[],
  modelName: string,
  file: 'form.tsx' | 'show.tsx',
): string | null {
  for (let i = ctrlSegments.length; i > 0; i--) {
    const candidate = join(presentersDir, 'controllers', ...ctrlSegments.slice(0, i), file)
    if (existsSync(candidate)) return candidate
  }
  const modelFile = join(presentersDir, 'models', modelName, file)
  return existsSync(modelFile) ? modelFile : null
}

/**
 * Emit _forms.gen.tsx: the STATIC resolution of every door's form/show —
 * "which composition renders this door" becomes an import.
 */
export function generateFormsIndex(
  doors: Array<{ controller: string; segments: string[]; model: string }>,
  presentersDir: string,
): string {
  const outFile = join(presentersDir, '.gen', '_forms.gen.tsx')
  const L: string[] = [
    `/**`,
    ` * GENERATED — do not edit. The resolution ladder, resolved STATICALLY:`,
    ` * controllers/<Ctrl>/<Nested>/ → outward → models/<Model>/. Which`,
    ` * composition renders a door is an import here, never a runtime search.`,
    ` */`,
  ]
  const exports: string[] = []
  const seen = new Map<string, string>()
  for (const door of doors) {
    for (const file of ['form.tsx', 'show.tsx'] as const) {
      const resolved = resolveLadder(presentersDir, door.segments, door.model, file)
      if (!resolved) continue
      const kind = file === 'form.tsx' ? 'Form' : 'Show'
      const exportName = `${door.controller}${kind}`
      let rel = relative(dirname(outFile), resolved).replace(/\\/g, '/').replace(/\.tsx?$/, '.js')
      if (!rel.startsWith('.')) rel = './' + rel
      let importName = seen.get(rel)
      if (!importName) {
        importName = `_c${seen.size}`
        seen.set(rel, importName)
        L.push(`import ${importName} from '${rel}'`)
      }
      exports.push(`export const ${exportName} = ${importName}`)
    }
  }
  L.push('', ...exports, '')
  return L.join('\n')
}
