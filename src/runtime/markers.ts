/**
 * Marker objects: the values you assign to static class properties.
 * They carry declaration intent at class-definition time.
 * The codegen reads them; the runtime boot() resolves them into real queries.
 *
 * belongsTo()   → BelongsToMarker
 * hasMany()     → HasManyMarker
 * hasOne()      → HasOneMarker
 * habtm()       → HabtmMarker
 * defineEnum()  → EnumDefinition
 * enumGroup()   → EnumGroupDefinition
 */

export type BelongsToOptions = {
  foreignKey?: string
  primaryKey?: string
  polymorphic?: boolean
  touch?: boolean
}

export type HasManyOptions = {
  foreignKey?: string
  primaryKey?: string
  through?: string
  source?: string
  order?: Record<string, 'asc' | 'desc'>
  dependent?: 'destroy' | 'delete' | 'nullify' | 'restrict'
  autosave?: boolean
  counterCache?: boolean | string
  /** Enables acceptsNestedAttributesFor — codegen adds `${name}Attributes` to Create/Update types */
  acceptsNested?: boolean
}

export type HasOneOptions = Omit<HasManyOptions, 'through' | 'source'>

export type HabtmOptions = {
  joinTable?: string
  foreignKey?: string
  associationForeignKey?: string
}

export type EnumDefinition<T extends Record<string, number>> = {
  readonly _type: 'enum'
  readonly values: T
}

export type EnumGroupDefinition = {
  readonly _type: 'enumGroup'
  readonly enumField: string
  readonly range: [number, number]
}

export type BelongsToMarker = {
  readonly _type: 'belongsTo'
  readonly table: string | undefined
  readonly options: BelongsToOptions
}

export type HasManyMarker = {
  readonly _type: 'hasMany'
  readonly table: string | undefined
  readonly options: HasManyOptions
}

export type HasOneMarker = {
  readonly _type: 'hasOne'
  readonly table: string | undefined
  readonly options: HasOneOptions
}

export type HabtmMarker = {
  readonly _type: 'habtm'
  readonly table: string
  readonly options: HabtmOptions
}

export type AssociationMarker = BelongsToMarker | HasManyMarker | HasOneMarker | HabtmMarker

export function belongsTo(tableOrOptions?: string | BelongsToOptions, options: BelongsToOptions = {}): BelongsToMarker {
  if (tableOrOptions !== null && typeof tableOrOptions === 'object') {
    return { _type: 'belongsTo', table: undefined, options: tableOrOptions }
  }
  return { _type: 'belongsTo', table: tableOrOptions as string | undefined, options }
}

export function hasMany(tableOrOptions?: string | HasManyOptions, options: HasManyOptions = {}): HasManyMarker {
  if (tableOrOptions !== null && typeof tableOrOptions === 'object') {
    return { _type: 'hasMany', table: undefined, options: tableOrOptions }
  }
  return { _type: 'hasMany', table: tableOrOptions as string | undefined, options }
}

export function hasOne(tableOrOptions?: string | HasOneOptions, options: HasOneOptions = {}): HasOneMarker {
  if (tableOrOptions !== null && typeof tableOrOptions === 'object') {
    return { _type: 'hasOne', table: undefined, options: tableOrOptions }
  }
  return { _type: 'hasOne', table: tableOrOptions as string | undefined, options }
}

export function habtm(table: string, options: HabtmOptions = {}): HabtmMarker {
  return { _type: 'habtm', table, options }
}

export function defineEnum<T extends Record<string, number>>(values: T): EnumDefinition<T> {
  return { _type: 'enum', values }
}

export function enumGroup(enumField: string, range: [number, number]): EnumGroupDefinition {
  return { _type: 'enumGroup', enumField, range }
}
