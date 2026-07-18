import {
  Node,
  SyntaxKind,
  type MethodDeclaration,
  type ClassDeclaration,
  type Statement,
  type Expression,
} from 'ts-morph'

/**
 * Static dependency inference for `@validate` methods.
 *
 * Infer by default from `this.field` / destructuring / own-method calls.
 * Refuse (error) on anything unprovable — never fail open.
 */

/** ApplicationRecord / framework APIs that are NOT field deps. */
const NON_FIELD_THIS_MEMBERS = new Set([
  'errors',
  'save',
  'validate',
  'isValid',
  'isInvalid',
  'destroy',
  'delete',
  'update',
  'reload',
  'toJSON',
  'inspect',
  'isNewRecord',
  '_attributes',
  '_changes',
  'constructor',
  'tableName',
  'primaryKey',
  'transaction',
  'withLock',
  'attach',
  'detach',
  'replace',
  'reorder',
])

export type DepsInference =
  | { ok: true; deps: string[]; source: 'inferred' | 'declared' }
  | { ok: false; error: string }

/**
 * Infer field deps for a validation method, or return a refusal error.
 * If `declaredDeps` is provided (from `@validate({ deps: [...] })`), that wins
 * after optional cross-check against a successful inference.
 */
export function resolveValidationDeps(
  method: MethodDeclaration,
  classDecl: ClassDeclaration,
  declaredDeps?: string[],
): DepsInference {
  if (declaredDeps !== undefined) {
    if (declaredDeps.length === 0) {
      return {
        ok: false,
        error: `@validate({ deps: [] }) on "${method.getName()}" is empty — declare the fields this validator reads, or omit deps to infer.`,
      }
    }
    // Still try to infer when possible; if inference succeeds, declared must cover it
    const inferred = inferValidationDeps(method, classDecl)
    if (inferred.ok) {
      const missing = inferred.deps.filter(d => !declaredDeps.includes(d))
      if (missing.length > 0) {
        return {
          ok: false,
          error: `@validate({ deps: [...] }) on "${method.getName()}" is missing inferred fields: ${missing.map(m => `"${m}"`).join(', ')}. Declared deps must be a superset of what the body reads.`,
        }
      }
    }
    // Declared escape hatch — even if body is unanalyzable
    return { ok: true, deps: [...new Set(declaredDeps)].sort(), source: 'declared' }
  }

  return inferValidationDeps(method, classDecl)
}

export function inferValidationDeps(
  method: MethodDeclaration,
  classDecl: ClassDeclaration,
): DepsInference {
  const deps = new Set<string>()
  const visiting = new Set<string>()
  const aliases = new Set<string>() // identifiers that alias `this`

  const refuse = (reason: string): DepsInference => ({
    ok: false,
    error: `can't infer deps for "${method.getName()}": ${reason}. Declare @validate({ deps: [...] }) or simplify the body.`,
  })

  const walkMethod = (m: MethodDeclaration): string | null => {
    const name = m.getName()
    if (visiting.has(name)) return null // cycle OK — deps already accumulated
    visiting.add(name)

    const body = m.getBody()
    if (!body || !Node.isBlock(body)) {
      visiting.delete(name)
      return `method has no analyzable body`
    }

    for (const stmt of body.getStatements()) {
      const err = walkStatement(stmt)
      if (err) {
        visiting.delete(name)
        return err
      }
    }
    visiting.delete(name)
    return null
  }

  const walkStatement = (stmt: Statement): string | null => {
    // const { amount, adminCap } = this
    if (Node.isVariableStatement(stmt)) {
      for (const decl of stmt.getDeclarationList().getDeclarations()) {
        const init = decl.getInitializer()
        const nameNode = decl.getNameNode()

        if (init && isThisExpression(init)) {
          if (Node.isObjectBindingPattern(nameNode)) {
            for (const el of nameNode.getElements()) {
              const prop = el.getPropertyNameNode()?.getText() ?? el.getName()
              if (prop && !NON_FIELD_THIS_MEMBERS.has(prop)) deps.add(prop)
            }
            continue
          }
          if (Node.isIdentifier(nameNode)) {
            aliases.add(nameNode.getText())
            continue
          }
          return `unsupported destructuring of \`this\``
        }

        if (init) {
          const err = walkExpression(init)
          if (err) return err
        }
      }
      return null
    }

    // Walk any other statement as an expression tree via descendants
    return walkNodeSubtree(stmt)
  }

  const walkNodeSubtree = (node: Node): string | null => {
    // Handle calls before descending into callee PropertyAccess (so this.helper()
    // doesn't also record "helper" as a field dep).
    if (Node.isCallExpression(node)) {
      return walkCallExpression(node)
    }

    const err = walkExpressionLike(node)
    if (err) return err
    for (const child of node.getChildren()) {
      const childErr = walkNodeSubtree(child)
      if (childErr) return childErr
    }
    return null
  }

  const walkCallExpression = (node: import('ts-morph').CallExpression): string | null => {
    for (const arg of node.getArguments()) {
      if (isThisOrAlias(arg)) {
        return `\`this\` escapes as an argument — cannot prove which fields are read`
      }
      if (Node.isPropertyAccessExpression(arg) && isThisOrAlias(arg.getExpression())) {
        return `passing \`this.${arg.getName()}\` as a value is not analyzable`
      }
      const argErr = walkNodeSubtree(arg)
      if (argErr) return argErr
    }

    const callee = node.getExpression()
    if (Node.isPropertyAccessExpression(callee) && isThisOrAlias(callee.getExpression())) {
      const calleeName = callee.getName()
      if (NON_FIELD_THIS_MEMBERS.has(calleeName)) return null
      const sibling = classDecl.getInstanceMethod(calleeName)
      if (sibling) return walkMethod(sibling)
      if (calleeName.endsWith('Changed') || calleeName.endsWith('Was') || calleeName.endsWith('Change')) {
        const field = calleeName.replace(/Changed$|Was$|Change$/, '')
        if (field) deps.add(field)
        return null
      }
      return null
    }

    // Non-this call — still walk callee expression tree (e.g. foo(this.amount))
    return walkNodeSubtree(callee)
  }

  const walkExpressionLike = (node: Node): string | null => {
    if (Node.isElementAccessExpression(node)) {
      const expr = node.getExpression()
      if (isThisOrAlias(expr)) {
        return `computed \`this[...]\` access is not analyzable`
      }
    }

    if (Node.isPropertyAccessExpression(node)) {
      const expr = node.getExpression()
      if (isThisOrAlias(expr)) {
        const prop = node.getName()
        if (!NON_FIELD_THIS_MEMBERS.has(prop)) deps.add(prop)
        return null
      }
    }

    return null
  }

  const walkExpression = (expr: Expression): string | null => walkNodeSubtree(expr)

  const isThisOrAlias = (expr: Node): boolean => {
    if (isThisExpression(expr)) return true
    if (Node.isIdentifier(expr) && aliases.has(expr.getText())) return true
    return false
  }

  const err = walkMethod(method)
  if (err) return refuse(err)
  return { ok: true, deps: [...deps].sort(), source: 'inferred' }
}

function isThisExpression(node: Node): boolean {
  return node.getKind() === SyntaxKind.ThisKeyword || Node.isThisExpression(node)
}

/** Parse `@validate({ deps: ['a', 'b'] })` decorator args. */
export function parseDeclaredDeps(decoratorArg: Node | undefined): string[] | undefined {
  if (!decoratorArg || !Node.isObjectLiteralExpression(decoratorArg)) return undefined
  const depsProp = decoratorArg.getProperty('deps')
  if (!depsProp || !Node.isPropertyAssignment(depsProp)) return undefined
  const init = depsProp.getInitializer()
  if (!init || !Node.isArrayLiteralExpression(init)) {
    throw new Error(`@validate({ deps }) must be an array of string literals`)
  }
  const deps: string[] = []
  for (const el of init.getElements()) {
    if (!Node.isStringLiteral(el)) {
      throw new Error(`@validate({ deps }) entries must be string literals`)
    }
    deps.push(el.getLiteralText())
  }
  return deps
}

/** True when every dep is in the projection field set. */
export function depsFitProjection(deps: string[], projectionFields: Set<string> | Iterable<string>): boolean {
  const set = projectionFields instanceof Set ? projectionFields : new Set(projectionFields)
  return deps.every(d => set.has(d))
}
