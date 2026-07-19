# String Helpers

Rails ActiveSupport-style helpers for inflecting, casing, trimming, and inspecting strings.

## Inflection

### `pluralize(str: string, count?: number): string`
Pluralizes a word; when `count` is given, returns singular/plural to match it. Mirrors Rails `String#pluralize`.
```ts
pluralize('user')        // → 'users'
pluralize('person')      // → 'people'
pluralize('octopus')     // → 'octopuses'
pluralize('user', 1)     // → 'user'
pluralize('user', 2)     // → 'users'
```

### `singularize(str: string): string`
Returns the singular form of a word. Mirrors Rails `String#singularize`.
```ts
singularize('users')     // → 'user'
singularize('people')    // → 'person'
```

### `camelize(str: string, upperFirst?: boolean): string`
Converts snake/kebab/space-separated words to camelCase (or PascalCase when `upperFirst`). Mirrors Rails `String#camelize`.
```ts
camelize('user_profile')        // → 'userProfile'
camelize('user-profile')        // → 'userProfile'
camelize('user profile')        // → 'userProfile'
camelize('user_profile', true)  // → 'UserProfile'
```

### `underscore(str: string): string`
Converts camelCase/PascalCase to snake_case. Mirrors Rails `String#underscore`.
```ts
underscore('userProfile')  // → 'user_profile'
underscore('UserProfile')  // → 'user_profile'
underscore('HTMLParser')   // → 'html_parser'
```

### `dasherize(str: string): string`
Converts to kebab-case (snake_case with dashes). Mirrors Rails `String#dasherize`.
```ts
dasherize('userProfile')   // → 'user-profile'
dasherize('user_profile')  // → 'user-profile'
```

### `humanize(str: string): string`
Turns a symbol/attribute name into a human-readable sentence, dropping a trailing `_id`. Mirrors Rails `String#humanize`.
```ts
humanize('employee_salary')  // → 'Employee salary'
humanize('author_id')        // → 'Author'
```

### `titleize(str: string): string`
Capitalizes every word for a title. Mirrors Rails `String#titleize`.
```ts
titleize('man of steel')    // → 'Man Of Steel'
titleize('x_men_origins')   // → 'X Men Origins'
```

### `classify(str: string): string`
Converts a table name to its singular PascalCase class name. Mirrors Rails `String#classify`.
```ts
classify('user_profiles')  // → 'UserProfile'
```

### `tableize(str: string): string`
Converts a class name to its plural snake_case table name. Mirrors Rails `String#tableize`.
```ts
tableize('UserProfile')  // → 'user_profiles'
```

### `parameterize(str: string, separator?: string): string`
Produces a URL-safe slug, stripping accents and non-alphanumerics. Mirrors Rails `String#parameterize`.
```ts
parameterize('Donald E. Knuth')  // → 'donald-e-knuth'
parameterize('Café au Lait!')    // → 'cafe-au-lait'
parameterize('a b', '_')         // → 'a_b'
```

### `foreignKey(str: string): string`
Builds the foreign-key column name for a class. Mirrors Rails `String#foreign_key`.
```ts
foreignKey('UserProfile')  // → 'user_profile_id'
foreignKey('users')        // → 'user_id'
```

## Case

### `capitalize(str: string): string`
Uppercases only the first character, leaving the rest untouched. Mirrors Ruby `String#capitalize`.
```ts
capitalize('hello world')  // → 'Hello world'
```

### `swapcase(str: string): string`
Swaps the case of every letter. Mirrors Ruby `String#swapcase`.
```ts
swapcase('Hello World')  // → 'hELLO wORLD'
```

## Trimming & truncation

### `truncate(str: string, length: number, opts?: { omission?: string; separator?: string }): string`
Truncates to `length` characters (including the omission), optionally breaking on a separator. Mirrors Rails `String#truncate`.
```ts
truncate('Once upon a time in a world far far away', 27)  // → 'Once upon a time in a wo...'
truncate('short', 27)                                     // → 'short'
truncate('Once upon a time', 12, { separator: ' ' })      // → 'Once upon...'
truncate('abc', 5, { omission: '…' })                     // → 'abc'
```

### `truncateWords(str: string, count: number, omission?: string): string`
Truncates to a maximum number of words. Mirrors Rails `String#truncate_words`.
```ts
truncateWords('Once upon a time in a world', 4)  // → 'Once upon a time...'
truncateWords('one two', 5)                      // → 'one two'
```

### `squish(str: string): string`
Collapses all whitespace runs to single spaces and trims the ends. Mirrors Rails `String#squish`.
```ts
squish('  foo   bar  \n  baz ')  // → 'foo bar baz'
```

### `stripHeredoc(str: string): string`
Removes the indentation common to all lines. Mirrors Rails `String#strip_heredoc` (Ruby squiggly heredoc).
```ts
stripHeredoc('    line one\n      line two\n    line three')
// → 'line one\n  line two\nline three'
```

### `indent(str: string, amount: number, indentString?: string): string`
Indents every non-empty line by `amount` copies of `indentString`. Mirrors Rails `String#indent`.
```ts
indent('a\nb', 2)         // → '  a\n  b'
indent('a\n\nb', 2)       // → '  a\n\n  b'  (empty lines untouched)
indent('x', 2, '\t')      // → '\t\tx'
```

### `deletePrefix(str: string, prefix: string): string`
Removes a leading substring if present. Mirrors Ruby `String#delete_prefix`.
```ts
deletePrefix('unhappy', 'un')  // → 'happy'
deletePrefix('happy', 'un')    // → 'happy'
```

### `deleteSuffix(str: string, suffix: string): string`
Removes a trailing substring if present. Mirrors Ruby `String#delete_suffix`.
```ts
deleteSuffix('running', 'ning')  // → 'run'
deleteSuffix('run', 'ning')      // → 'run'
```

### `remove(str: string, ...patterns: (string | RegExp)[]): string`
Deletes all occurrences of each string/regex pattern. Mirrors Rails `String#remove`.
```ts
remove('Hello World', 'o')       // → 'Hell Wrld'
remove('Hello World', /l/)       // → 'Heo Word'
```

### `firstChars(str: string, n?: number): string`
Returns the first `n` characters (whole string if `n` exceeds length). Mirrors Rails `String#first`.
```ts
firstChars('hello')     // → 'h'
firstChars('hello', 2)  // → 'he'
```

### `lastChars(str: string, n?: number): string`
Returns the last `n` characters. Mirrors Rails `String#last`.
```ts
lastChars('hello')     // → 'o'
lastChars('hello', 2)  // → 'lo'
```

### `fromIndex(str: string, index: number): string`
Returns the substring from `index` to the end. Mirrors Rails `String#from`.
```ts
fromIndex('hello', 2)  // → 'llo'
```

### `toIndex(str: string, index: number): string`
Returns the substring up to and including `index` (negative counts from the end). Mirrors Rails `String#to`.
```ts
toIndex('hello', 2)    // → 'hel'
toIndex('hello', -2)   // → 'hell'
```

### `center(str: string, width: number, padstr?: string): string`
Centers the string within `width`, padding both sides with `padstr`. Mirrors Ruby `String#center`.
```ts
center('foo', 7)        // → '  foo  '
center('foo', 7, '*')   // → '**foo**'
```

## Predicates & misc

### `isBlankString(str: string | null | undefined): boolean`
True when the value is null/undefined or only whitespace. Mirrors Rails `blank?`.
```ts
isBlankString('')      // → true
isBlankString('   ')   // → true
isBlankString(null)    // → true
isBlankString('x')     // → false
```

### `isPresentString(str: string | null | undefined): boolean`
The inverse of `isBlankString`. Mirrors Rails `present?`.
```ts
isPresentString('x')   // → true
isPresentString('  ')  // → false
```

### `stringPresence(str: string | null | undefined): string | undefined`
Returns the string when present, otherwise `undefined`. Mirrors Rails `presence`.
```ts
stringPresence('hi')   // → 'hi'
stringPresence('  ')   // → undefined
```

### `toBoolean(str: string | null | undefined): boolean`
Parses truthy strings (`1`, `t`, `true`, `y`, `yes`, `on`, case-insensitive); everything else is false.
```ts
toBoolean('yes')     // → true
toBoolean('TRUE')    // → true
toBoolean('banana')  // → false
toBoolean(null)      // → false
```
