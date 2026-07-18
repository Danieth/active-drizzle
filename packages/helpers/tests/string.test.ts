import { describe, it, expect } from 'vitest'
import {
  pluralize, singularize, camelize, underscore, dasherize,
  humanize, titleize, classify, tableize, parameterize, foreignKey,
  capitalize, deletePrefix, deleteSuffix,
  isBlankString, isPresentString, stringPresence,
  truncate, truncateWords, squish, stripHeredoc, indent, toBoolean,
} from '../src/string.js'

describe('inflections', () => {
  it('pluralize / singularize', () => {
    expect(pluralize('user')).toBe('users')
    expect(pluralize('person')).toBe('people')
    expect(pluralize('octopus')).toBe('octopuses')
    expect(pluralize('user', 1)).toBe('user')
    expect(pluralize('user', 2)).toBe('users')
    expect(singularize('users')).toBe('user')
    expect(singularize('people')).toBe('person')
  })

  it('camelize', () => {
    expect(camelize('user_profile')).toBe('userProfile')
    expect(camelize('user-profile')).toBe('userProfile')
    expect(camelize('user profile')).toBe('userProfile')
    expect(camelize('user_profile', true)).toBe('UserProfile')
  })

  it('underscore / dasherize', () => {
    expect(underscore('userProfile')).toBe('user_profile')
    expect(underscore('UserProfile')).toBe('user_profile')
    expect(underscore('HTMLParser')).toBe('html_parser')
    expect(dasherize('userProfile')).toBe('user-profile')
    expect(dasherize('user_profile')).toBe('user-profile')
  })

  it('humanize / titleize', () => {
    expect(humanize('employee_salary')).toBe('Employee salary')
    expect(humanize('author_id')).toBe('Author')
    expect(titleize('man of steel')).toBe('Man Of Steel')
    expect(titleize('x_men_origins')).toBe('X Men Origins')
  })

  it('classify / tableize / foreignKey', () => {
    expect(classify('user_profiles')).toBe('UserProfile')
    expect(tableize('UserProfile')).toBe('user_profiles')
    expect(foreignKey('UserProfile')).toBe('user_profile_id')
    expect(foreignKey('users')).toBe('user_id')
  })

  it('parameterize', () => {
    expect(parameterize('Donald E. Knuth')).toBe('donald-e-knuth')
    expect(parameterize('Café au Lait!')).toBe('cafe-au-lait')
    expect(parameterize('a b', '_')).toBe('a_b')
  })

  it('capitalize / deletePrefix / deleteSuffix', () => {
    expect(capitalize('hello world')).toBe('Hello world')
    expect(deletePrefix('unhappy', 'un')).toBe('happy')
    expect(deletePrefix('happy', 'un')).toBe('happy')
    expect(deleteSuffix('running', 'ning')).toBe('run')
    expect(deleteSuffix('run', 'ning')).toBe('run')
  })
})

describe('presence', () => {
  it('blank / present / presence', () => {
    expect(isBlankString('')).toBe(true)
    expect(isBlankString('   ')).toBe(true)
    expect(isBlankString(null)).toBe(true)
    expect(isBlankString(undefined)).toBe(true)
    expect(isBlankString('x')).toBe(false)
    expect(isPresentString('x')).toBe(true)
    expect(stringPresence('  ')).toBeUndefined()
    expect(stringPresence('hi')).toBe('hi')
  })
})

describe('formatting', () => {
  it('truncate', () => {
    expect(truncate('Once upon a time in a world far far away', 27)).toBe('Once upon a time in a wo...')
    expect(truncate('short', 27)).toBe('short')
    expect(truncate('Once upon a time', 12, { separator: ' ' })).toBe('Once upon...')
    expect(truncate('abc', 5, { omission: '…' })).toBe('abc')
  })

  it('truncateWords', () => {
    expect(truncateWords('Once upon a time in a world', 4)).toBe('Once upon a time...')
    expect(truncateWords('one two', 5)).toBe('one two')
  })

  it('squish', () => {
    expect(squish('  foo   bar  \n  baz ')).toBe('foo bar baz')
  })

  it('stripHeredoc', () => {
    const text = '    line one\n      line two\n    line three'
    expect(stripHeredoc(text)).toBe('line one\n  line two\nline three')
  })

  it('indent', () => {
    expect(indent('a\nb', 2)).toBe('  a\n  b')
    expect(indent('a\n\nb', 2)).toBe('  a\n\n  b') // empty lines untouched
    expect(indent('x', 2, '\t')).toBe('\t\tx')
  })

  it('toBoolean', () => {
    for (const t of ['1', 'true', 'TRUE', 'yes', 'on', 't', 'y']) expect(toBoolean(t)).toBe(true)
    for (const f of ['0', 'false', 'no', 'off', '', 'banana', null, undefined]) expect(toBoolean(f)).toBe(false)
  })
})
