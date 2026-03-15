import type { HookEntry, ActionEntry } from './metadata.js'

export interface ControllerConcernDef<TConfig = void> {
  name: string

  // Optional configuration for @include(Concern, config)
  configure?: (options: TConfig) => TConfig

  // Before-hooks to inject (fire like @before)
  before?: Array<{
    method: string
    fn: (this: any, ctx: any, ...args: any[]) => any
    only?: string[]
    except?: string[]
  }>

  // After-hooks to inject (fire like @after)
  after?: Array<{
    method: string
    fn: (this: any, ctx: any, ...args: any[]) => any
    only?: string[]
    except?: string[]
  }>

  // Additional @action routes to inject on the controller
  actions?: Array<{
    method: string
    fn: (this: any, ctx: any, ...args: any[]) => any
    httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path?: string
    load?: boolean
  }>

  // Other concerns this one requires (enforced at @include time)
  requires?: ControllerConcern<any>[]
}

export interface ControllerConcern<TConfig = void> {
  __type: 'controller_concern'
  name: string
  def: ControllerConcernDef<TConfig>
}

export function defineControllerConcern<TConfig = void>(
  def: ControllerConcernDef<TConfig>
): ControllerConcern<TConfig> {
  return {
    __type: 'controller_concern',
    name: def.name,
    def,
  }
}
