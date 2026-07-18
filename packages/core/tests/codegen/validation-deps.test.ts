import { describe, it, expect } from 'vitest'
import { Project, type ClassDeclaration } from 'ts-morph'
import {
  inferValidationDeps,
  resolveValidationDeps,
  parseDeclaredDeps,
  depsFitProjection,
} from '../../src/codegen/validation-deps.js'

function loadClass(source: string): { project: Project; cls: ClassDeclaration } {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true } })
  const sf = project.createSourceFile('Loan.model.ts', source)
  const cls = sf.getClasses()[0]!
  return { project, cls }
}

function method(cls: ClassDeclaration, name: string) {
  return cls.getInstanceMethod(name)!
}

describe('inferValidationDeps', () => {
  it('infers this.field reads', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        checkCap() {
          if (this.amount > this.adminCap) return 'exceeds cap'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'checkCap'), cls)
    expect(result).toEqual({ ok: true, deps: ['adminCap', 'amount'], source: 'inferred' })
  })

  it('infers destructuring from this', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          const { amount, rate } = this
          if (amount * rate > 100) return 'too high'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok && result.deps).toEqual(['amount', 'rate'])
  })

  it('follows own method calls', () => {
    const { cls } = loadClass(`
      class Loan {
        helper() { return this.amount + this.fee }
        @validate()
        check() {
          if (this.helper() > 100) return 'too high'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok && result.deps).toEqual(['amount', 'fee'])
  })

  it('treats amountChanged() as dep on amount', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          if (this.amountChanged() && this.amount < 0) return 'bad'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok && result.deps).toEqual(['amount'])
  })

  it('refuses computed this[field] access', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          const k = 'amount'
          if (this[k] < 0) return 'bad'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/computed/)
  })

  it('refuses computed access even through a cast — (this as any)[k]', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          const k = 'amount' + ''
          if ((this as any)[k] < 0) return 'bad'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/computed/)
  })

  it('counts (this as any).field as a normal field read', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          if ((this as any).amount < 0) return 'bad'
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result).toEqual({ ok: true, deps: ['amount'], source: 'inferred' })
  })

  it('refuses a cast this escaping as an argument — helper(this as any)', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          return externalCheck(this as any)
        }
      }
      function validate() { return () => {} }
      function externalCheck(x: unknown) { return null }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/escapes/)
  })

  it('refuses this escaping as an argument', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          return externalCheck(this)
        }
      }
      function validate() { return () => {} }
      function externalCheck(_x: any) { return null }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/escapes/)
  })

  it('ignores this.errors (not a field dep)', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate()
        check() {
          if (this.amount < 0) this.errors.add('amount', 'must be positive')
        }
      }
      function validate() { return () => {} }
    `)
    const result = inferValidationDeps(method(cls, 'check'), cls)
    expect(result.ok && result.deps).toEqual(['amount'])
  })
})

describe('resolveValidationDeps with declared deps', () => {
  it('uses declared deps as escape hatch when body is unanalyzable', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate({ deps: ['amount'] })
        check() {
          return externalCheck(this)
        }
      }
      function validate(_opts?: any) { return () => {} }
      function externalCheck(_x: any) { return null }
    `)
    const validateDec = method(cls, 'check').getDecorators().find(d => d.getName() === 'validate')
    const declared = parseDeclaredDeps(validateDec?.getArguments()[0])
    const result = resolveValidationDeps(method(cls, 'check'), cls, declared)
    expect(result).toEqual({ ok: true, deps: ['amount'], source: 'declared' })
  })

  it('errors when declared deps miss inferred fields', () => {
    const { cls } = loadClass(`
      class Loan {
        @validate({ deps: ['amount'] })
        check() {
          if (this.amount > this.adminCap) return 'bad'
        }
      }
      function validate(_opts?: any) { return () => {} }
    `)
    const validateDec = method(cls, 'check').getDecorators().find(d => d.getName() === 'validate')
    const declared = parseDeclaredDeps(validateDec?.getArguments()[0])
    const result = resolveValidationDeps(method(cls, 'check'), cls, declared)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/adminCap/)
  })
})

describe('depsFitProjection', () => {
  it('requires every dep to be in the projection', () => {
    expect(depsFitProjection(['amount'], new Set(['amount', 'name']))).toBe(true)
    expect(depsFitProjection(['amount', 'adminCap'], new Set(['amount', 'name']))).toBe(false)
    expect(depsFitProjection([], new Set(['amount']))).toBe(true)
  })
})
