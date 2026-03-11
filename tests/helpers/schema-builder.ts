/**
 * Fluent builder for creating Drizzle schema source strings in tests.
 * Keeps test fixtures readable and avoids duplicating boilerplate.
 *
 * Usage:
 *   const schema = schemaBuilder()
 *     .table('assets', t => t
 *       .integer('id').primaryKey()
 *       .integer('business_id')
 *       .smallint('asset_type')
 *       .text('title').nullable()
 *       .timestamp('created_at')
 *     )
 *     .table('businesses', t => t
 *       .integer('id').primaryKey()
 *       .text('name')
 *     )
 *     .build()
 */

type ColumnDef = {
  name: string
  type: string
  modifiers: string[]
}

class TableBuilder {
  private columns: ColumnDef[] = []
  private readonly tableName: string

  constructor(tableName: string) {
    this.tableName = tableName
  }

  private col(name: string, type: string): this {
    this.columns.push({ name, type, modifiers: [] })
    return this
  }

  integer(name: string): this { return this.col(name, 'integer') }
  smallint(name: string): this { return this.col(name, 'smallint') }
  bigint(name: string): this { return this.col(name, 'bigint') }
  serial(name: string): this { return this.col(name, 'serial') }
  text(name: string): this { return this.col(name, 'text') }
  varchar(name: string, length?: number): this { return this.col(name, length ? `varchar(${length})` : 'varchar') }
  boolean(name: string): this { return this.col(name, 'boolean') }
  timestamp(name: string): this { return this.col(name, 'timestamp') }
  jsonb(name: string): this { return this.col(name, 'jsonb') }
  bytea(name: string): this { return this.col(name, 'bytea') }
  uuid(name: string): this { return this.col(name, 'uuid') }
  decimal(name: string): this { return this.col(name, 'decimal') }
  real(name: string): this { return this.col(name, 'real') }

  nullable(): this {
    const last = this.columns[this.columns.length - 1]
    if (last) last.modifiers.push('.notNull()')  // actually we remove this
    // by default columns are nullable in Drizzle; we track this differently
    return this
  }

  primaryKey(): this {
    const last = this.columns[this.columns.length - 1]
    if (last) last.modifiers.push('.primaryKey()')
    return this
  }

  notNull(): this {
    const last = this.columns[this.columns.length - 1]
    if (last) last.modifiers.push('.notNull()')
    return this
  }

  defaultVal(val: string): this {
    const last = this.columns[this.columns.length - 1]
    if (last) last.modifiers.push(`.default(${val})`)
    return this
  }

  build(): string {
    const drizzleType = (col: ColumnDef): string => {
      const t = col.type.replace(/\(\d+\)/, '')
      const map: Record<string, string> = {
        integer: 'integer',
        smallint: 'smallint',
        bigint: 'bigint',
        serial: 'serial',
        text: 'text',
        varchar: 'varchar',
        boolean: 'boolean',
        timestamp: 'timestamp',
        jsonb: 'jsonb',
        bytea: 'customType',
        uuid: 'uuid',
        decimal: 'decimal',
        real: 'real',
      }
      return map[t] ?? 'text'
    }

    const cols = this.columns
      .map(col => `    ${col.name}: ${drizzleType(col)}('${col.name}')${col.modifiers.join('')},`)
      .join('\n')

    return `export const ${camelize(this.tableName)} = pgTable('${this.tableName}', {\n${cols}\n})`
  }
}

function camelize(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

class SchemaBuilder {
  private tables: TableBuilder[] = []

  table(name: string, fn: (t: TableBuilder) => TableBuilder | void): this {
    const builder = new TableBuilder(name)
    fn(builder)
    this.tables.push(builder)
    return this
  }

  build(): string {
    const tableCode = this.tables.map(t => t.build()).join('\n\n')
    return `import { pgTable, integer, smallint, bigint, serial, text, varchar, boolean, timestamp, jsonb, uuid, decimal, real } from 'drizzle-orm/pg-core'\n\n${tableCode}\n`
  }
}

export function schemaBuilder(): SchemaBuilder {
  return new SchemaBuilder()
}

/** Pre-built schemas for common test scenarios */
export const schemas = {
  /** assets + businesses — minimal association pair */
  assetsAndBusinesses: schemaBuilder()
    .table('assets', t => t.integer('id').primaryKey().notNull().integer('business_id').notNull().smallint('asset_type').text('title').timestamp('created_at').notNull().timestamp('updated_at').notNull())
    .table('businesses', t => t.integer('id').primaryKey().notNull().text('name').notNull())
    .build(),

  /** text_messages + conversations — STI parent + through assoc */
  textMessages: schemaBuilder()
    .table('text_messages', t => t.integer('id').primaryKey().notNull().smallint('type').notNull().text('content').integer('conversation_id').notNull().timestamp('created_at').notNull())
    .table('conversations', t => t.integer('id').primaryKey().notNull().integer('team_id'))
    .table('teams', t => t.integer('id').primaryKey().notNull().text('name').notNull())
    .build(),

  /** campaigns + assets — many-to-many join table */
  campaignsAndAssets: schemaBuilder()
    .table('campaigns', t => t.integer('id').primaryKey().notNull().text('name').notNull().integer('business_id').notNull())
    .table('assets', t => t.integer('id').primaryKey().notNull().integer('business_id').notNull().smallint('asset_type'))
    .table('assets_campaigns', t => t.integer('campaign_id').notNull().integer('asset_id').notNull())
    .build(),
} as const
