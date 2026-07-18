import pluralizeLib from 'pluralize'

/**
 * Rails ActiveSupport-style string helpers (inflections + formatting).
 */

// ── Inflections ──────────────────────────────────────────────────────────────

export function pluralize(str: string, count?: number): string {
  if (count !== undefined) return pluralizeLib(str, count)
  return pluralizeLib.plural(str)
}

export function singularize(str: string): string {
  return pluralizeLib.singular(str)
}

/** 'user_profile' / 'user-profile' / 'user profile' → 'userProfile' */
export function camelize(str: string, upperFirst = false): string {
  const camel = str.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
  if (upperFirst) return camel.charAt(0).toUpperCase() + camel.slice(1)
  return camel.charAt(0).toLowerCase() + camel.slice(1)
}

/** 'userProfile' / 'UserProfile' → 'user_profile' */
export function underscore(str: string): string {
  return str
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** 'userProfile' / 'user_profile' → 'user-profile' */
export function dasherize(str: string): string {
  return underscore(str).replace(/_/g, '-')
}

/** 'user_profile' / 'userProfile' → 'User profile'. Rails' `humanize`. */
export function humanize(str: string): string {
  const words = underscore(str).replace(/_id$/, '').replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** 'man of steel' → 'Man Of Steel'. Rails' `titleize`. */
export function titleize(str: string): string {
  return underscore(str)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/** 'user_profiles' → 'UserProfile' (singular PascalCase). Rails' `classify`. */
export function classify(str: string): string {
  return camelize(singularize(str), true)
}

/** 'UserProfile' → 'user_profiles' (plural snake_case). Rails' `tableize`. */
export function tableize(str: string): string {
  return pluralize(underscore(str))
}

/** 'Donald E. Knuth' → 'donald-e-knuth'. Rails' `parameterize`. */
export function parameterize(str: string, separator = '-'): string {
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '')
}

/** 'foreign_key' helper: 'UserProfile' → 'user_profile_id' */
export function foreignKey(str: string): string {
  return underscore(singularize(str)) + '_id'
}

/** Uppercases the first character only. Ruby's `capitalize` (rest untouched). */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/** Removes a leading/trailing substring if present. Ruby's `delete_prefix`/`delete_suffix`. */
export function deletePrefix(str: string, prefix: string): string {
  return str.startsWith(prefix) ? str.slice(prefix.length) : str
}

export function deleteSuffix(str: string, suffix: string): string {
  return suffix.length > 0 && str.endsWith(suffix) ? str.slice(0, -suffix.length) : str
}

// ── Rails String extensions ──────────────────────────────────────────────────

/** Rails' `String#remove` — deletes all occurrences of the pattern(s). */
export function remove(str: string, ...patterns: (string | RegExp)[]): string {
  let out = str
  for (const p of patterns) {
    if (typeof p === 'string') out = out.split(p).join('')
    else out = out.replace(p.global ? p : new RegExp(p.source, p.flags + 'g'), '')
  }
  return out
}

/** Rails' `String#first(n)` — first n characters (whole string if n > length). */
export function firstChars(str: string, n = 1): string {
  return n <= 0 ? '' : str.slice(0, n)
}

/** Rails' `String#last(n)` — last n characters. */
export function lastChars(str: string, n = 1): string {
  return n <= 0 ? '' : str.slice(-n)
}

/** Rails' `String#from` — substring from index onward. */
export function fromIndex(str: string, index: number): string {
  return str.slice(index)
}

/** Rails' `String#to` — substring up to and including index. */
export function toIndex(str: string, index: number): string {
  return index < 0 ? str.slice(0, str.length + index + 1) : str.slice(0, index + 1)
}

/** Ruby's `swapcase`. */
export function swapcase(str: string): string {
  return str.replace(/[a-zA-Z]/g, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
}

/** Rails' `String#at` exists natively (`str.at`). Ruby `center/ljust/rjust`: */
export function center(str: string, width: number, padstr = ' '): string {
  if (str.length >= width) return str
  const total = width - str.length
  const left = Math.floor(total / 2)
  const right = total - left
  return padstr.repeat(Math.ceil(left / padstr.length)).slice(0, left) +
    str +
    padstr.repeat(Math.ceil(right / padstr.length)).slice(0, right)
}

// ── Presence ─────────────────────────────────────────────────────────────────

export function isBlankString(str: string | null | undefined): boolean {
  return str == null || str.trim().length === 0
}

export function isPresentString(str: string | null | undefined): boolean {
  return !isBlankString(str)
}

/** Returns the string when present, otherwise undefined. Rails' `presence`. */
export function stringPresence(str: string | null | undefined): string | undefined {
  return isBlankString(str) ? undefined : (str as string)
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Truncates to `length` chars including the omission. Rails' `truncate`. */
export function truncate(
  str: string,
  length: number,
  opts: { omission?: string; separator?: string } = {}
): string {
  const { omission = '...', separator } = opts
  if (str.length <= length) return str
  let stop = length - omission.length
  if (stop < 0) stop = 0
  let cut = str.slice(0, stop)
  if (separator) {
    // Rails semantics: rindex(separator, stop) — last separator at or before stop
    const idx = str.lastIndexOf(separator, stop)
    if (idx > 0) cut = str.slice(0, idx)
  }
  return cut + omission
}

/** Truncates to a number of words. Rails' `truncate_words`. */
export function truncateWords(str: string, count: number, omission = '...'): string {
  const words = str.split(/\s+/)
  if (words.length <= count) return str
  return words.slice(0, count).join(' ') + omission
}

/** Removes indentation common to all lines. Rails' `strip_heredoc` / Ruby squiggly heredoc. */
export function stripHeredoc(str: string): string {
  const lines = str.split('\n')
  const indents = lines
    .filter(l => l.trim().length > 0)
    .map(l => l.match(/^[ \t]*/)![0].length)
  const min = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map(l => l.slice(min)).join('\n')
}

/** Collapses whitespace runs into single spaces and trims. Rails' `squish`. */
export function squish(str: string): string {
  return str.replace(/\s+/g, ' ').trim()
}

/** '1'/'true'/'yes'/'on' → true (case-insensitive); everything else false. */
export function toBoolean(str: string | null | undefined): boolean {
  if (str == null) return false
  return /^(1|t|true|y|yes|on)$/i.test(str.trim())
}

/** Indents every line by `amount` spaces (or the given indentString). Rails' `indent`. */
export function indent(str: string, amount: number, indentString = ' '): string {
  const pad = indentString.repeat(amount)
  return str.replace(/^(?!$)/gm, pad)
}

/** 'a'.ordinalize-style helper lives in number.ts (ordinalize). */
