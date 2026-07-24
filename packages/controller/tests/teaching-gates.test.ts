/** The teaching wave: silent no-ops become loud errors at the right moment. */
import { describe, it, expect } from 'vitest'
import { controller, crud, before, mutation } from '../src/decorators.js'
import { buildRouter } from '../src/router.js'

describe('hook only:/except: name REAL actions (route build)', () => {
  it("a typo'd only: throws at boot with did-you-mean — it would silently never fire", () => {
    @controller('/deals')
    @crud(class Deal {} as any, {})
    class DealController {
      @before({ only: ['updat'] })
      gate() {}
    }
    expect(() => buildRouter(DealController as any)).toThrow(/'updat'[\s\S]*did you mean 'update'[\s\S]*SILENTLY never fires/)
  })
  it('valid names pass; inherited concern hooks are NOT validated (reuse ≠ typo)', () => {
    class Concern { }
    ;(before({ only: ['update', 'archive'] }) as any)(Concern.prototype, 'gate', {})
    @controller('/deals2')
    @crud(class Deal2 {} as any, {})
    class Deal2Controller extends Concern {
      @before({ only: ['update'] }) own() {}
      @mutation() async archive(_d: any) {}
    }
    expect(() => buildRouter(Deal2Controller as any)).not.toThrow()
  })
})

describe('method decorators refuse STATIC members', () => {
  it('@mutation on a static registers on Function itself — teach instead', () => {
    expect(() => {
      class C { static archive() {} }
      ;(mutation() as any)(C, 'archive', {})
    }).toThrow(/INSTANCE methods[\s\S]*static/)
  })
})
