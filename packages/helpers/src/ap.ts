/**
 * `ap()` — an awesome_print-style pretty printer.
 *
 * Faithful to the Ruby gem's *output style* (indexed arrays, aligned hash
 * keys, per-type colors) without the advanced nuance (no method listing,
 * no HTML mode, no custom formatters).
 *
 *   ap([1, 'two', { three: 3 }])
 *   [
 *       [0] 1,
 *       [1] "two",
 *       [2] {
 *           three: 3
 *       }
 *   ]
 */

const ANSI = {
  reset: '\x1b[0m',
  // awesome_print default color scheme
  string: '\x1b[33m',    // yellow
  number: '\x1b[34m',    // blue
  boolean: '\x1b[36m',   // cyan (trueish/falseish share it here)
  nil: '\x1b[31m',       // red
  date: '\x1b[32m',      // greenish
  symbolKey: '\x1b[36m', // cyan for keys
  index: '\x1b[90m',     // dim gray for [0] indices
  klass: '\x1b[33m',     // class names
} as const

export interface ApOptions {
  /** Indent width in spaces (awesome_print default is 4). */
  indent?: number
  /** Force colors on/off. Defaults to auto-detect (TTY). */
  colors?: boolean
  /** Max depth before printing '...'. */
  depth?: number
  /** Sort object keys alphabetically. */
  sortKeys?: boolean
  /** Print to this function instead of console.log (used by tests). */
  out?: (text: string) => void
}

/**
 * Pretty-prints any value, awesome_print style, and returns the value
 * (like Ruby's `ap`) so it can be dropped into pipelines transparently.
 */
export function ap<T>(value: T, options: ApOptions = {}): T {
  const text = apFormat(value, options)
  ;(options.out ?? console.log)(text)
  return value
}

/** Formats without printing — the pure core of ap(). */
export function apFormat(value: unknown, options: ApOptions = {}): string {
  const indent = options.indent ?? 4
  const colors = options.colors ?? detectColors()
  const depth = options.depth ?? 10
  const sortKeys = options.sortKeys ?? false
  return render(value, { indent, colors, depth, sortKeys, level: 0, seen: new Set() })
}

interface Ctx {
  indent: number
  colors: boolean
  depth: number
  sortKeys: boolean
  level: number
  seen: Set<unknown>
}

function detectColors(): boolean {
  try {
    return Boolean(typeof process !== 'undefined' && process.stdout && process.stdout.isTTY)
  } catch {
    return false
  }
}

function paint(text: string, color: keyof typeof ANSI, ctx: Ctx): string {
  if (!ctx.colors) return text
  return ANSI[color] + text + ANSI.reset
}

function pad(ctx: Ctx, extra = 0): string {
  return ' '.repeat(ctx.indent * (ctx.level + extra))
}

function render(value: unknown, ctx: Ctx): string {
  // Scalars
  if (value === null) return paint('nil', 'nil', ctx)
  if (value === undefined) return paint('undefined', 'nil', ctx)

  switch (typeof value) {
    case 'string': return paint(JSON.stringify(value), 'string', ctx)
    case 'number': return paint(String(value), 'number', ctx)
    case 'bigint': return paint(`${value}n`, 'number', ctx)
    case 'boolean': return paint(String(value), 'boolean', ctx)
    case 'symbol': return paint(String(value), 'symbolKey', ctx)
    case 'function': {
      const name = (value as Function).name || 'anonymous'
      return paint(`[Function: ${name}]`, 'klass', ctx)
    }
  }

  if (value instanceof Date) {
    return paint(isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(), 'date', ctx)
  }
  if (value instanceof RegExp) return paint(String(value), 'string', ctx)
  if (value instanceof Error) {
    return paint(`${value.name}: ${value.message}`, 'nil', ctx)
  }

  // Depth / cycle guards
  if (ctx.level >= ctx.depth) return '...'
  if (ctx.seen.has(value)) return paint('[Circular]', 'nil', ctx)

  if (Array.isArray(value)) return renderArray(value, ctx)
  if (value instanceof Map) return renderMap(value, ctx)
  if (value instanceof Set) return renderArray([...value], ctx, 'Set ')

  return renderObject(value as Record<string, unknown>, ctx)
}

function renderArray(arr: unknown[], ctx: Ctx, prefix = ''): string {
  if (arr.length === 0) return `${prefix}[]`

  ctx.seen.add(arr)
  const inner: Ctx = { ...ctx, level: ctx.level + 1 }
  const width = String(arr.length - 1).length

  const lines = arr.map((item, i) => {
    const idx = paint(`[${String(i).padStart(width)}]`, 'index', ctx)
    return `${pad(inner)}${idx} ${render(item, inner)}`
  })
  ctx.seen.delete(arr)

  return `${prefix}[\n${lines.join(',\n')}\n${pad(ctx)}]`
}

function renderObject(obj: Record<string, unknown>, ctx: Ctx): string {
  // `static name = Attr…` on a model class shadows .name with a non-string
  const className = obj.constructor && obj.constructor !== Object && typeof obj.constructor.name === 'string' ? obj.constructor.name : ''
  let keys = Object.keys(obj)
  if (ctx.sortKeys) keys = keys.sort()

  const prefix = className ? paint(`#<${className}> `, 'klass', ctx) : ''
  if (keys.length === 0) return `${prefix}{}`

  ctx.seen.add(obj)
  const inner: Ctx = { ...ctx, level: ctx.level + 1 }
  const maxKeyLen = Math.max(...keys.map(k => k.length))

  const lines = keys.map(k => {
    const paddedKey = k.padStart(maxKeyLen)
    const keyText = paint(paddedKey, 'symbolKey', ctx)
    return `${pad(inner)}${keyText}: ${render(obj[k], inner)}`
  })
  ctx.seen.delete(obj)

  return `${prefix}{\n${lines.join(',\n')}\n${pad(ctx)}}`
}

function renderMap(map: Map<unknown, unknown>, ctx: Ctx): string {
  if (map.size === 0) return 'Map {}'

  ctx.seen.add(map)
  const inner: Ctx = { ...ctx, level: ctx.level + 1 }
  const entries = [...map.entries()]
  const keyStrs = entries.map(([k]) => (typeof k === 'string' ? k : String(k)))
  const maxKeyLen = Math.max(...keyStrs.map(s => s.length))

  const lines = entries.map(([, v], i) => {
    const keyText = paint(keyStrs[i]!.padStart(maxKeyLen), 'symbolKey', ctx)
    return `${pad(inner)}${keyText} => ${render(v, inner)}`
  })
  ctx.seen.delete(map)

  return `Map {\n${lines.join(',\n')}\n${pad(ctx)}}`
}
