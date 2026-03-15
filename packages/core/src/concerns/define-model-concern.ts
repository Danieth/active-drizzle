export interface ModelConcernDef<TConfig = void> {
  name: string

  // Optional: makes the concern configurable via @include(Concern, { ... })
  configure?: (options: TConfig) => TConfig

  // Instance methods added to the model prototype
  methods?: Record<string, Function>

  // Getters added to the model prototype
  getters?: Record<string, () => any>

  // Static scopes added to the model class (same as @scope static methods)
  scopes?: Record<string, (query: any, ...args: any[]) => any>

  // Default scope — auto-applied to all queries, removable via .unscoped('ConcernName')
  defaultScope?: (query: any) => any

  // Lifecycle callbacks — same shape as @beforeSave, @afterCreate, etc.
  callbacks?: {
    beforeValidate?: Function | Function[]
    afterValidate?:  Function | Function[]
    beforeSave?:    Function | Function[]
    afterSave?:     Function | Function[]
    beforeCreate?:  Function | Function[]
    afterCreate?:   Function | Function[]
    beforeUpdate?:  Function | Function[]
    afterUpdate?:   Function | Function[]
    beforeDestroy?: Function | Function[]
    afterDestroy?:  Function | Function[]
    afterCommit?:   Function | Function[]
  }

  // Associations added to the model (same shape as static properties)
  associations?: Record<string, any>

  // Override framework behavior
  overrides?: {
    destroy?: 'soft'  // .destroy() sets deletedAt instead of DELETE
  }

  // Other concerns that must be @include'd alongside this one
  requires?: ModelConcern<any>[]
  
  // Array of method names that are safe to expose to the client bundle
  pure?: string[]
}

export interface ModelConcern<TConfig = void> {
  __type: 'model_concern'
  name: string
  def: ModelConcernDef<TConfig>
}

export function defineModelConcern<TConfig = void>(
  def: ModelConcernDef<TConfig>
): ModelConcern<TConfig> {
  return {
    __type: 'model_concern',
    name: def.name,
    def,
  }
}
