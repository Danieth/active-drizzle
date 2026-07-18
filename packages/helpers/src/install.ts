import * as A from './array.js'
import * as S from './string.js'
import * as N from './number.js'
import * as D from './date.js'
import { isBlank, isPresent } from './object.js'
import { ap, type ApOptions } from './ap.js'

/**
 * Installs Rails-style helpers directly onto Array.prototype,
 * String.prototype, and Number.prototype so you can write:
 *
 *   [1, 2, 3].second()          // 2
 *   users.pluckKey('email')     // ['a@x.com', ...]
 *   'user_profile'.camelize()   // 'userProfile'
 *   3.ordinalize()              // '3rd'  (via (3).ordinalize())
 *   [].isBlank()                  // true
 *
 * All methods are defined non-enumerable (they won't appear in for..in or
 * Object.keys) and installation is idempotent — never overwrites an
 * existing property, so future native methods win automatically.
 *
 * Call once at app boot:
 *   import { installHelpers } from '@active-drizzle/helpers'
 *   installHelpers()
 */

let _installed = false

export function installHelpers(): void {
  if (_installed) return
  _installed = true

  // ── Array.prototype ────────────────────────────────────────────────────
  defineAll(Array.prototype, {
    first(this: unknown[], n?: number) { return n === undefined ? A.first(this) : A.first(this, n) },
    last(this: unknown[], n?: number) { return n === undefined ? A.last(this) : A.last(this, n) },
    second(this: unknown[]) { return A.second(this) },
    third(this: unknown[]) { return A.third(this) },
    fourth(this: unknown[]) { return A.fourth(this) },
    fifth(this: unknown[]) { return A.fifth(this) },
    isBlank(this: unknown[]) { return A.isBlankArray(this) },
    isPresent(this: unknown[]) { return A.isPresentArray(this) },
    presence(this: unknown[]) { return A.presence(this) },
    compact(this: unknown[]) { return A.compact(this) },
    uniq(this: unknown[], by?: (item: unknown) => unknown) { return A.uniq(this, by) },
    without(this: unknown[], ...values: unknown[]) { return A.without(this, ...values) },
    including(this: unknown[], ...values: unknown[]) { return A.including(this, ...values) },
    pluckKey(this: Record<PropertyKey, unknown>[], key: PropertyKey) { return this.map(item => item[key]) },
    groupBy(this: unknown[], by: (item: unknown) => PropertyKey) { return A.groupBy(this, by) },
    indexBy(this: unknown[], by: (item: unknown) => PropertyKey) { return A.indexBy(this, by) },
    countBy(this: unknown[], by: (item: unknown) => PropertyKey) { return A.countBy(this, by) },
    tally(this: unknown[]) { return A.tally(this) },
    partition(this: unknown[], fn: (item: unknown) => boolean) { return A.partition(this, fn) },
    sum(this: unknown[], fn?: (item: unknown) => number) {
      return fn ? A.sum(this, fn) : A.sum(this as number[])
    },
    minBy(this: unknown[], fn: (item: unknown) => number | string) { return A.minBy(this, fn) },
    maxBy(this: unknown[], fn: (item: unknown) => number | string) { return A.maxBy(this, fn) },
    sortBy(this: unknown[], fn: (item: unknown) => number | string) { return A.sortBy(this, fn) },
    eachSlice(this: unknown[], size: number) { return A.eachSlice(this, size) },
    eachCons(this: unknown[], size: number) { return A.eachCons(this, size) },
    inGroupsOf(this: unknown[], size: number, fill?: unknown) { return A.inGroupsOf(this, size, fill ?? null) },
    sample(this: unknown[], n?: number) { return n === undefined ? A.sample(this) : A.sample(this, n) },
    shuffle(this: unknown[]) { return A.shuffle(this) },
    toSentence(this: unknown[], opts?: Parameters<typeof A.toSentence>[1]) { return A.toSentence(this, opts) },
    zip(this: unknown[], ...others: unknown[][]) { return A.zip(this, ...others) },
    rotate(this: unknown[], n?: number) { return A.rotate(this, n) },
    eachWithObject(this: unknown[], obj: unknown, fn: (item: unknown, obj: unknown) => void) { return A.eachWithObject(this, obj, fn) },
    takeWhile(this: unknown[], fn: (item: unknown) => boolean) { return A.takeWhile(this, fn) },
    dropWhile(this: unknown[], fn: (item: unknown) => boolean) { return A.dropWhile(this, fn) },
    chunkWhile(this: unknown[], fn: (a: unknown, b: unknown) => boolean) { return A.chunkWhile(this, fn) },
    sliceWhen(this: unknown[], fn: (a: unknown, b: unknown) => boolean) { return A.sliceWhen(this, fn) },
    from(this: unknown[], index: number) { return A.from(this, index) },
    to(this: unknown[], index: number) { return A.to(this, index) },
    inGroups(this: unknown[], count: number, fill?: unknown, padded?: boolean) { return A.inGroups(this, count, fill ?? null, padded) },
    sole(this: unknown[]) { return A.sole(this) },
    deepDup(this: unknown[]) { return A.deepDup(this) },
    ap(this: unknown[], opts?: ApOptions) { return ap(this, opts) },
  })

  // ── String.prototype ───────────────────────────────────────────────────
  defineAll(String.prototype, {
    pluralize(this: string, count?: number) { return S.pluralize(this, count) },
    singularize(this: string) { return S.singularize(this) },
    camelize(this: string, upperFirst?: boolean) { return S.camelize(this, upperFirst) },
    underscore(this: string) { return S.underscore(this) },
    dasherize(this: string) { return S.dasherize(this) },
    humanize(this: string) { return S.humanize(this) },
    titleize(this: string) { return S.titleize(this) },
    classify(this: string) { return S.classify(this) },
    tableize(this: string) { return S.tableize(this) },
    parameterize(this: string, separator?: string) { return S.parameterize(this, separator) },
    foreignKey(this: string) { return S.foreignKey(this) },
    capitalize(this: string) { return S.capitalize(this) },
    deletePrefix(this: string, prefix: string) { return S.deletePrefix(this, prefix) },
    deleteSuffix(this: string, suffix: string) { return S.deleteSuffix(this, suffix) },
    isBlank(this: string) { return S.isBlankString(this) },
    isPresent(this: string) { return S.isPresentString(this) },
    presence(this: string) { return S.stringPresence(this) },
    truncate(this: string, length: number, opts?: Parameters<typeof S.truncate>[2]) { return S.truncate(this, length, opts) },
    truncateWords(this: string, count: number, omission?: string) { return S.truncateWords(this, count, omission) },
    squish(this: string) { return S.squish(this) },
    stripHeredoc(this: string) { return S.stripHeredoc(this) },
    indent(this: string, amount: number, indentString?: string) { return S.indent(this, amount, indentString) },
    toBoolean(this: string) { return S.toBoolean(this) },
    remove(this: string, ...patterns: (string | RegExp)[]) { return S.remove(this, ...patterns) },
    first(this: string, n?: number) { return S.firstChars(this, n) },
    last(this: string, n?: number) { return S.lastChars(this, n) },
    from(this: string, index: number) { return S.fromIndex(this, index) },
    to(this: string, index: number) { return S.toIndex(this, index) },
    swapcase(this: string) { return S.swapcase(this) },
    center(this: string, width: number, padstr?: string) { return S.center(this, width, padstr) },
    ap(this: string, opts?: ApOptions) { return ap(this.toString(), opts) },
  })

  // ── Number.prototype ───────────────────────────────────────────────────
  defineAll(Number.prototype, {
    ordinal(this: number) { return N.ordinal(this.valueOf()) },
    ordinalize(this: number) { return N.ordinalize(this.valueOf()) },
    withDelimiter(this: number, delimiter?: string, separator?: string) { return N.numberWithDelimiter(this.valueOf(), delimiter, separator) },
    toCurrency(this: number, opts?: Parameters<typeof N.numberToCurrency>[1]) { return N.numberToCurrency(this.valueOf(), opts) },
    toPercentage(this: number, precision?: number) { return N.numberToPercentage(this.valueOf(), precision) },
    toHumanSize(this: number, precision?: number) { return N.numberToHumanSize(this.valueOf(), precision) },
    toHuman(this: number, precision?: number) { return N.numberToHuman(this.valueOf(), precision) },
    clamp(this: number, min: number, max: number) { return N.clamp(this.valueOf(), min, max) },
    multipleOf(this: number, divisor: number) { return N.isMultipleOf(this.valueOf(), divisor) },
    even(this: number) { return N.isEven(this.valueOf()) },
    odd(this: number) { return N.isOdd(this.valueOf()) },
    seconds(this: number) { return N.seconds(this.valueOf()) },
    minutes(this: number) { return N.minutes(this.valueOf()) },
    hours(this: number) { return N.hours(this.valueOf()) },
    days(this: number) { return N.days(this.valueOf()) },
    weeks(this: number) { return N.weeks(this.valueOf()) },
    kilobytes(this: number) { return N.kilobytes(this.valueOf()) },
    megabytes(this: number) { return N.megabytes(this.valueOf()) },
    gigabytes(this: number) { return N.gigabytes(this.valueOf()) },
    terabytes(this: number) { return N.terabytes(this.valueOf()) },
    roundTo(this: number, digits?: number) { return N.roundTo(this.valueOf(), digits) },
    percentOf(this: number, whole: number) { return N.percentOf(this.valueOf(), whole) },
    isBlank(this: number) { return isBlank(this.valueOf()) },
    isPresent(this: number) { return isPresent(this.valueOf()) },
  })

  // ── Date.prototype ─────────────────────────────────────────────────────
  defineAll(Date.prototype, {
    beginningOfDay(this: Date) { return D.beginningOfDay(this) },
    endOfDay(this: Date) { return D.endOfDay(this) },
    beginningOfWeek(this: Date, weekStart?: 'monday' | 'sunday') { return D.beginningOfWeek(this, weekStart) },
    endOfWeek(this: Date, weekStart?: 'monday' | 'sunday') { return D.endOfWeek(this, weekStart) },
    beginningOfMonth(this: Date) { return D.beginningOfMonth(this) },
    endOfMonth(this: Date) { return D.endOfMonth(this) },
    beginningOfQuarter(this: Date) { return D.beginningOfQuarter(this) },
    endOfQuarter(this: Date) { return D.endOfQuarter(this) },
    beginningOfYear(this: Date) { return D.beginningOfYear(this) },
    endOfYear(this: Date) { return D.endOfYear(this) },
    addDays(this: Date, n: number) { return D.addDays(this, n) },
    addWeeks(this: Date, n: number) { return D.addWeeks(this, n) },
    addMonths(this: Date, n: number) { return D.addMonths(this, n) },
    addYears(this: Date, n: number) { return D.addYears(this, n) },
    addHours(this: Date, n: number) { return D.addHours(this, n) },
    addMinutes(this: Date, n: number) { return D.addMinutes(this, n) },
    addSeconds(this: Date, n: number) { return D.addSeconds(this, n) },
    nextOccurring(this: Date, weekday: D.Weekday) { return D.nextOccurring(this, weekday) },
    prevOccurring(this: Date, weekday: D.Weekday) { return D.prevOccurring(this, weekday) },
    isToday(this: Date) { return D.isToday(this) },
    isPast(this: Date) { return D.isPast(this) },
    isFuture(this: Date) { return D.isFuture(this) },
    isWeekend(this: Date) { return D.isWeekend(this) },
    isWeekday(this: Date) { return D.isWeekday(this) },
    timeAgoInWords(this: Date) { return D.timeAgoInWords(this) },
    toFormattedString(this: Date, format?: Parameters<typeof D.toFormattedString>[1]) { return D.toFormattedString(this, format) },
  })
}

function defineAll(proto: object, methods: Record<string, Function>): void {
  for (const [name, fn] of Object.entries(methods)) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) continue // never clobber
    Object.defineProperty(proto, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
}

// ── Global type augmentation ──────────────────────────────────────────────
// These declarations make the prototype methods typecheck after installHelpers().

declare global {
  interface Array<T> {
    first(): T | undefined
    first(n: number): T[]
    last(): T | undefined
    last(n: number): T[]
    second(): T | undefined
    third(): T | undefined
    fourth(): T | undefined
    fifth(): T | undefined
    isBlank(): boolean
    isPresent(): boolean
    presence(): T[] | undefined
    compact(): NonNullable<T>[]
    uniq(by?: (item: T) => unknown): T[]
    without(...values: T[]): T[]
    including(...values: T[]): T[]
    pluckKey<K extends keyof T>(key: K): T[K][]
    groupBy<K extends PropertyKey>(by: (item: T) => K): Record<K, T[]>
    indexBy<K extends PropertyKey>(by: (item: T) => K): Record<K, T>
    countBy<K extends PropertyKey>(by: (item: T) => K): Record<K, number>
    tally(): Map<T, number>
    partition(fn: (item: T) => boolean): [T[], T[]]
    sum(fn?: (item: T) => number): number
    minBy(fn: (item: T) => number | string): T | undefined
    maxBy(fn: (item: T) => number | string): T | undefined
    sortBy(fn: (item: T) => number | string): T[]
    eachSlice(size: number): T[][]
    eachCons(size: number): T[][]
    inGroupsOf<F = null>(size: number, fill?: F): (T | F)[][]
    sample(): T | undefined
    sample(n: number): T[]
    shuffle(): T[]
    toSentence(opts?: { wordsConnector?: string; twoWordsConnector?: string; lastWordConnector?: string }): string
    zip<U>(other: U[]): [T, U][]
    zip(...others: T[][]): T[][]
    rotate(n?: number): T[]
    eachWithObject<O>(obj: O, fn: (item: T, obj: O) => void): O
    takeWhile(fn: (item: T) => boolean): T[]
    dropWhile(fn: (item: T) => boolean): T[]
    chunkWhile(fn: (a: T, b: T) => boolean): T[][]
    sliceWhen(fn: (a: T, b: T) => boolean): T[][]
    from(index: number): T[]
    to(index: number): T[]
    inGroups<F = null>(count: number, fill?: F, padded?: boolean): (T | F)[][]
    sole(): T
    deepDup(): T[]
    ap(opts?: ApOptions): T[]
  }

  interface String {
    pluralize(count?: number): string
    singularize(): string
    camelize(upperFirst?: boolean): string
    underscore(): string
    dasherize(): string
    humanize(): string
    titleize(): string
    classify(): string
    tableize(): string
    parameterize(separator?: string): string
    foreignKey(): string
    capitalize(): string
    deletePrefix(prefix: string): string
    deleteSuffix(suffix: string): string
    isBlank(): boolean
    isPresent(): boolean
    presence(): string | undefined
    truncate(length: number, opts?: { omission?: string; separator?: string }): string
    truncateWords(count: number, omission?: string): string
    squish(): string
    stripHeredoc(): string
    indent(amount: number, indentString?: string): string
    toBoolean(): boolean
    remove(...patterns: (string | RegExp)[]): string
    first(n?: number): string
    last(n?: number): string
    from(index: number): string
    to(index: number): string
    swapcase(): string
    center(width: number, padstr?: string): string
    ap(opts?: ApOptions): string
  }

  interface Number {
    ordinal(): string
    ordinalize(): string
    withDelimiter(delimiter?: string, separator?: string): string
    toCurrency(opts?: { unit?: string; precision?: number; delimiter?: string; separator?: string }): string
    toPercentage(precision?: number): string
    toHumanSize(precision?: number): string
    toHuman(precision?: number): string
    clamp(min: number, max: number): number
    multipleOf(divisor: number): boolean
    even(): boolean
    odd(): boolean
    seconds(): number
    minutes(): number
    hours(): number
    days(): number
    weeks(): number
    kilobytes(): number
    megabytes(): number
    gigabytes(): number
    terabytes(): number
    roundTo(digits?: number): number
    percentOf(whole: number): number
    isBlank(): boolean
    isPresent(): boolean
  }

  interface Date {
    beginningOfDay(): Date
    endOfDay(): Date
    beginningOfWeek(weekStart?: 'monday' | 'sunday'): Date
    endOfWeek(weekStart?: 'monday' | 'sunday'): Date
    beginningOfMonth(): Date
    endOfMonth(): Date
    beginningOfQuarter(): Date
    endOfQuarter(): Date
    beginningOfYear(): Date
    endOfYear(): Date
    addDays(n: number): Date
    addWeeks(n: number): Date
    addMonths(n: number): Date
    addYears(n: number): Date
    addHours(n: number): Date
    addMinutes(n: number): Date
    addSeconds(n: number): Date
    nextOccurring(weekday: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'): Date
    prevOccurring(weekday: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'): Date
    isToday(): boolean
    isPast(): boolean
    isFuture(): boolean
    isWeekend(): boolean
    isWeekday(): boolean
    timeAgoInWords(): string
    toFormattedString(format?: 'short' | 'long' | 'db' | 'iso8601' | 'number'): string
  }
}
