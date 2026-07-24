/**
 * USING.gen.md — the per-app usage guide, generated beside the code so it
 * CANNOT drift (the same one-source-projected law as _routes.gen.md,
 * pointed at prose). Born from a real consumer's field report: the
 * conventions that lived only in the generator's head — the hooks-factory
 * pattern, wire shapes, wire vocabulary — written down, per app, from the
 * SAME metadata that generated the code.
 *
 * The law this file must never break (the lesson of the lying JSDoc):
 * EVERYTHING here is conditional on this app's actual config. A feature
 * this app doesn't have is a sentence this file doesn't contain.
 */
import type { CtrlProjectMeta, CtrlMeta } from './controller-types.js'
import type { ProjectMeta } from './types.js'

const lcFirst = (s: string): string => s[0]!.toLowerCase() + s.slice(1)
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1)

function ctrlSection(ctrl: CtrlMeta, project: ProjectMeta | null): string[] {
  const L: string[] = []
  const model = ctrl.modelClass
  const name = ctrl.className
  const lc = model ? lcFirst(model) : lcFirst(name.replace(/Controller$/, ''))
  L.push(`## ${name} (\`${ctrl.basePath}\`)`)
  L.push('')

  if (ctrl.kind === 'crud' && model) {
    const scopeArgs = ctrl.scopes.length
      ? `{ ${ctrl.scopes.map(s => `${s.paramName}`).join(', ')} }`
      : `{}`
    L.push('```ts')
    L.push(`import { ${name} } from '@gen/controllers'`)
    L.push(`const ctrl = ${name}.use(${scopeArgs})   // THE FACTORY: call once, destructure hooks`)
    L.push(`const list = ctrl.index()                 // → useQuery; list.data is { data, pagination },`)
    L.push(`const rows = list.data?.data ?? []        //   NEVER bare rows`)
    L.push(`const one = ctrl.get(id)                  // → useQuery (null id disables)`)
    L.push('```')
    L.push('')
    L.push(`Every member also exists \`use\`-prefixed (\`ctrl.useIndex\`, \`ctrl.useGet\`) —`)
    L.push(`same functions, lint-friendly names.`)
    L.push('')
    L.push(`### Form`)
    L.push('```tsx')
    L.push(`const { status, form: ${lc} } = use${model}EditForm(id${ctrl.scopes.length ? ', scopes' : ''})`)
    L.push(`<${lc}.Form>`)
    L.push(`  <${lc}.someField edit />        {/* fields are members; edit is NEVER inferred */}`)
    L.push(`  <${lc}.Submit>Save</${lc}.Submit>`)
    L.push(`</${lc}.Form>`)
    L.push('```')
  }

  if (ctrl.mutations.length > 0) {
    L.push('')
    L.push(`### Mutations (handle members are PascalCase: \`<${lc}.${cap(ctrl.mutations[0]!.method)}/>\`)`)
    for (const m of ctrl.mutations) {
      const params = m.params?.length ? ` — params: ${m.params.join(', ')}` : ''
      const bulk = m.bulk ? ' — BULK (`{ ids }`)' : ''
      L.push(`- \`${m.method}\`${params}${bulk}${m.guarded || (m as any).if ? ' — guarded (button greys with the why)' : ''}`)
    }
  }

  const fc = ctrl.frontendContext ?? []
  if (fc.length > 0) {
    L.push('')
    L.push(`### ctx (server-computed, in EVERY presenter as \`props.ctx.*\`)`)
    for (const e of fc) L.push(`- \`ctx.${e.key}\`: \`${e.type}\` (from ${e.owner})`)
  }
  void project
  L.push('')
  return L
}

export function generateUsingDoc(ctrlMeta: CtrlProjectMeta, project: ProjectMeta | null): string {
  const L: string[] = [
    `# USING this app's generated client — GENERATED, cannot drift`,
    ``,
    `> Regenerated with the code from the same metadata. A feature this app`,
    `> doesn't configure is a sentence this file doesn't contain.`,
    ``,
    `## Wire vocabulary (the keys you'd otherwise guess wrong)`,
    ``,
    `- \`_event: 'submit'\` on a PATCH fires a declared state transition in the`,
    `  SAME save (not \`_stateEvent\`). Unknown events are 400s listing legal ones.`,
    `- \`_version\` echoes the envelope's optimistic-lock token; a stale echo`,
    `  → 409 carrying the fresh envelope (reload/overwrite UX is generated).`,
    `- Index responses are \`{ data, pagination, facets?, chart?, metric?, ctx? }\``,
    `  — rows live at \`.data\`, never at the top level.`,
    `- \`seek\` cursors are MODEL-SPACE values (like \`where()\`), not encoded`,
    `  tokens — pass the last row's sort-field value as-is.`,
    `- Filters NEST: \`{ filters: { stage: 'won' } }\` — a top-level filter key`,
    `  is a 400 that says exactly this.`,
    ``,
  ]
  for (const ctrl of ctrlMeta.controllers) {
    L.push(...ctrlSection(ctrl, project))
  }
  return L.join('\n')
}
