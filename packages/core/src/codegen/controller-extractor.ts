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
import { Node, SyntaxKind } from 'ts-morph'
import type { Project, ClassDeclaration, Decorator } from 'ts-morph'
import pluralize from 'pluralize'
import type {
  CtrlMeta, CtrlProjectMeta, CtrlScopeMeta,
  CtrlCrudConfig, CtrlMutationMeta, CtrlActionMeta,
  CtrlAttachmentMeta,
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
    // Third arg is ActionConfig — extract { load: true }
    let load = false
    if (args.length > 2) {
      const configObj = parseObjectLiteral(args[2]!)
      load = configObj?.load === true || configObj?.load === 'true'
    }

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
      load,
      ...(path !== undefined ? { path } : {}),
      inputType,
      outputType,
    })
  }

  // @attachable
  const attachableDec = decorators.find(d => d.getName() === 'attachable')
  const attachable = !!attachableDec

  // Extract attachment declarations from the model class (if available via @crud)
  let attachments: CtrlAttachmentMeta[] | undefined
  if (attachable && modelClass) {
    attachments = extractAttachmentsFromModel(cls, modelClass)
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
    ...(attachable ? { attachable } : {}),
    ...(attachments?.length ? { attachments } : {}),
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
 * Extracts hasOneAttachment / hasManyAttachments declarations from the model class
 * referenced by the controller's @crud decorator.
 *
 * Looks for static properties whose initializer calls hasOneAttachment() or hasManyAttachments().
 */
function extractAttachmentsFromModel(
  controllerCls: ClassDeclaration,
  modelClassName: string,
): CtrlAttachmentMeta[] {
  const file = controllerCls.getSourceFile()
  const project = file.getProject()
  const attachments: CtrlAttachmentMeta[] = []

  // Find the model class across the project
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      if (cls.getName() !== modelClassName) continue

      for (const prop of cls.getStaticProperties()) {
        const init = prop.getInitializer()
        if (!init || !Node.isCallExpression(init)) continue
        const callee = init.getExpression().getText()

        let kind: 'one' | 'many' | null = null
        if (/(^|\.)(hasOneAttachment)$/.test(callee)) kind = 'one'
        else if (/(^|\.)(hasManyAttachments)$/.test(callee)) kind = 'many'
        if (!kind) continue

        const args = init.getArguments()
        const nameArg = args[0]
        const name =
          nameArg && Node.isStringLiteral(nameArg)
            ? nameArg.getLiteralText()
            : prop.getName()
        const opts = parseAttachmentOptionsNode(args[1])

        attachments.push({
          name,
          kind,
          ...(opts.accepts ? { accepts: opts.accepts } : {}),
          ...(opts.maxSize ? { maxSize: opts.maxSize } : {}),
          ...(kind === 'many' && opts.max ? { max: opts.max } : {}),
          access: (opts.access as 'public' | 'private') ?? 'private',
        })
      }
      return attachments
    }
  }
  return attachments
}

/** Extracts options from hasOneAttachment('name', { accepts: '...', ... }) call args. */
function parseAttachmentOptionsNode(optionsNode: Node | undefined): Record<string, any> {
  const result: Record<string, any> = {}
  if (!optionsNode || !Node.isObjectLiteralExpression(optionsNode)) return result

  for (const prop of optionsNode.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue
    const key = prop.getName()
    const init = prop.getInitializer()
    if (!init) continue

    if (key === 'accepts' || key === 'access') {
      if (Node.isStringLiteral(init)) {
        result[key] = init.getLiteralText()
      }
      continue
    }

    if (key === 'max' || key === 'maxSize') {
      const evaluated = evaluateNumericExpression(init)
      if (typeof evaluated === 'number' && Number.isFinite(evaluated)) {
        result[key] = evaluated
      }
    }
  }

  return result
}

function evaluateNumericExpression(node: Node): number | undefined {
  if (Node.isNumericLiteral(node)) {
    return Number(node.getText().replace(/_/g, ''))
  }
  if (Node.isParenthesizedExpression(node)) {
    return evaluateNumericExpression(node.getExpression())
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const val = evaluateNumericExpression(node.getOperand())
    if (val === undefined) return undefined
    const op = node.getOperatorToken()
    if (op === SyntaxKind.PlusToken) return val
    if (op === SyntaxKind.MinusToken) return -val
    return undefined
  }
  if (Node.isBinaryExpression(node)) {
    const left = evaluateNumericExpression(node.getLeft())
    const right = evaluateNumericExpression(node.getRight())
    if (left === undefined || right === undefined) return undefined
    const op = node.getOperatorToken().getText()
    switch (op) {
      case '+': return left + right
      case '-': return left - right
      case '*': return left * right
      case '/': return right === 0 ? undefined : left / right
      default: return undefined
    }
  }
  return undefined
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
