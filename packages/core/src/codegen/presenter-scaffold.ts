/**
 * Presenter-tree slice 1 (DESIGN-presenter-tree.md §2, LAW 1):
 * generate-then-keep kind scaffolds + the coverage report.
 *
 * LAW 1 — every Attr has a presenter, ALWAYS — is enforced BY
 * CONSTRUCTION: every kind any model uses gets a working, ugly,
 * commented bulb folder the moment regen runs; existing files are never
 * touched; deleting a folder whose kind is still in use just gets it
 * back (the report says so, naming the Attrs that need it). The
 * generated registry (slice 2) will import these; until then each
 * scaffold self-registers on import.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectMeta } from './types.js'

/** Kinds that render through the nested/array managers, not bulbs. */
const NON_BULB_KINDS = new Set(['nested', 'nestedOne'])

export interface KindUsage {
  kind: string
  /** Every Attr using it — the report and LAW 1 errors name these. */
  usedBy: Array<{ model: string; field: string }>
}

/** Every presenter-rendered kind in the project, with its users. */
export function collectKindsInUse(project: ProjectMeta): KindUsage[] {
  const byKind = new Map<string, KindUsage>()
  for (const model of project.models) {
    for (const [field, meta] of Object.entries(model.fieldMeta ?? {})) {
      const kind = (meta as any).semantic ?? (meta as any).kind
      if (!kind || NON_BULB_KINDS.has(kind)) continue
      let entry = byKind.get(kind)
      if (!entry) { entry = { kind, usedBy: [] }; byKind.set(kind, entry) }
      entry.usedBy.push({ model: model.className, field })
    }
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

/** Kind-aware CONTROL bodies — the generated bulb is a real, working
 *  presenter for its kind (Daniel: "codegenned — or absolute sorcery"),
 *  not a stringly placeholder. Unknown/custom kinds get the generic
 *  text control until defineAttrKind supplies their own template. */
function controlFor(kind: string): { edit: string; view: string } {
  switch (kind) {
    case 'boolean':
      return {
        edit: `<input type="checkbox" aria-label={bind.name} checked={Boolean(value)} disabled={bind.disabled}
      onChange={(e) => { bind.onChange(e.target.checked); bind.onCommit() }} />`,
        view: `<span data-kind="boolean">{value ? '✓' : '—'}</span>`,
      }
    case 'enum':
    case 'state':
      return {
        edit: `<select aria-label={bind.name} value={value == null ? '' : String(value)} disabled={bind.disabled}
      onChange={(e) => { bind.onChange(e.target.value); bind.onCommit() }}>
      <option value="" disabled>…</option>
      {((meta.options as string[]) ?? []).map(o => <option key={o} value={o}>{o}</option>)}
    </select>`,
        view: `<span data-kind="${kind}">{value == null ? '—' : String(value)}</span>`,
      }
    case 'date':
      return {
        edit: `<input type="date" aria-label={bind.name} value={value == null ? '' : String(value).slice(0, 10)}
      disabled={bind.disabled} onChange={(e) => bind.onChange(e.target.value)} onBlur={bind.onBlur} />`,
        view: `<span data-kind="date">{value == null ? '—' : String(value).slice(0, 10)}</span>`,
      }
    case 'money':
    case 'percent':
    case 'decimal':
    case 'multiple':
      return {
        edit: `<input inputMode="decimal" aria-label={bind.name} value={value == null ? '' : String(value)}
      disabled={bind.disabled} onChange={(e) => bind.onChange(e.target.value)} onBlur={bind.onBlur}
      onCompositionStart={bind.onCompositionStart} onCompositionEnd={bind.onCompositionEnd} />`,
        view: `<span data-kind="${kind}">{value == null ? '—' : String(value)}</span>`,
      }
    case 'integer':
    case 'int':
    case 'bps':
      return {
        edit: `<input inputMode="numeric" aria-label={bind.name} value={value == null ? '' : String(value)}
      disabled={bind.disabled} onChange={(e) => bind.onChange(e.target.value === '' ? null : Number(e.target.value))}
      onBlur={bind.onBlur} />`,
        view: `<span data-kind="${kind}">{value == null ? '—' : String(value)}</span>`,
      }
    case 'json':
      return {
        edit: `<textarea aria-label={bind.name} rows={4} disabled={bind.disabled}
      value={value == null ? '' : JSON.stringify(value, null, 2)}
      onChange={(e) => { try { bind.onChange(JSON.parse(e.target.value)) } catch { /* keep typing */ } }}
      onBlur={bind.onBlur} />`,
        view: `<pre data-kind="json">{value == null ? '—' : JSON.stringify(value, null, 2)}</pre>`,
      }
    default:
      return {
        edit: `<input aria-label={bind.name} value={value == null ? '' : String(value)} disabled={bind.disabled}
      onChange={(e) => bind.onChange(e.target.value)} onBlur={bind.onBlur}
      onCompositionStart={bind.onCompositionStart} onCompositionEnd={bind.onCompositionEnd} />`,
        view: `<span data-kind="${kind}">{value == null ? '—' : String(value)}</span>`,
      }
  }
}

function bulbScaffold(kind: string): string {
  const cap = kind[0]!.toUpperCase() + kind.slice(1)
  const control = controlFor(kind)
  return `/**
 * SCAFFOLD — yours now, style it. Generated because a model uses kind
 * '${kind}' and LAW 1 says every Attr has a presenter, ALWAYS
 * (DESIGN-presenter-tree.md). Never overwritten; delete it while the
 * kind is in use and the next regen brings it back.
 *
 * value is TYPED by the kind (PresenterPropsFor<'${kind}'>). Chrome
 * (label/errors/dirty) belongs to your LAYOUT — bulbs are value + bind.
 * Export as many named variants as you like; the registry (and
 * AdPresenterKinds typing) picks up every export.
 */
import React from 'react'
import { registerPresenter, setDefaultPresenters, type PresenterPropsFor } from '@active-drizzle/react'

export function ${cap}Input({ value, bind, meta }: PresenterPropsFor<'${kind}'>) {
  void meta
  return (
    ${control.edit}
  )
}

export function ${cap}View({ value }: PresenterPropsFor<'${kind}'>) {
  return ${control.view}
}

// TEMPORARY self-registration — the generated registry (_registry.gen)
// takes this over; leaving it in place is harmless (idempotent).
registerPresenter('${kind}Input', { kind: '${kind}'${['boolean','enum','state'].includes(kind) ? ", commit: 'change'" : ''}, component: ${cap}Input as any })
registerPresenter('${kind}View', { kind: '${kind}', component: ${cap}View as any })
setDefaultPresenters({ ${JSON.stringify(kind)}: { edit: '${kind}Input', view: '${kind}View' } })
`
}

const ROOT_CONTEXT_SCAFFOLD = `/**
 * APP-WIDE presenter context — the client lane of props.ctx, plus (soon)
 * the app layout declaration. Every folder below may hold its own
 * context.ts; the NO-SHADOW LAW applies: no nested folder may redeclare
 * a key from an ancestor, and no client key may collide with a server
 * @frontendContext key. Within THIS file, keys establish before the
 * layout — a layout may read its own folder's ctx.
 */
import { definePresenterContext } from '@active-drizzle/react'

export default definePresenterContext({
  // density: () => useUiStore(s => s.density),   // hooks are legal here
})
`

export interface ScaffoldResult {
  created: string[]
  kept: string[]
  report: string
}

/**
 * The command core: ensure every kind in use has its folder; never touch
 * an existing file; return the report `trails presenters` prints.
 */
export function scaffoldPresenterTree(
  project: ProjectMeta,
  presentersDir: string,
): ScaffoldResult {
  const kinds = collectKindsInUse(project)
  const created: string[] = []
  const kept: string[] = []

  mkdirSync(join(presentersDir, 'attr'), { recursive: true })

  const rootCtx = join(presentersDir, 'context.ts')
  if (!existsSync(rootCtx)) {
    writeFileSync(rootCtx, ROOT_CONTEXT_SCAFFOLD)
    created.push('context.ts')
  }

  for (const { kind, usedBy } of kinds) {
    const dir = join(presentersDir, 'attr', kind)
    const index = join(dir, 'index.tsx')
    if (existsSync(index)) {
      kept.push(kind)
      continue
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(index, bulbScaffold(kind))
    created.push(`attr/${kind}/index.tsx (used by ${usedBy.slice(0, 3).map(u => `${u.model}.${u.field}`).join(', ')}${usedBy.length > 3 ? ', …' : ''})`)
  }

  const report = [
    `presenters ✓ ${kinds.length} kind${kinds.length === 1 ? '' : 's'} covered` +
      (created.filter(c => c.startsWith('attr/')).length
        ? ` (${created.filter(c => c.startsWith('attr/')).length} generated this run)`
        : ''),
    ...created.map(c => `  + ${c}`),
  ].join('\n')

  return { created, kept, report }
}
