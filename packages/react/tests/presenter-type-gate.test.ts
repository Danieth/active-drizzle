/**
 * The presenter type gate — compile-time proof.
 *
 * This file augments AdPresenterKinds and asserts (via @ts-expect-error,
 * enforced by `tsc --noEmit`) that a presenter/kind mismatch is a COMPILE
 * error while legal pairings and '*' presenters typecheck. The runtime
 * assertions below are trivial — the real test is that this file compiles.
 */
import { describe, it, expect } from 'vitest'
import type { PresenterNameFor } from '../src/index.js'
import type { TypedFieldProps } from '../src/index.js'

declare module '../src/presenters.js' {
  interface AdPresenterKinds {
    moneyInput: 'money'
    moneyText: 'money'
    percentSlider: 'percent'
    flexInput: 'money' | 'percent'
    badge: '*'
  }
}

// ── Type-level assertions ────────────────────────────────────────────────────

// Legal: exact kind match
const legalEdit: TypedFieldProps<'money'> = { edit: 'moneyInput' }
// Legal: multi-kind presenter containing the field's kind
const legalFlex: TypedFieldProps<'percent'> = { edit: 'flexInput' }
// Legal: '*' presenter renders any kind
const legalStar: TypedFieldProps<'state'> = { view: 'badge' }
// Legal: bare boolean opt-in never names a presenter
const legalBool: TypedFieldProps<'money'> = { edit: true }

// @ts-expect-error — percentSlider does not accept 'money' fields
const illegalKind: TypedFieldProps<'money'> = { edit: 'percentSlider' }
// @ts-expect-error — unknown presenter names are rejected once the gate is on
const illegalName: TypedFieldProps<'money'> = { edit: 'nonexistent' }
// @ts-expect-error — view is gated exactly like edit
const illegalView: TypedFieldProps<'percent'> = { view: 'moneyText' }

// Narrowing sanity: the union for 'money' is exactly the money-capable names
type MoneyNames = PresenterNameFor<'money'>
const ok1: MoneyNames = 'moneyInput'
const ok2: MoneyNames = 'flexInput'
const ok3: MoneyNames = 'badge'
// @ts-expect-error — percentSlider is not money-capable
const bad: MoneyNames = 'percentSlider'

describe('presenter type gate', () => {
  it('compiles — the assertions above are the test', () => {
    // Reference the values so noUnusedLocals stays quiet
    expect([legalEdit, legalFlex, legalStar, legalBool, illegalKind, illegalName, illegalView, ok1, ok2, ok3, bad]).toBeDefined()
  })
})
