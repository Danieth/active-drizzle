# Object Helpers

Rails ActiveSupport-style object/hash helpers as **pure functions** (no `Object.prototype` extension) — presence checks, immutable slicing, key transforms, and deep operations.

## Presence (blank / present)

### `isBlank(value: unknown): boolean`
Rails' `blank?` for any value: `null`/`undefined`, `''`, whitespace-only strings, `[]`, `{}`, empty `Map`/`Set`, `NaN`, and `false` are blank; `0` and `Date` are present.
```ts
isBlank(null)   // → true
isBlank('   ')  // → true
isBlank([])     // → true
isBlank(false)  // → true
isBlank(NaN)    // → true
isBlank(0)      // → false (0 is present, like Rails)
```

### `isPresent(value: unknown): boolean`
Negation of `isBlank`. Rails' `present?`.
```ts
isPresent(0)   // → true
isPresent('')  // → false
```

### `presence<T>(value: T): NonNullable<T> | undefined`
Returns the value when present, otherwise `undefined`. Rails' `presence`.
```ts
presence('hi')  // → 'hi'
presence(0)     // → 0
presence('')    // → undefined
presence([])    // → undefined
```

## Slicing

### `slice<T, K extends keyof T>(obj: T, ...keys: K[]): Pick<T, K>`
New object with only the given keys (skips keys not in `obj`). Rails' `slice`.
```ts
slice({ a: 1, b: 2, c: 3 }, 'a', 'b')   // → { a: 1, b: 2 }
```

### `except<T, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K>`
New object with the given keys removed. Rails' `except`.
```ts
except({ a: 1, b: 2, c: 3 }, 'b')   // → { a: 1, c: 3 }
```

### `compactObject<T>(obj: T): Partial<T>`
New object with `null`/`undefined` values removed (keeps `''`, `0`, `false`). Rails' `compact`.
```ts
compactObject({ a: 1, b: 2, c: null, d: undefined, e: '' })  // → { a: 1, b: 2, e: '' }
```

### `compactBlank<T>(obj: T): Partial<T>`
New object with all blank values removed (per `isBlank`). Rails' `compact_blank`.
```ts
compactBlank({ a: 1, b: 2, c: null, d: undefined, e: '' })   // → { a: 1, b: 2 }
```

## Key transforms

### `transformKeys<T>(obj: Record<string, T>, fn: (key: string) => string): Record<string, T>`
New object with each key rewritten by `fn` (values untouched). Rails' `transform_keys`.
```ts
transformKeys({ a: 1 }, k => k.toUpperCase())   // → { A: 1 }
```

### `deepTransformKeys(value: unknown, fn: (key: string) => string): unknown`
Recursively rewrites keys through nested plain objects and arrays; leaves non-plain objects (e.g. `Date`) untouched. Rails' `deep_transform_keys`.
```ts
deepTransformKeys({ a_b: { c_d: 1 } }, k => k.toUpperCase())  // → { A_B: { C_D: 1 } }
```

### `camelizeKeys<T>(obj)` · `underscoreKeys<T>(obj)`
Shallow-camelize / shallow-underscore all keys.
```ts
camelizeKeys({ user_name: 'x', created_at: 'y' })  // → { userName: 'x', createdAt: 'y' }
underscoreKeys({ userName: 'x' })                  // → { user_name: 'x' }
```

### `deepCamelizeKeys(value)` · `deepUnderscoreKeys(value)`
Recursively camelize / underscore keys through nested objects and arrays (leaves `Date` etc. alone).
```ts
deepCamelizeKeys({ user_info: { first_name: 'a', tags_list: [{ tag_id: 1 }] } })
// → { userInfo: { firstName: 'a', tagsList: [{ tagId: 1 }] } }
```

## Deep ops

### `deepMerge<T>(target: T, source: Record<string, any>): T`
Recursive merge — nested plain objects merge, arrays and scalars overwrite. Immutable. Rails' `deep_merge`.
```ts
deepMerge({ a: 1, nested: { x: 1, y: 2 } }, { b: 2, nested: { y: 3, z: 4 } })
// → { a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } }
deepMerge({ a: [1, 2] }, { a: [3] })   // → { a: [3] } (arrays overwrite)
```

### `dig(obj: unknown, ...keys: (string | number)[]): unknown`
Safe nested access through objects and arrays; returns `undefined` on any missing/null link. Ruby's `dig`.
```ts
const obj = { a: { b: [{ c: 42 }] } }
dig(obj, 'a', 'b', 0, 'c')   // → 42
dig(obj, 'a', 'nope', 0)     // → undefined
```
