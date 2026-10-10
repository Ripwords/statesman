import type { JsonValue } from '../../shared/schemas/variable'

const INDENT = '  '

const unicode = (ch: string) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')

/** HCL wants a fraction before an exponent, so `1e-7` goes out as `1.0e-7`. */
const number = (n: number) => String(n).replace(/^(-?\d+)e/, '$1.0e')

/** True when `value[i]` is followed by more of itself and then a `{`. */
function runEndsInBrace(value: string, i: number): boolean {
  let j = i + 1
  while (value[j] === value[i]) j++
  return j > i + 1 && value[j] === '{'
}

/**
 * A quoted HCL string that means exactly `value`. HCL has no `\b` or `\f`, so
 * every control character goes out as `\uNNNN`; and `${` / `%{` are doubled so
 * a stored value can never become an interpolation or a directive. In a run
 * like `$${`, every marker but the last goes out as `\uNNNN`, because `$$${`
 * reads two ways and the parser picks the template.
 */
function quote(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    const next = value[i + 1]
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if ((ch === '$' || ch === '%') && next === '{') out += ch + ch
    else if ((ch === '$' || ch === '%') && runEndsInBrace(value, i)) out += unicode(ch)
    else if (ch < ' ' || ch === '\u007f') {
      out += unicode(ch)
    } else out += ch
  }
  return out + '"'
}

function render(value: JsonValue, depth: number): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number') return number(value)
  if (typeof value === 'boolean') return String(value)
  const inner = INDENT.repeat(depth + 1)
  const outer = INDENT.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => inner + render(item, depth + 1) + ',').join('\n')}\n${outer}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  // Keys are always quoted: a map key may be any string, and a bare one would
  // have to be a valid identifier.
  return `{\n${entries.map(([k, v]) => `${inner}${quote(k)} = ${render(v, depth + 1)}`).join('\n')}\n${outer}}`
}

/**
 * The `.tfvars` (HCL) form of an environment's variables, for workflows that
 * run `terraform apply` by hand. Variable names are already valid identifiers
 * (variableNameSchema), so they go out bare.
 */
export function toTfvars(values: Record<string, JsonValue>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name} = ${render(value, 0)}\n`)
    .join('')
}
