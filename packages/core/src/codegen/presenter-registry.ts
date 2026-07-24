/**
 * Presenter-tree slice 2 (DESIGN-presenter-tree.md §4): _registry.gen.tsx.
 *
 * Scans the presenter tree and EMITS the registration nobody hand-writes:
 * every exported bulb of every attr/<kind>/ folder registered under its
 * folder's kind (the folder IS the kind — placement is the declaration),
 * per-kind edit/view defaults derived by export-name convention, discrete
 * kinds registered commit:'change', the AdPresenterKinds augmentation
 * emitted from the SAME scan (one fact: the folder), and the app-wide
 * context provider re-exported beside it. Acceptance: the demo's
 * hand-written index.ts becomes deletable.
 *
 * Conventions (teaching errors when unmet):
 *   - exports ending Input/Editor/Picker are EDIT candidates; the first
 *     (source order) is the kind's edit default
 *   - exports ending View/Text/Badge/Label are VIEW candidates; first wins
 *   - `export const defaults = { edit: 'MoneyCompact', view: 'MoneyText' }`
 *     overrides the convention by EXPORT NAME
 *   - a kind with no resolvable edit AND view default is a regen teaching
 *     error listing the exports it found
 */
import { relative, join, dirname } from 'path'
import { Node, type Project } from 'ts-morph'

const DISCRETE_KINDS = new Set(['boolean', 'enum', 'state'])
const EDIT_SUFFIX = /(Input|Editor|Picker|Stepper|Switch|Segmented)$/
const VIEW_SUFFIX = /(View|Text|Badge|Label|Bar|Link|Chip)$/

export interface KindModuleScan {
  kind: string
  filePath: string
  /** Exported component names (capitalized function/const exports). */
  components: string[]
  /** Explicit `defaults` export override, when present. */
  defaults?: { edit?: string; view?: string }
}

export function scanKindModules(project: Project, files: Array<{ kind: string; filePath: string }>): KindModuleScan[] {
  const out: KindModuleScan[] = []
  for (const { kind, filePath } of files) {
    const sf = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath)
    const components: string[] = []
    let defaults: { edit?: string; view?: string } | undefined
    for (const [name, decls] of sf.getExportedDeclarations()) {
      if (name === 'default') continue
      if (name === 'defaults') {
        const d = decls[0]
        if (d && Node.isVariableDeclaration(d)) {
          const init = d.getInitializer()
          if (init && Node.isObjectLiteralExpression(init)) {
            defaults = {}
            for (const p of init.getProperties()) {
              if (Node.isPropertyAssignment(p)) {
                const key = p.getName()
                const val = p.getInitializer()?.getText().replace(/['"`]/g, '')
                if ((key === 'edit' || key === 'view') && val) defaults[key] = val
              }
            }
          }
        }
        continue
      }
      if (!/^[A-Z]/.test(name)) continue
      const d = decls[0]
      if (!d) continue
      // functions and const arrow components both qualify
      if (Node.isFunctionDeclaration(d) || Node.isVariableDeclaration(d)) components.push(name)
    }
    out.push({ kind, filePath, components, ...(defaults ? { defaults } : {}) })
  }
  return out
}

const lcFirst = (s: string): string => s[0]!.toLowerCase() + s.slice(1)

/** Resolve a kind's edit/view default export names, or throw teaching. */
function resolveDefaults(scan: KindModuleScan): { edit?: string; view?: string } {
  const edit = scan.defaults?.edit
    ?? scan.components.find(c => EDIT_SUFFIX.test(c))
  const view = scan.defaults?.view
    ?? scan.components.find(c => VIEW_SUFFIX.test(c))
  if (!edit && !view) {
    throw new Error(
      `presenters/attr/${scan.kind}/: no edit or view default resolvable. Exports found: ` +
      `${scan.components.join(', ') || '(none)'}. Name one *Input/*Editor (edit) or ` +
      `*View/*Text (view), or export \`defaults = { edit: 'Name', view: 'Name' }\`.`,
    )
  }
  return { ...(edit ? { edit } : {}), ...(view ? { view } : {}) }
}

/**
 * Emit _registry.gen.tsx. `pctxImport` re-exports the context provider
 * beside registration so the app's ONE import wires everything.
 */
export function generatePresenterRegistry(
  scans: KindModuleScan[],
  outFilePath: string,
  opts: { pctxImport?: string } = {},
): string {
  const L: string[] = [
    `/**`,
    ` * GENERATED — do not edit. The presenter registry: every bulb of every`,
    ` * attr/<kind>/ folder, registered from FOLDER PLACEMENT (the folder is`,
    ` * the kind), defaults by export-name convention, types beside runtime`,
    ` * from one scan. Import '@gen/presenters' ONCE at the app entry.`,
    ` */`,
    `import { registerPresenter, setDefaultPresenters } from '@active-drizzle/react'`,
  ]
  scans.forEach((s, i) => {
    let rel = relative(dirname(outFilePath), s.filePath).replace(/\\/g, '/').replace(/\.tsx?$/, '.js')
    if (!rel.startsWith('.')) rel = './' + rel
    L.push(`import { ${s.components.join(', ')} } from '${rel}'`)
    void i
  })
  if (opts.pctxImport) {
    L.push(`export { AppPresenterContext } from '${opts.pctxImport}'`)
  }
  L.push('')
  const kindDefaultEntries: string[] = []
  const augmentations: string[] = []
  for (const s of scans) {
    const commit = DISCRETE_KINDS.has(s.kind) ? `, commit: 'change'` : ''
    for (const c of s.components) {
      L.push(`registerPresenter('${lcFirst(c)}', { kind: '${s.kind}'${commit}, component: ${c} as any })`)
      augmentations.push(`    ${lcFirst(c)}: '${s.kind}'`)
    }
    const d = resolveDefaults(s)
    const parts: string[] = []
    if (d.edit) parts.push(`edit: '${lcFirst(d.edit)}'`)
    if (d.view) parts.push(`view: '${lcFirst(d.view)}'`)
    kindDefaultEntries.push(`  '${s.kind}': { ${parts.join(', ')} },`)
  }
  L.push('')
  L.push(`setDefaultPresenters({`)
  L.push(...kindDefaultEntries)
  L.push(`})`)
  L.push('')
  L.push(`// The presenter↔kind COMPILE gate, emitted from the same scan that`)
  L.push(`// registered the runtime — the two can never drift (one fact: the folder).`)
  L.push(`declare module '@active-drizzle/react' {`)
  L.push(`  interface AdPresenterKinds {`)
  L.push(...augmentations)
  L.push(`  }`)
  L.push(`}`)
  L.push('')
  return L.join('\n')
}

/** One-call orchestration: scan attr/<kind> folders on disk → registry. */
export function generatePresenterRegistryFromDir(
  project: Project,
  presentersDir: string,
  kindFiles: Array<{ kind: string; filePath: string }>,
  opts: { pctxImport?: string } = {},
): { content: string; outFilePath: string; report: string } {
  const outFilePath = join(presentersDir, '.gen', '_registry.gen.tsx')
  const scans = scanKindModules(project, kindFiles)
  const content = generatePresenterRegistry(scans, outFilePath, opts)
  const total = scans.reduce((n, s) => n + s.components.length, 0)
  const report = `registry   ✓ ${total} presenter${total === 1 ? '' : 's'} across ${scans.length} kind${scans.length === 1 ? '' : 's'} — zero hand-registration`
  return { content, outFilePath, report }
}
