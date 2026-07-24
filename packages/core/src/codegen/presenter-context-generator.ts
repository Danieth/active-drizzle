/**
 * Folder-scoped presenter context (context.ts at any depth of the
 * presenters tree) — discovery, the NO-SHADOW law, and the generated
 * injection file.
 *
 * Every folder in the presenter tree may declare context; a key means ONE
 * thing everywhere, so:
 *   - a nested folder redeclaring an ANCESTOR's key  → regen teaching error
 *   - a client key colliding with a server @frontendContext key → same
 * Sibling folders may reuse a key (their presenters never co-mount under
 * one meaning) — only the ancestor chain is law.
 *
 * Emits `_pctx.gen.tsx`:
 *   - <AppPresenterContext> — mounts the ROOT context.ts app-wide
 *   - presenterContextAreas — folder → map, for the presenter registry to
 *     wrap each area's presenters (the registry phase consumes this)
 *   - AdFrontendCtx augmentation — ROOT keys typed REQUIRED (the provider
 *     is app-mounted, so they are always present), via ReturnType over the
 *     imported module: EXACT types, zero sanitization, no wire constraint
 *     (client values never ride the wire — components/functions are fine).
 */
import { join, relative, dirname } from 'path'
import { Node, type Project } from 'ts-morph'

export interface PresenterContextFile {
  /** Absolute path of the context.ts file. */
  filePath: string
  /** Area = folder path relative to the presenters root ('' = root). */
  area: string
  keys: string[]
}

export function scanPresenterContexts(
  project: Project,
  presentersDir: string,
  contextPaths: string[],
): PresenterContextFile[] {
  const out: PresenterContextFile[] = []
  for (const filePath of contextPaths) {
    const sf = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath)
    const def = sf.getDefaultExportSymbol()
    if (!def) {
      throw new Error(
        `${filePath}: a presenter context.ts must \`export default definePresenterContext({ … })\` — ` +
        `no default export found. (An empty file is fine to delete.)`,
      )
    }
    // Find the object literal inside `export default definePresenterContext({...})`
    const assignment = sf.getExportAssignment(() => true)
    const expr = assignment?.getExpression()
    let obj: Node | undefined
    if (expr && Node.isCallExpression(expr)) obj = expr.getArguments()[0]
    else obj = expr
    if (!obj || !Node.isObjectLiteralExpression(obj)) {
      throw new Error(
        `${filePath}: export default must be \`definePresenterContext({ key: () => value, … })\` — ` +
        `an inline object literal, so keys and types are readable at regen.`,
      )
    }
    const keys: string[] = []
    for (const prop of obj.getProperties()) {
      if (Node.isPropertyAssignment(prop) || Node.isMethodDeclaration(prop) || Node.isShorthandPropertyAssignment(prop)) {
        keys.push(prop.getName())
      }
    }
    const area = relative(presentersDir, dirname(filePath)).replace(/\\/g, '/')
    out.push({ filePath, area: area === '.' ? '' : area, keys })
  }
  return out
}

/** The no-shadow law, enforced across the tree AND against the server lane. */
export function validatePresenterContexts(
  files: PresenterContextFile[],
  serverKeys: Map<string, string>,   // key → owning controller/concern
): void {
  const sorted = [...files].sort((a, b) => a.area.length - b.area.length)
  for (const file of sorted) {
    for (const key of file.keys) {
      const server = serverKeys.get(key)
      if (server) {
        throw new Error(
          `presenter context key '${key}' (${file.filePath}) is ALREADY server context — ` +
          `@frontendContext on ${server} declares it. One fact, one lane: delete one of them ` +
          `(server wins when the value needs ctrl.state; client wins when it doesn't).`,
        )
      }
      for (const ancestor of sorted) {
        if (ancestor === file) continue
        const isAncestor = ancestor.area === '' || file.area === ancestor.area || file.area.startsWith(ancestor.area + '/')
        if (isAncestor && ancestor.area.length < file.area.length && ancestor.keys.includes(key)) {
          throw new Error(
            `presenter context key '${key}' in ${file.filePath} SHADOWS the same key from ` +
            `${ancestor.filePath}. Context keys never shadow — ctx.${key} means ONE thing ` +
            `everywhere below that folder. Rename one, or delete the duplicate.`,
          )
        }
      }
    }
  }
}

export function generatePresenterContextFile(
  files: PresenterContextFile[],
  outFilePath: string,
): string {
  const L: string[] = [
    `/**`,
    ` * GENERATED — do not edit. Folder context (presenters, any depth),`,
    ` * discovered and injected automatically. Mount <AppPresenterContext>`,
    ` * once at the app root; every presenter then reads props.ctx.* — the`,
    ` * no-shadow law is enforced at regen, so a key means one thing`,
    ` * everywhere.`,
    ` */`,
    `import React, { type ReactNode } from 'react'`,
    `import { PresenterContextProvider } from '@active-drizzle/react'`,
  ]
  const importName = (i: number) => `_ctx${i}`
  files.forEach((f, i) => {
    let rel = relative(dirname(outFilePath), f.filePath).replace(/\\/g, '/').replace(/\.tsx?$/, '.js')
    if (!rel.startsWith('.')) rel = './' + rel
    L.push(`import ${importName(i)} from '${rel}'`)
  })
  L.push(``)
  const rootIdx = files.findIndex(f => f.area === '')
  L.push(`/** Mount ONCE at the app root — the app-wide context.ts, live for every presenter. */`)
  if (rootIdx >= 0) {
    L.push(`export function AppPresenterContext({ children }: { children?: ReactNode }): React.JSX.Element {`)
    L.push(`  return <PresenterContextProvider map={${importName(rootIdx)}}>{children}</PresenterContextProvider>`)
    L.push(`}`)
  } else {
    L.push(`export function AppPresenterContext({ children }: { children?: ReactNode }): React.JSX.Element {`)
    L.push(`  return <>{children}</>`)
    L.push(`}`)
  }
  L.push(``)
  L.push(`/** Folder areas — the presenter registry wraps each area's presenters with its map. */`)
  L.push(`export const presenterContextAreas = {`)
  files.forEach((f, i) => {
    if (f.area !== '') L.push(`  '${f.area}': ${importName(i)},`)
  })
  L.push(`} as const`)
  L.push(``)
  if (rootIdx >= 0 && files[rootIdx]!.keys.length > 0) {
    L.push(`// ROOT keys are REQUIRED — <AppPresenterContext> is app-mounted, so they`)
    L.push(`// are always present; types come straight from your functions (ReturnType).`)
    L.push(`declare module '@active-drizzle/react' {`)
    L.push(`  interface AdFrontendCtx {`)
    for (const key of files[rootIdx]!.keys) {
      L.push(`    ${key}: ReturnType<(typeof ${importName(rootIdx)})['${key}']>`)
    }
    L.push(`  }`)
    L.push(`}`)
    L.push(``)
  }
  return L.join('\n')
}

/** One-call orchestration for the vite plugin / regen script. */
export function generatePresenterContext(
  project: Project,
  presentersDir: string,
  contextPaths: string[],
  serverKeys: Map<string, string>,
  outFilePath: string,
): string | null {
  if (contextPaths.length === 0) return null
  const files = scanPresenterContexts(project, presentersDir, contextPaths)
  validatePresenterContexts(files, serverKeys)
  return generatePresenterContextFile(files, outFilePath)
}
