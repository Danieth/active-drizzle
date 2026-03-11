/**
 * Fluent builder for creating model source strings in tests.
 * Produces valid TypeScript that the extractor/codegen will process.
 *
 * Usage:
 *   const src = modelBuilder('Asset', 'assets')
 *     .belongsTo('business')
 *     .hasMany('campaigns')
 *     .defineEnum('assetType', { jpg: 116, png: 125, gif: 111 })
 *     .enumGroup('images', 'assetType', [100, 199])
 *     .scope('recent', [], `return this.createdAt.gte(sql\`now() - interval '7 days'\`)`)
 *     .instanceMethod('assetFormat', 'string | null', `
 *       if (this.isImages()) return 'image'
 *       return null
 *     `)
 *     .build()
 */

type ScopeParam = { name: string; type: string }

type MethodDef = {
  name: string
  returnType: string
  params: ScopeParam[]
  body: string
  decorator?: string  // e.g. '@validate()' or '@server()'
}

type HookDef = {
  decorator: string
  methodName: string
  condition?: string
  on?: 'create' | 'update'
  body: string
}

class ModelBuilder {
  private readonly className: string
  private readonly tableName: string
  private readonly extendsClass: string
  private statics: string[] = []
  private scopes: string[] = []
  private hooks: HookDef[] = []
  private instanceMethods: MethodDef[] = []

  constructor(className: string, tableName: string, extendsClass = 'ApplicationRecord') {
    this.className = className
    this.tableName = tableName
    this.extendsClass = extendsClass
  }

  belongsTo(property: string, explicitTable?: string, options?: Record<string, unknown>): this {
    const args = [
      explicitTable ? `'${explicitTable}'` : null,
      options ? JSON.stringify(options) : null,
    ].filter(Boolean)
    this.statics.push(`  static ${property} = belongsTo(${args.join(', ')})`)
    return this
  }

  hasMany(property: string, explicitTable?: string, options?: Record<string, unknown>): this {
    const args = [
      explicitTable ? `'${explicitTable}'` : null,
      options ? JSON.stringify(options) : null,
    ].filter(Boolean)
    this.statics.push(`  static ${property} = hasMany(${args.join(', ')})`)
    return this
  }

  hasOne(property: string, explicitTable?: string, options?: Record<string, unknown>): this {
    const args = [
      explicitTable ? `'${explicitTable}'` : null,
      options ? JSON.stringify(options) : null,
    ].filter(Boolean)
    this.statics.push(`  static ${property} = hasOne(${args.join(', ')})`)
    return this
  }

  habtm(property: string, table: string, options?: Record<string, unknown>): this {
    const args = [`'${table}'`, options ? JSON.stringify(options) : null].filter(Boolean)
    this.statics.push(`  static ${property} = habtm(${args.join(', ')})`)
    return this
  }

  defineEnum(property: string, values: Record<string, number>): this {
    this.statics.push(`  static ${property} = defineEnum(${JSON.stringify(values)})`)
    return this
  }

  enumGroup(property: string, enumField: string, range: [number, number]): this {
    this.statics.push(`  static ${property} = enumGroup('${enumField}', [${range[0]}, ${range[1]}])`)
    return this
  }

  scope(name: string, params: ScopeParam[], body: string): this {
    const paramStr = params.map(p => `${p.name}: ${p.type}`).join(', ')
    this.scopes.push(`  @scope\n  static ${name}(${paramStr}) {\n    ${body}\n  }`)
    return this
  }

  computed(name: string, params: ScopeParam[], body: string): this {
    const paramStr = params.map(p => `${p.name}: ${p.type}`).join(', ')
    this.scopes.push(`  @computed\n  static ${name}(${paramStr}) {\n    ${body}\n  }`)
    return this
  }

  /** Raw static property — e.g. Attr.for(), Attr.new() with defaults */
  attr(name: string, expression: string): this {
    this.statics.push(`  static ${name} = ${expression}`)
    return this
  }

  hook(
    decorator: string,
    methodName: string,
    body: string,
    options?: { condition?: string; on?: 'create' | 'update' },
  ): this {
    this.hooks.push({ decorator, methodName, body, ...options })
    return this
  }

  beforeSave(methodName: string, body: string, options?: { condition?: string }): this {
    return this.hook('beforeSave', methodName, body, options)
  }

  afterSave(methodName: string, body: string, options?: { condition?: string }): this {
    return this.hook('afterSave', methodName, body, options)
  }

  afterCommit(methodName: string, body: string, options?: { condition?: string; on?: 'create' | 'update' }): this {
    return this.hook('afterCommit', methodName, body, options)
  }

  instanceMethod(name: string, returnType: string, body: string, params: ScopeParam[] = []): this {
    this.instanceMethods.push({ name, returnType, params, body })
    return this
  }

  /** @validate() decorated instance method */
  validateMethod(name: string, body: string): this {
    this.instanceMethods.push({ name, returnType: 'string | null', params: [], body, decorator: '@validate()' })
    return this
  }

  /** @server() decorated instance method — stripped from client codegen */
  serverMethod(name: string, returnType: string, body: string, params: ScopeParam[] = []): this {
    this.instanceMethods.push({ name, returnType, params, body, decorator: '@server()' })
    return this
  }

  build(): string {
    const imports = [
      "import { ApplicationRecord, model, scope, computed, validate, server, defineEnum, enumGroup, belongsTo, hasMany, hasOne, habtm, Attr, beforeSave, afterSave, afterCommit } from 'active-drizzle'",
    ].join('\n')

    const hookLines = this.hooks.map(h => {
      const opts: string[] = []
      if (h.condition) opts.push(`if: '${h.condition}'`)
      if (h.on) opts.push(`on: '${h.on}'`)
      const decorator = opts.length ? `@${h.decorator}({ ${opts.join(', ')} })` : `@${h.decorator}()`
      return `  ${decorator}\n  ${h.methodName}() {\n    ${h.body}\n  }`
    })

    const instanceMethodLines = this.instanceMethods.map(m => {
      const paramStr = m.params.map(p => `${p.name}: ${p.type}`).join(', ')
      const decoratorLine = m.decorator ? `  ${m.decorator}\n` : ''
      return `${decoratorLine}  ${m.name}(${paramStr}): ${m.returnType} {\n    ${m.body}\n  }`
    })

    const bodyParts = [
      ...this.statics,
      ...this.scopes,
      ...hookLines,
      ...instanceMethodLines,
    ]

    const classBody = bodyParts.length > 0 ? `\n${bodyParts.join('\n\n')}\n` : ''

    return [
      imports,
      '',
      `@model('${this.tableName}')`,
      `export class ${this.className} extends ${this.extendsClass} {${classBody}}`,
    ].join('\n')
  }
}

export function modelBuilder(
  className: string,
  tableName: string,
  extendsClass?: string,
): ModelBuilder {
  return new ModelBuilder(className, tableName, extendsClass)
}
