/**
 * USING.gen.md — the generated usage prose. The law it must never break
 * (the lying-JSDoc lesson): everything conditional on THIS app's config.
 */
import { describe, it, expect } from 'vitest'
import { generateUsingDoc } from '../../src/codegen/using-doc.js'

const ctrl = (over: any = {}): any => ({
  filePath: '/c.ts', className: 'DealController', basePath: '/deals',
  scopes: [], kind: 'crud', modelClass: 'Deal', mutations: [], actions: [], ...over,
})

describe('USING.gen.md', () => {
  it('teaches the factory pattern, the wire shape, and the wire vocabulary', () => {
    const doc = generateUsingDoc({ controllers: [ctrl()] }, null)
    expect(doc).toContain('DealController.use({})')                 // the factory convention
    expect(doc).toContain('{ data, pagination')                     // stumble #2, written down
    expect(doc).toContain(`_event: 'submit'`)                        // stumble #4
    expect(doc).toContain('MODEL-SPACE')                             // seek cursors
    expect(doc).toContain('useDealEditForm(id)')
    expect(doc).toContain('edit is NEVER inferred')
  })

  it('is CONDITIONAL on config — no sentences about absent features', () => {
    const bare = generateUsingDoc({ controllers: [ctrl()] }, null)
    expect(bare).not.toContain('Mutations')                          // none declared → no section
    expect(bare).not.toContain('props.ctx')                          // no @frontendContext → silent
    const rich = generateUsingDoc({ controllers: [ctrl({
      mutations: [{ method: 'markWon', bulk: false, if: () => true, params: ['reason'] }],
      frontendContext: [{ key: 'userType', type: `"admin" | "member"`, owner: 'AppDoor' }],
      scopes: [{ field: 'teamId', resource: 'teams', paramName: 'teamId' }],
    })] }, null)
    expect(rich).toContain('<deal.MarkWon/>')
    expect(rich).toContain('params: reason')
    expect(rich).toContain('guarded')
    expect(rich).toContain('ctx.userType')
    expect(rich).toContain(`"admin" | "member"`)
    expect(rich).toContain('use({ teamId })')                        // scope args shown truthfully
  })
})
