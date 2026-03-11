/**
 * Controller extractor — reads .ctrl.ts files using ts-morph and builds
 * the CtrlProjectMeta IR for the code generator.
 *
 * Uses static analysis only (no eval). Extracts:
 *   - @controller path
 *   - @crud / @singleton model name + config keys
 *   - @scope field names
 *   - @mutation / @action method names + bulk flag
 */
import type { Project, ClassDeclaration, Decorator, Node } from 'ts-morph'
import pluralize from 'pluralize'
import type {
  CtrlMeta, CtrlProjectMeta, CtrlScopeMeta,
  CtrlCrudConfig, CtrlMutationMeta, CtrlActionMeta,
} from './controller-types.js'

export function extractControllers(
  project: Project,
  ctrlFilePaths: string[],
): CtrlProjectMeta {
  const controllers: CtrlMeta[] = []

  for (const filePath of ctrlFilePaths) {
    const file = project.addSourceFileAtPath(filePath)
    const classes = file.getClasses()

    for (const cls of classes) {
      const decoratorNames = cls.getDecorators().map(d => d.getName())
      if (!decoratorNames.includes('controller')) continue

      const meta = extractController(cls, filePath)
      if (meta) controllers.push(meta)
    }
  }

  return { controllers }
}

function extractController(cls: ClassDeclaration, filePath: string): CtrlMeta | null {
  const className = cls.getName() ?? 'UnknownController'
  const parent = cls.getBaseClass()
  const parentClass = parent?.getName()

  const decorators = cls.getDecorators()

  // @controller(path?)
  const controllerDec = decorators.find(d => d.getName() === 'controller')
  let explicitPath: string | undefined
  if (controllerDec) {
    const args = controllerDec.getArguments()
    if (args.length > 0) {
      const arg = args[0]!
      explicitPath = stripQuotes(arg.getText())
    }
  }

  const inferredPath = explicitPath ?? inferPathFromClassName(className)

  // @scope decorators — decorators are applied bottom-up but stored top-down
  // We need to reverse to match runtime behavior (outermost scope first)
  const scopeDecorators = decorators.filter(d => d.getName() === 'scope').reverse()
  const scopes: CtrlScopeMeta[] = scopeDecorators.map(d => {
    const args = d.getArguments()
    const field = args.length > 0 ? stripQuotes(args[0]!.getText()) : ''
    return {
      field,
      resource: pluralize(field.replace(/Id$/, '')),
      paramName: field,
    }
  })

  // Build basePath with scopes
  const scopePrefix = scopes.map(s => `/${s.resource}/:${s.paramName}`).join('')
  const basePath = scopePrefix + inferredPath

  // @crud
  const crudDec = decorators.find(d => d.getName() === 'crud')
  // @singleton
  const singletonDec = decorators.find(d => d.getName() === 'singleton')

  let kind: CtrlMeta['kind'] = 'plain'
  let modelClass: string | undefined
  let crudConfig: CtrlCrudConfig | undefined

  if (crudDec) {
    kind = 'crud'
    const args = crudDec.getArguments()
    if (args.length > 0) {
      modelClass = args[0]!.getText().trim()
    }
    if (args.length > 1) {
      crudConfig = parseObjectLiteral(args[1]!) as CtrlCrudConfig
    }
  } else if (singletonDec) {
    kind = 'singleton'
    const args = singletonDec.getArguments()
    if (args.length > 0) {
      modelClass = args[0]!.getText().trim()
    }
  }

  // @mutation methods
  const mutations: CtrlMutationMeta[] = []
  for (const method of cls.getMethods()) {
    const mutDec = method.getDecorator('mutation')
    if (!mutDec) continue
    const methodName = method.getName()
    const args = mutDec.getArguments()
    let bulk = false
    if (args.length > 0) {
      const obj = parseObjectLiteral(args[0]!)
      bulk = obj?.bulk === true || obj?.bulk === 'true'
    }
    mutations.push({
      method: methodName,
      bulk,
      kebabPath: toKebab(methodName),
    })
  }

  // @action methods
  const actions: CtrlActionMeta[] = []
  for (const method of cls.getMethods()) {
    const actDec = method.getDecorator('action')
    if (!actDec) continue
    const methodName = method.getName()
    const args = actDec.getArguments()
    const httpMethod = args.length > 0 ? stripQuotes(args[0]!.getText()) : 'POST'
    const path = args.length > 1 ? stripQuotes(args[1]!.getText()) : undefined

    // Extract input type from first parameter type annotation
    const params = method.getParameters()
    let inputType: string | null = null
    if (params.length > 0) {
      const typeNode = params[0]!.getTypeNode()
      inputType = typeNode ? typeNode.getText() : null
    }

    // Extract output type — unwrap Promise<T> → T
    let outputType: string | null = null
    const retTypeNode = method.getReturnTypeNode()
    if (retTypeNode) {
      const retText = retTypeNode.getText()
      const promiseMatch = retText.match(/^Promise<(.+)>$/s)
      outputType = promiseMatch ? promiseMatch[1]!.trim() : retText
    }

    actions.push({
      method: methodName,
      httpMethod,
      ...(path !== undefined ? { path } : {}),
      inputType,
      outputType,
    })
  }

  return {
    filePath,
    className,
    basePath,
    ...(parentClass !== undefined ? { parentClass } : {}),
    scopes,
    kind,
    ...(modelClass !== undefined ? { modelClass } : {}),
    ...(crudConfig !== undefined ? { crudConfig } : {}),
    mutations,
    actions,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferPathFromClassName(name: string): string {
  const base = name.replace(/Controller$/, '')
  const kebab = base.replace(/([A-Z])/g, (_, c, i) => (i > 0 ? '-' : '') + c.toLowerCase())
  return '/' + pluralize(kebab)
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '')
}

function toKebab(name: string): string {
  return name.replace(/([A-Z])/g, (_, c) => '-' + c.toLowerCase()).replace(/^-/, '')
}

/**
 * Very lightweight object literal parser — extracts top-level string/number/boolean
 * and array-of-string values from a ts-morph Node.
 * Does NOT handle nested objects (just returns the raw text for those).
 */
function parseObjectLiteral(node: Node): Record<string, any> {
  const result: Record<string, any> = {}
  const text = node.getText()

  // For nested objects, do a best-effort regex parse of top-level keys
  // This is intentionally conservative — we only need a subset for IR
  const arrayMatch = text.matchAll(/(\w+)\s*:\s*\[([^\]]*)\]/g)
  for (const m of arrayMatch) {
    const key = m[1]!
    const items = m[2]!.split(',').map(s => stripQuotes(s.trim())).filter(Boolean)
    result[key] = items
  }

  const boolMatch = text.matchAll(/(\w+)\s*:\s*(true|false)/g)
  for (const m of boolMatch) {
    result[m[1]!] = m[2] === 'true'
  }

  const numMatch = text.matchAll(/(\w+)\s*:\s*(\d+)/g)
  for (const m of numMatch) {
    result[m[1]!] = parseInt(m[2]!, 10)
  }

  return result
}
