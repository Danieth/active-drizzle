/**
 * Controller code generator.
 *
 * Generates:
 *   _routes.gen.ts    — merged oRPC router + RouteRecord[] for all controllers
 *   _routes.gen.md    — LLM-optimized route documentation
 */
import { relative, dirname, basename } from 'path'
import type { CtrlProjectMeta, CtrlMeta } from './controller-types.js'

// ── Route file (wires controllers into a single oRPC router) ─────────────────

export function generateRoutesFile(
  meta: CtrlProjectMeta,
  outputFilePath: string,
): string {
  const lines: string[] = [
    '// AUTO-GENERATED — DO NOT EDIT',
    '// Source: active-drizzle controller codegen',
    '',
    `import { mergeRouters, buildRouter } from '@active-drizzle/controller'`,
    '',
  ]

  // Import each controller class
  for (const ctrl of meta.controllers) {
    const relPath = resolveImportPath(outputFilePath, ctrl.filePath)
    lines.push(`import { ${ctrl.className} } from '${relPath}'`)
  }

  lines.push('')
  lines.push('export const { router, routes } = mergeRouters(')
  for (const ctrl of meta.controllers) {
    lines.push(`  buildRouter(${ctrl.className}),`)
  }
  lines.push(')')
  lines.push('')
  lines.push('export type AppRouter = typeof router')
  lines.push('')

  return lines.join('\n')
}

// ── Route documentation (markdown, LLM-optimized) ────────────────────────────

export function generateRoutesDoc(meta: CtrlProjectMeta): string {
  const lines: string[] = [
    '# API Routes',
    '',
    'Auto-generated from controller metadata.',
    '',
  ]

  for (const ctrl of meta.controllers) {
    lines.push(`## ${ctrl.className}`)
    if (ctrl.modelClass) lines.push(`**Model**: \`${ctrl.modelClass}\`  `)
    lines.push(`**Base path**: \`${ctrl.basePath}\`  `)
    lines.push(`**Kind**: ${ctrl.kind}`)
    lines.push('')

    if (ctrl.kind === 'crud') {
      lines.push('### CRUD Routes')
      lines.push('')
      lines.push('| Method | Path | Action |')
      lines.push('|--------|------|--------|')
      lines.push(`| GET | \`${ctrl.basePath}\` | index |`)
      lines.push(`| POST | \`${ctrl.basePath}\` | create |`)
      lines.push(`| GET | \`${ctrl.basePath}/:id\` | get |`)
      lines.push(`| PATCH | \`${ctrl.basePath}/:id\` | update |`)
      lines.push(`| DELETE | \`${ctrl.basePath}/:id\` | destroy |`)
    } else if (ctrl.kind === 'singleton') {
      lines.push('### Singleton Routes')
      lines.push('')
      lines.push('| Method | Path | Action |')
      lines.push('|--------|------|--------|')
      lines.push(`| GET | \`${ctrl.basePath}\` | get |`)
      lines.push(`| PATCH | \`${ctrl.basePath}\` | update |`)
    }

    if (ctrl.mutations.length > 0) {
      lines.push('')
      lines.push('### Mutations')
      lines.push('')
      lines.push('| Method | Path | Action | Bulk? |')
      lines.push('|--------|------|--------|-------|')
      for (const mut of ctrl.mutations) {
        if (mut.bulk) {
          lines.push(`| POST | \`${ctrl.basePath}/${mut.kebabPath}\` | ${mut.method} | ✓ |`)
        } else {
          lines.push(`| POST | \`${ctrl.basePath}/:id/${mut.kebabPath}\` | ${mut.method} | — |`)
        }
      }
    }

    if (ctrl.actions.length > 0) {
      lines.push('')
      lines.push('### Custom Actions')
      lines.push('')
      lines.push('| Method | Path | Action |')
      lines.push('|--------|------|--------|')
      for (const act of ctrl.actions) {
        const path = act.path ?? `${ctrl.basePath}/${toKebab(act.method)}`
        lines.push(`| ${act.httpMethod} | \`${path}\` | ${act.method} |`)
      }
    }

    if (ctrl.crudConfig?.index) {
      const idx = ctrl.crudConfig.index
      lines.push('')
      lines.push('### Index Config')
      if (idx.scopes?.length) lines.push(`- **Named scopes**: ${idx.scopes.map(s => `\`${s}\``).join(', ')}`)
      if (idx.defaultScopes?.length) lines.push(`- **Default scopes**: ${idx.defaultScopes.map(s => `\`${s}\``).join(', ')}`)
      if (idx.paramScopes?.length) lines.push(`- **Param scopes**: ${idx.paramScopes.map(s => `\`${s}\``).join(', ')}`)
      if (idx.sortable?.length) lines.push(`- **Sortable**: ${idx.sortable.map(s => `\`${s}\``).join(', ')}`)
      if (idx.filterable?.length) lines.push(`- **Filterable**: ${idx.filterable.map(s => `\`${s}\``).join(', ')}`)
    }

    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveImportPath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile)
  let rel = relative(fromDir, toFile)
  if (!rel.startsWith('.')) rel = './' + rel
  // Remove .ts extension for import
  return rel.replace(/\.ts$/, '.js')
}

function toKebab(name: string): string {
  return name.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase()).replace(/^-/, '')
}
