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
  return inferCallableDeps(method, classDecl, {
    name: method.getName(),
    hint: 'Declare @validate({ deps: [...] }) or simplify the body.',
  })
}

/**
 * Dep inference for record-predicates written as arrow/function expressions:
 * `Attr.state` transition guards, and (later) presentIf/requiredIf/lockedIf.
 * The first parameter is the record — its member reads are the deps:
 *
 *   if: (r) => r.amount != null            → deps: ['amount']
 *   if: ({ amount, purpose }) => …          → deps: ['amount', 'purpose']
 *
 * Same fail-closed rules as @validate bodies: computed access, escaping
 * receivers, and unanalyzable constructs refuse rather than guess.
 */
export function inferPredicateDeps(
  fn: Node,
  classDecl: ClassDeclaration,
  label = 'predicate',
): DepsInference {
  return inferCallableDeps(fn, classDecl, {
    name: label,
    hint: 'Declare explicit deps or simplify the predicate.',
  })
}

function inferCallableDeps(
  root: Node,
  classDecl: ClassDeclaration,
  opts: { name: string; hint: string },
): DepsInference {
  const deps = new Set<string>()
  const visiting = new Set<string>()
  const aliases = new Set<string>() // identifiers that alias `this` (or the predicate's record param)

  const refuse = (reason: string): DepsInference => ({
    ok: false,
    error: `can't infer deps for "${opts.name}": ${reason}. ${opts.hint}`,
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

        if (init && isThisExpression(unwrapExpression(init))) {
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
    const inner = unwrapExpression(expr)
    if (isThisExpression(inner)) return true
    if (Node.isIdentifier(inner) && aliases.has(inner.getText())) return true
    return false
  }

  // ── Entry: method roots recurse via walkMethod; predicate roots register
  // their record param as a `this`-alias, then walk the body (block or bare
  // expression — arrow shorthand bodies are legal).
  if (Node.isMethodDeclaration(root)) {
    const err = walkMethod(root)
    if (err) return refuse(err)
    return { ok: true, deps: [...deps].sort(), source: 'inferred' }
  }

  if (Node.isArrowFunction(root) || Node.isFunctionExpression(root)) {
    const param = root.getParameters()[0]
    if (param) {
      const nameNode = param.getNameNode()
      if (Node.isIdentifier(nameNode)) {
        aliases.add(nameNode.getText())
      } else if (Node.isObjectBindingPattern(nameNode)) {
        // ({ amount, purpose }) => … — the destructured names ARE the deps
        for (const el of nameNode.getElements()) {
          const prop = el.getPropertyNameNode()?.getText() ?? el.getName()
          if (prop && !NON_FIELD_THIS_MEMBERS.has(prop)) deps.add(prop)
        }
      } else {
        return refuse('unsupported parameter pattern')
      }
    }
    const body = root.getBody()
    const err = Node.isBlock(body)
      ? (() => {
          for (const stmt of body.getStatements()) {
            const e = walkStatement(stmt)
            if (e) return e
          }
          return null
        })()
      : walkNodeSubtree(body)
    if (err) return refuse(err)
    return { ok: true, deps: [...deps].sort(), source: 'inferred' }
  }

  return refuse('unsupported callable form')
}

function isThisExpression(node: Node): boolean {
  return node.getKind() === SyntaxKind.ThisKeyword || Node.isThisExpression(node)
}

/**
 * Strips wrappers that don't change what an expression IS:
 * `(this)`, `this as any`, `this!`, `this satisfies X`, `<any>this`.
 * Without this, `(this as any)[key]` would evade the computed-access refusal —
 * a fail-open hole. Casting away the type must never cast away the analysis.
 * (Also used by the extractor to see through `{...} as const`.)
 */
export function unwrapExpression(node: Node): Node {
  let cur = node
  for (;;) {
    if (Node.isParenthesizedExpression(cur) || Node.isAsExpression(cur) || Node.isNonNullExpression(cur)) {
      cur = cur.getExpression()
      continue
    }
    if (Node.isSatisfiesExpression?.(cur)) {
      cur = (cur as any).getExpression()
      continue
    }
    if (cur.getKind() === SyntaxKind.TypeAssertionExpression) {
      cur = (cur as any).getExpression()
      continue
    }
    return cur
  }
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
