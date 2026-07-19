# Array Helpers

Rails ActiveSupport / Ruby Enumerable–style array helpers, each available as a pure function (`first([1,2,3])`) or on `Array.prototype` after `installHelpers()`.

## Access

### `first<T>(arr: readonly T[], n?: number)`
First element, or the first `n` elements when `n` is given. Rails `Array#first`.
```ts
first([1, 2, 3])      // → 1
first([1, 2, 3], 2)   // → [1, 2]
first([])             // → undefined
```

### `last<T>(arr: readonly T[], n?: number)`
Last element, or the last `n` elements when `n` is given (`n === 0` → `[]`). Rails `Array#last`.
```ts
last([1, 2, 3])       // → 3
last([1, 2, 3], 2)    // → [2, 3]
last([1, 2, 3], 0)    // → []
```

### `second<T>(arr: readonly T[]): T | undefined`
Element at index 1. Rails `Array#second`.
```ts
second([1, 2, 3, 4, 5, 6])   // → 2
```

### `third<T>(arr: readonly T[]): T | undefined`
Element at index 2. Rails `Array#third`.
```ts
third([1, 2, 3, 4, 5, 6])    // → 3
```

### `fourth<T>(arr: readonly T[]): T | undefined`
Element at index 3. Rails `Array#fourth`.
```ts
fourth([1, 2, 3, 4, 5, 6])   // → 4
```

### `fifth<T>(arr: readonly T[]): T | undefined`
Element at index 4. Rails `Array#fifth`.
```ts
fifth([1, 2, 3, 4, 5, 6])    // → 5
fifth([1])                   // → undefined
```

### `sole<T>(arr: readonly T[]): T`
The single element; throws when the array has 0 or 2+ items. Rails `Array#sole`.
```ts
sole([42])       // → 42
sole([])         // → throws Error: sole: array is empty
sole([1, 2])     // → throws Error: sole: array has 2 elements, expected exactly 1
```

## Presence

### `isBlankArray(arr: readonly unknown[]): boolean`
True when the array is empty. Rails `blank?`.
```ts
isBlankArray([])    // → true
isBlankArray([1])   // → false
```

### `isPresentArray(arr: readonly unknown[]): boolean`
True when the array has at least one element. Rails `present?`.
```ts
isPresentArray([1])   // → true
isPresentArray([])    // → false
```

### `presence<T>(arr: readonly T[]): T[] | undefined`
Returns a copy of the array when non-empty, otherwise `undefined`. Rails `presence`.
```ts
presence([1, 2])   // → [1, 2]
presence([])       // → undefined
```

## Filtering & uniqueness

### `compact<T>(arr: readonly (T | null | undefined)[]): T[]`
Removes `null` and `undefined` only (keeps `0`, `''`, `false`). Rails `compact`.
```ts
compact([1, null, 2, undefined, 0, '', false])   // → [1, 2, 0, '', false]
```

### `uniq<T>(arr: readonly T[], by?: (item: T) => unknown): T[]`
Unique values, keeping the first occurrence; optional key function. Rails `uniq { }`.
```ts
uniq([1, 2, 2, 3, 1])                                  // → [1, 2, 3]
uniq([{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }], i => i.id)
                                                       // → [{ id: 1, v: 'a' }, { id: 2, v: 'c' }]
```

### `without<T>(arr: readonly T[], ...values: T[]): T[]`
Everything except the given values. Rails `without` / `excluding`.
```ts
without([1, 2, 3, 2], 2)   // → [1, 3]
```

### `including<T>(arr: readonly T[], ...values: T[]): T[]`
Concatenates additional values onto a copy. Rails `including`.
```ts
including([1, 2], 3, 4)    // → [1, 2, 3, 4]
```

## Transformation

### `pluck<T, K extends keyof T>(arr: readonly T[], key: K): T[K][]`
Extracts one property from each element. Rails `pluck`.
```ts
pluck([{ name: 'a', age: 1 }, { name: 'b', age: 2 }], 'name')   // → ['a', 'b']
```

### `zip<T, U>(a: readonly T[], ...others: readonly (readonly unknown[])[])`
Pairs elements positionally; missing values from shorter inputs become `undefined`. Ruby `zip`.
```ts
zip([1, 2, 3], ['a', 'b', 'c'])   // → [[1, 'a'], [2, 'b'], [3, 'c']]
zip([1, 2, 3], ['a'])             // → [[1, 'a'], [2, undefined], [3, undefined]]
```

### `rotate<T>(arr: readonly T[], n = 1): T[]`
Moves the first `n` elements to the end (negative rotates right). Ruby `rotate`.
```ts
rotate([1, 2, 3, 4])       // → [2, 3, 4, 1]
rotate([1, 2, 3, 4], -1)   // → [4, 1, 2, 3]
```

### `flatMapDeep<T>(arr: readonly T[]): unknown[]`
Fully flattens a nested array (depth `Infinity`). lodash `_.flattenDeep`.
```ts
flatMapDeep([1, [2, [3, [4]]]])   // → [1, 2, 3, 4]
```

### `deepDup<T>(value: T): T`
Structured deep clone of plain data (objects, arrays, `Date`, `Map`, `Set`); class instances pass through by reference. Rails `deep_dup`.
```ts
deepDup({ a: [1, 2], b: { c: 3 } })   // → { a: [1, 2], b: { c: 3 } }  (no shared refs)
```

## Grouping & aggregation

### `groupBy<T, K extends PropertyKey>(arr: readonly T[], by: (item: T) => K): Record<K, T[]>`
Groups elements into arrays keyed by the key function. Rails/lodash `group_by`.
```ts
groupBy([{ name: 'alice', role: 'admin' }, { name: 'bob', role: 'user' }, { name: 'carol', role: 'admin' }], u => u.role)
// → { admin: [{...alice}, {...carol}], user: [{...bob}] }
```

### `indexBy<T, K extends PropertyKey>(arr: readonly T[], by: (item: T) => K): Record<K, T>`
Like `groupBy` but keeps only the last item per key. Rails `index_by`.
```ts
indexBy([{ name: 'alice', role: 'admin' }, { name: 'carol', role: 'admin' }], u => u.role)
// → { admin: { name: 'carol', role: 'admin' } }
```

### `countBy<T, K extends PropertyKey>(arr: readonly T[], by: (item: T) => K): Record<K, number>`
Counts elements per key. Rails `count_by` / lodash `_.countBy`.
```ts
countBy([{ role: 'admin' }, { role: 'user' }, { role: 'admin' }], u => u.role)   // → { admin: 2, user: 1 }
```

### `tally<T>(arr: readonly T[]): Map<T, number>`
Counts occurrences of each value into a `Map`. Ruby `tally`.
```ts
tally(['a', 'b', 'a'])   // → Map { 'a' => 2, 'b' => 1 }
```

### `partition<T>(arr: readonly T[], fn: (item: T) => boolean): [T[], T[]]`
Splits into `[matching, notMatching]`. Ruby `partition`.
```ts
partition([1, 2, 3, 4], n => n % 2 === 0)   // → [[2, 4], [1, 3]]
```

### `sum<T>(arr: readonly T[], fn?: (item: T) => number): number`
Sums the numbers, or the result of `fn` per element; empty array → `0`. Ruby `sum`.
```ts
sum([1, 2, 3])          // → 6
sum(users, () => 2)     // → 6   (3 users × 2)
sum([])                 // → 0
```

### `minBy<T>(arr: readonly T[], fn: (item: T) => number | string): T | undefined`
Element with the smallest key; `undefined` for an empty array. Ruby `min_by`.
```ts
minBy([{ v: 3 }, { v: 1 }, { v: 2 }], i => i.v)   // → { v: 1 }
minBy([], () => 0)                                // → undefined
```

### `maxBy<T>(arr: readonly T[], fn: (item: T) => number | string): T | undefined`
Element with the largest key; `undefined` for an empty array. Ruby `max_by`.
```ts
maxBy([{ v: 3 }, { v: 1 }, { v: 2 }], i => i.v)   // → { v: 3 }
```

### `sortBy<T>(arr: readonly T[], fn: (item: T) => number | string): T[]`
Stable ascending sort by a key function; does not mutate the input. Ruby `sort_by`.
```ts
sortBy([{ v: 3 }, { v: 1 }, { v: 2 }], i => i.v)   // → [{ v: 1 }, { v: 2 }, { v: 3 }]
sortBy([{ k: 1, tag: 'a' }, { k: 1, tag: 'b' }, { k: 0, tag: 'c' }], i => i.k)
// → [{ k: 0, tag: 'c' }, { k: 1, tag: 'a' }, { k: 1, tag: 'b' }]  (stable)
```

## Slicing & chunking

### `from<T>(arr: readonly T[], index: number): T[]`
Elements from `index` onward (`[]` when past the end). Rails `Array#from`.
```ts
from([1, 2, 3, 4], 2)   // → [3, 4]
```

### `to<T>(arr: readonly T[], index: number): T[]`
Elements up to and including `index` (negative index → `[]`). Rails `Array#to`.
```ts
to([1, 2, 3, 4], 2)    // → [1, 2, 3]
to([1, 2, 3], -1)      // → []
```

### `eachSlice<T>(arr: readonly T[], size: number): T[][]`
Chunks into consecutive groups of `size` (last group may be shorter); throws when `size < 1`. Ruby `each_slice`.
```ts
eachSlice([1, 2, 3, 4, 5], 2)   // → [[1, 2], [3, 4], [5]]
eachSlice([1], 0)               // → throws Error
```

### `eachCons<T>(arr: readonly T[], size: number): T[][]`
Sliding window of `size` consecutive elements; throws when `size < 1`. Ruby `each_cons`.
```ts
eachCons([1, 2, 3, 4], 2)   // → [[1, 2], [2, 3], [3, 4]]
eachCons([1], 2)            // → []
```

### `inGroupsOf<T, F = null>(arr: readonly T[], size: number, fill: F = null): (T | F)[][]`
Like `eachSlice` but pads the last group to `size` with `fill`. Rails `in_groups_of`.
```ts
inGroupsOf([1, 2, 3], 2)      // → [[1, 2], [3, null]]
inGroupsOf([1, 2, 3], 2, 0)   // → [[1, 2], [3, 0]]
inGroupsOf([1, 2], 2)         // → [[1, 2]]
```

### `inGroups<T, F = null>(arr: readonly T[], count: number, fill: F = null, padded = true): (T | F)[][]`
Splits into `count` groups of near-equal size, padding short groups with `fill` (disable via `padded = false`); throws when `count < 1`. Rails `in_groups`.
```ts
inGroups([1, 2, 3, 4, 5, 6, 7], 3)   // → [[1, 2, 3], [4, 5, null], [6, 7, null]]
```

### `takeWhile<T>(arr: readonly T[], fn: (item: T) => boolean): T[]`
Leading elements while the predicate holds, then stops. Ruby `take_while`.
```ts
takeWhile([1, 2, 3, 4, 1], n => n < 3)   // → [1, 2]
```

### `dropWhile<T>(arr: readonly T[], fn: (item: T) => boolean): T[]`
Drops leading elements while the predicate holds, returns the rest. Ruby `drop_while`.
```ts
dropWhile([1, 2, 3, 4, 1], n => n < 3)   // → [3, 4, 1]
```

### `chunkWhile<T>(arr: readonly T[], fn: (a: T, b: T) => boolean): T[][]`
Groups consecutive elements while the predicate holds between neighbors. Ruby `chunk_while`.
```ts
chunkWhile([1, 2, 4, 5, 7], (a, b) => b - a === 1)   // → [[1, 2], [4, 5], [7]]
```

### `sliceWhen<T>(arr: readonly T[], fn: (a: T, b: T) => boolean): T[][]`
Inverse of `chunkWhile`: starts a new group when the predicate holds between neighbors. Ruby `slice_when`.
```ts
sliceWhen([1, 2, 4, 5, 7], (a, b) => b - a > 1)   // → [[1, 2], [4, 5], [7]]
```

## Iteration

### `eachWithObject<T, O>(arr: readonly T[], obj: O, fn: (item: T, obj: O) => void): O`
Folds elements into a mutable accumulator, returning it. Ruby `each_with_object`.
```ts
eachWithObject([1, 2, 3], [] as number[], (n, acc) => acc.push(n * 2))   // → [2, 4, 6]
```

## Random

### `sample<T>(arr: readonly T[], n?: number)`
A random element, or `n` random elements (drawn without replacement) when `n` is given. Ruby `sample`.
```ts
sample([1, 2, 3])      // → 2   (random; one of 1, 2, 3)
sample([1, 2, 3], 2)   // → [3, 1]   (random; 2 distinct elements)
sample([])             // → undefined
```

### `shuffle<T>(arr: readonly T[]): T[]`
Returns a Fisher–Yates–shuffled copy without mutating the input. Ruby `shuffle` / lodash `_.shuffle`.
```ts
shuffle([1, 2, 3, 4, 5])   // → [3, 1, 5, 2, 4]   (random permutation)
```

## Formatting

### `toSentence(arr: readonly unknown[], opts?: { wordsConnector?: string; twoWordsConnector?: string; lastWordConnector?: string }): string`
Joins elements into a human-readable sentence with configurable connectors. Rails `to_sentence`.
```ts
toSentence([])                                          // → ''
toSentence(['a'])                                       // → 'a'
toSentence(['a', 'b'])                                  // → 'a and b'
toSentence(['a', 'b', 'c'])                             // → 'a, b, and c'
toSentence(['a', 'b', 'c'], { lastWordConnector: ' or ' })   // → 'a, b or c'
```
