/**
 * Rails ActiveSupport-style array helpers.
 *
 * Every helper is available two ways:
 *   1. As a pure function:      `first([1,2,3])`
 *   2. On Array.prototype:      `[1,2,3].first()` — after `installHelpers()`
 */

// ── Element access ───────────────────────────────────────────────────────────

export function first<T>(arr: readonly T[]): T | undefined
export function first<T>(arr: readonly T[], n: number): T[]
export function first<T>(arr: readonly T[], n?: number): T | undefined | T[] {
  if (n === undefined) return arr[0]
  return arr.slice(0, n)
}

export function last<T>(arr: readonly T[]): T | undefined
export function last<T>(arr: readonly T[], n: number): T[]
export function last<T>(arr: readonly T[], n?: number): T | undefined | T[] {
  if (n === undefined) return arr[arr.length - 1]
  return n === 0 ? [] : arr.slice(-n)
}

export function second<T>(arr: readonly T[]): T | undefined { return arr[1] }
export function third<T>(arr: readonly T[]): T | undefined { return arr[2] }
export function fourth<T>(arr: readonly T[]): T | undefined { return arr[3] }
export function fifth<T>(arr: readonly T[]): T | undefined { return arr[4] }

// ── Presence ─────────────────────────────────────────────────────────────────

export function isBlankArray(arr: readonly unknown[]): boolean { return arr.length === 0 }
export function isPresentArray(arr: readonly unknown[]): boolean { return arr.length > 0 }

/** Returns the array itself when non-empty, otherwise undefined. Rails' `presence`. */
export function presence<T>(arr: readonly T[]): T[] | undefined {
  return arr.length > 0 ? [...arr] : undefined
}

// ── Filtering / transforming ─────────────────────────────────────────────────

/** Removes null and undefined. Rails' `compact`. */
export function compact<T>(arr: readonly (T | null | undefined)[]): T[] {
  return arr.filter((v): v is T => v !== null && v !== undefined)
}

/** Unique values; optional key function (Rails' `uniq { }`). */
export function uniq<T>(arr: readonly T[], by?: (item: T) => unknown): T[] {
  if (!by) return [...new Set(arr)]
  const seen = new Set<unknown>()
  const out: T[] = []
  for (const item of arr) {
    const k = by(item)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(item)
    }
  }
  return out
}

/** Everything except the given values. Rails' `without` / `excluding`. */
export function without<T>(arr: readonly T[], ...values: T[]): T[] {
  const excluded = new Set(values)
  return arr.filter(v => !excluded.has(v))
}

/** Concatenates additional values. Rails' `including`. */
export function including<T>(arr: readonly T[], ...values: T[]): T[] {
  return [...arr, ...values]
}

/** Extracts a property (or applies a fn) from each element. Rails' `pluck`. */
export function pluck<T, K extends keyof T>(arr: readonly T[], key: K): T[K][] {
  return arr.map(item => item[key])
}

// ── Grouping / aggregating ───────────────────────────────────────────────────

export function groupBy<T, K extends PropertyKey>(
  arr: readonly T[],
  by: (item: T) => K
): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of arr) {
    const k = by(item)
    ;(out[k] ??= []).push(item)
  }
  return out
}

/** Like groupBy but keeps only the last item per key. Rails' `index_by`. */
export function indexBy<T, K extends PropertyKey>(
  arr: readonly T[],
  by: (item: T) => K
): Record<K, T> {
  const out = {} as Record<K, T>
  for (const item of arr) out[by(item)] = item
  return out
}

export function countBy<T, K extends PropertyKey>(
  arr: readonly T[],
  by: (item: T) => K
): Record<K, number> {
  const out = {} as Record<K, number>
  for (const item of arr) {
    const k = by(item)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

/** Counts occurrences of each value. Rails/Ruby `tally`. */
export function tally<T>(arr: readonly T[]): Map<T, number> {
  const out = new Map<T, number>()
  for (const item of arr) out.set(item, (out.get(item) ?? 0) + 1)
  return out
}

/** Splits into [matching, notMatching]. Ruby's `partition`. */
export function partition<T>(arr: readonly T[], fn: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = []
  const no: T[] = []
  for (const item of arr) (fn(item) ? yes : no).push(item)
  return [yes, no]
}

export function sum(arr: readonly number[]): number
export function sum<T>(arr: readonly T[], fn: (item: T) => number): number
export function sum<T>(arr: readonly T[], fn?: (item: T) => number): number {
  let total = 0
  for (const item of arr) total += fn ? fn(item) : (item as unknown as number)
  return total
}

export function minBy<T>(arr: readonly T[], fn: (item: T) => number | string): T | undefined {
  let best: T | undefined
  let bestVal: number | string | undefined
  for (const item of arr) {
    const v = fn(item)
    if (bestVal === undefined || v < bestVal) { best = item; bestVal = v }
  }
  return best
}

export function maxBy<T>(arr: readonly T[], fn: (item: T) => number | string): T | undefined {
  let best: T | undefined
  let bestVal: number | string | undefined
  for (const item of arr) {
    const v = fn(item)
    if (bestVal === undefined || v > bestVal) { best = item; bestVal = v }
  }
  return best
}

/** Stable sort by a key function (asc). Ruby's `sort_by`. */
export function sortBy<T>(arr: readonly T[], fn: (item: T) => number | string): T[] {
  return [...arr].sort((a, b) => {
    const va = fn(a)
    const vb = fn(b)
    return va < vb ? -1 : va > vb ? 1 : 0
  })
}

// ── Slicing / iterating ──────────────────────────────────────────────────────

/** Chunks into groups of `size`. Ruby's `each_slice` (returned eagerly). */
export function eachSlice<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('eachSlice: size must be >= 1')
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Sliding window of consecutive elements. Ruby's `each_cons`. */
export function eachCons<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('eachCons: size must be >= 1')
  const out: T[][] = []
  for (let i = 0; i + size <= arr.length; i++) out.push(arr.slice(i, i + size))
  return out
}

/** Like eachSlice but pads the last group with `fill`. Rails' `in_groups_of`. */
export function inGroupsOf<T, F = null>(arr: readonly T[], size: number, fill: F = null as F): (T | F)[][] {
  const groups = eachSlice(arr, size) as (T | F)[][]
  const lastGroup = groups[groups.length - 1]
  if (lastGroup && lastGroup.length < size) {
    while (lastGroup.length < size) lastGroup.push(fill)
  }
  return groups
}

// ── Ruby Enumerable gap-fills ────────────────────────────────────────────────

/** Ruby's `zip` — pairs elements positionally; shorter inputs yield undefined. */
export function zip<T, U>(a: readonly T[], b: readonly U[]): [T, U][]
export function zip<T>(a: readonly T[], ...others: readonly (readonly T[])[]): T[][]
export function zip(a: readonly unknown[], ...others: readonly (readonly unknown[])[]): unknown[][] {
  return a.map((item, i) => [item, ...others.map(o => o[i])])
}

/** Ruby's `rotate` — moves the first n elements to the end (negative rotates right). */
export function rotate<T>(arr: readonly T[], n = 1): T[] {
  if (arr.length === 0) return []
  const k = ((n % arr.length) + arr.length) % arr.length
  return [...arr.slice(k), ...arr.slice(0, k)]
}

/** Ruby's `each_with_object` — folds into a mutable accumulator. */
export function eachWithObject<T, O>(arr: readonly T[], obj: O, fn: (item: T, obj: O) => void): O {
  for (const item of arr) fn(item, obj)
  return obj
}

/** Ruby's `take_while` / `drop_while`. */
export function takeWhile<T>(arr: readonly T[], fn: (item: T) => boolean): T[] {
  const out: T[] = []
  for (const item of arr) {
    if (!fn(item)) break
    out.push(item)
  }
  return out
}

export function dropWhile<T>(arr: readonly T[], fn: (item: T) => boolean): T[] {
  let i = 0
  while (i < arr.length && fn(arr[i]!)) i++
  return arr.slice(i)
}

/** Ruby's `chunk_while` — groups consecutive elements while the predicate holds. */
export function chunkWhile<T>(arr: readonly T[], fn: (a: T, b: T) => boolean): T[][] {
  if (arr.length === 0) return []
  const out: T[][] = [[arr[0]!]]
  for (let i = 1; i < arr.length; i++) {
    const prev = arr[i - 1]!
    const curr = arr[i]!
    if (fn(prev, curr)) out[out.length - 1]!.push(curr)
    else out.push([curr])
  }
  return out
}

/** Ruby's `slice_when` — inverse of chunkWhile: splits when the predicate holds. */
export function sliceWhen<T>(arr: readonly T[], fn: (a: T, b: T) => boolean): T[][] {
  return chunkWhile(arr, (a, b) => !fn(a, b))
}

/** Ruby's `flat_map` (alias, arr.flatMap exists natively — provided for parity). */
export function flatMapDeep<T>(arr: readonly T[]): unknown[] {
  return (arr as unknown[]).flat(Infinity)
}

// ── Rails Array extensions ───────────────────────────────────────────────────

/** Rails' `Array#from` — elements from index onward ([] when past the end). */
export function from<T>(arr: readonly T[], index: number): T[] {
  return arr.slice(index)
}

/** Rails' `Array#to` — elements up to and including index. */
export function to<T>(arr: readonly T[], index: number): T[] {
  return index < 0 ? [] : arr.slice(0, index + 1)
}

/**
 * Rails' `in_groups` — splits into `count` groups of near-equal size,
 * padding with `fill` (pass `undefined` explicitly for no padding via padded=false).
 */
export function inGroups<T, F = null>(
  arr: readonly T[],
  count: number,
  fill: F = null as F,
  padded = true
): (T | F)[][] {
  if (count < 1) throw new Error('inGroups: count must be >= 1')
  const division = Math.floor(arr.length / count)
  const modulo = arr.length % count
  const groups: (T | F)[][] = []
  let start = 0
  for (let i = 0; i < count; i++) {
    const length = division + (i < modulo ? 1 : 0)
    const group: (T | F)[] = arr.slice(start, start + length)
    if (padded && modulo > 0 && i >= modulo) group.push(fill)
    groups.push(group)
    start += length
  }
  return groups
}

/**
 * Rails' `sole` — the single element; throws when the array has 0 or 2+ items.
 */
export function sole<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('sole: array is empty')
  if (arr.length > 1) throw new Error(`sole: array has ${arr.length} elements, expected exactly 1`)
  return arr[0]!
}

/** Rails' `deep_dup` — structured deep clone of plain data (objects/arrays/dates). */
export function deepDup<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (Array.isArray(value)) return value.map(deepDup) as T
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([k, v]) => [deepDup(k), deepDup(v)])) as T
  }
  if (value instanceof Set) return new Set([...value].map(deepDup)) as T
  if ((value as object).constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = deepDup(v)
    return out as T
  }
  return value // class instances passed through by reference (like Rails non-duplicable)
}

// ── Random ───────────────────────────────────────────────────────────────────

export function sample<T>(arr: readonly T[]): T | undefined
export function sample<T>(arr: readonly T[], n: number): T[]
export function sample<T>(arr: readonly T[], n?: number): T | undefined | T[] {
  if (n === undefined) return arr[Math.floor(Math.random() * arr.length)]
  return shuffle(arr).slice(0, n)
}

export function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** `['a','b','c'].toSentence()` → "a, b, and c". Rails' `to_sentence`. */
export function toSentence(
  arr: readonly unknown[],
  opts: { wordsConnector?: string; twoWordsConnector?: string; lastWordConnector?: string } = {}
): string {
  const {
    wordsConnector = ', ',
    twoWordsConnector = ' and ',
    lastWordConnector = ', and ',
  } = opts
  const strs = arr.map(String)
  if (strs.length === 0) return ''
  if (strs.length === 1) return strs[0]!
  if (strs.length === 2) return strs.join(twoWordsConnector)
  return strs.slice(0, -1).join(wordsConnector) + lastWordConnector + strs[strs.length - 1]!
}
