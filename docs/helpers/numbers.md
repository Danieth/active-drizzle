# Number Helpers

Rails ActiveSupport-style helpers for formatting, ordinalizing, and computing with numbers, durations, and byte sizes.

## Formatting

### `numberWithDelimiter(n: number, delimiter?: string, separator?: string): string`
Groups digits with a thousands delimiter. Mirrors Rails `number_with_delimiter`.
```ts
numberWithDelimiter(1234567)          // → '1,234,567'
numberWithDelimiter(1234567.891)      // → '1,234,567.891'
numberWithDelimiter(123)              // → '123'
numberWithDelimiter(1234, '.', ',')   // → '1.234'
```

### `numberToCurrency(n: number, opts?: { unit?: string; precision?: number; delimiter?: string; separator?: string }): string`
Formats a number as currency. Mirrors Rails `number_to_currency` (simplified).
```ts
numberToCurrency(1234.5)                        // → '$1,234.50'
numberToCurrency(-99)                           // → '-$99.00'
numberToCurrency(1000, { unit: '€', precision: 0 })  // → '€1,000'
```

### `numberToPercentage(n: number, precision?: number): string`
Formats a 0–100 value as a percentage, trimming trailing zeros. Mirrors Rails `number_to_percentage`.
```ts
numberToPercentage(65.3)      // → '65.3%'
numberToPercentage(100, 0)    // → '100%'
numberToPercentage(0)         // → '0%'
```

### `numberToHumanSize(bytes: number, precision?: number): string`
Formats a byte count as a human-readable size. Mirrors Rails `number_to_human_size`.
```ts
numberToHumanSize(0)          // → '0 bytes'
numberToHumanSize(1)          // → '1 byte'
numberToHumanSize(500)        // → '500 bytes'
numberToHumanSize(1024)       // → '1 KB'
numberToHumanSize(1234567)    // → '1.2 MB'
numberToHumanSize(1073741824) // → '1 GB'
```

### `numberToHuman(n: number, precision?: number): string`
Formats a large number with a word scale (Thousand, Million, …). Mirrors Rails `number_to_human` (simplified).
```ts
numberToHuman(1234567)        // → '1.2 Million'
numberToHuman(1000)           // → '1 Thousand'
numberToHuman(999)            // → '999'
numberToHuman(2_500_000_000)  // → '2.5 Billion'
```

## Ordinals

### `ordinal(n: number): string`
Returns the ordinal suffix for a number, handling teens. Mirrors Rails `Integer#ordinal`.
```ts
ordinal(1)    // → 'st'
ordinal(2)    // → 'nd'
ordinal(3)    // → 'rd'
ordinal(11)   // → 'th'
ordinal(21)   // → 'st'
ordinal(-1)   // → 'st'
```

### `ordinalize(n: number): string`
Returns the number with its ordinal suffix appended. Mirrors Rails `Integer#ordinalize`.
```ts
ordinalize(1)    // → '1st'
ordinalize(22)   // → '22nd'
ordinalize(103)  // → '103rd'
```

## Math & predicates

### `clamp(n: number, min: number, max: number): number`
Constrains a number to the inclusive `[min, max]` range.
```ts
clamp(5, 0, 10)   // → 5
clamp(-5, 0, 10)  // → 0
clamp(15, 0, 10)  // → 10
```

### `isMultipleOf(n: number, divisor: number): boolean`
True when `n` is an exact multiple of `divisor`. Mirrors Rails `Integer#multiple_of?`.
```ts
isMultipleOf(9, 3)   // → true
isMultipleOf(10, 3)  // → false
isMultipleOf(0, 0)   // → true
isMultipleOf(5, 0)   // → false
```

### `isEven(n: number): boolean`
True when `n` is even. Mirrors Ruby `Integer#even?`.
```ts
isEven(4)  // → true
```

### `isOdd(n: number): boolean`
True when `n` is odd (works for negatives). Mirrors Ruby `Integer#odd?`.
```ts
isOdd(3)   // → true
isOdd(-3)  // → true
```

### `roundTo(n: number, digits?: number): number`
Rounds to a given number of decimal digits. Mirrors Ruby `Float#round(n)`.
```ts
roundTo(3.14159, 2)  // → 3.14
roundTo(2.5)         // → 3
```

### `percentOf(part: number, whole: number): number`
Returns `part` as a percentage of `whole` (0 when `whole` is 0). ActiveSupport-inspired convenience.
```ts
percentOf(25, 200)  // → 12.5
```

## Durations (milliseconds)

Each returns a millisecond count — perfect for `setTimeout`, `Date` math, and cache TTLs. Mirrors Rails `n.minutes` etc.

### `seconds(n)` · `minutes(n)` · `hours(n)` · `days(n)` · `weeks(n)`
```ts
seconds(2)  // → 2000
minutes(2)  // → 120000
hours(1)    // → 3600000
days(1)     // → 86400000
weeks(1)    // → 604800000
```

### `fromNow(ms: number): Date` · `ago(ms: number): Date`
A `Date` that many milliseconds in the future / past. Mirrors Rails `n.from_now` / `n.ago`.
```ts
fromNow(minutes(5))  // → Date 5 minutes ahead
ago(hours(2))        // → Date 2 hours earlier
```

## Byte sizes

Each returns a byte count. Mirrors Rails `n.megabytes` etc.

### `kilobytes(n)` · `megabytes(n)` · `gigabytes(n)` · `terabytes(n)`
```ts
kilobytes(1)  // → 1024
megabytes(2)  // → 2097152
gigabytes(1)  // → 1073741824
terabytes(1)  // → 1099511627776
```
