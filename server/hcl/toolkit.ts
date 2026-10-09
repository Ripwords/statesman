import { Language, Parser, type Node } from 'web-tree-sitter'
import type { DeclaredVariable, JsonValue } from '../../shared/schemas/variable'

export class HclError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number
  ) {
    super(`${file}:${line}: ${message}`)
    this.name = 'HclError'
  }
}

export type HclToolkit = {
  extractVariables(source: string, file: string): DeclaredVariable[]
  parseTfvars(source: string): Record<string, JsonValue>
}

type AssetName = 'web-tree-sitter.wasm' | 'tree-sitter-hcl.wasm'

const lineOf = (node: Node) => node.startPosition.row + 1

const MAX_LITERAL_DEPTH = 64
const MAX_TREE_DEPTH = 1024

function tooDeep(node: Node, file: string): HclError {
  return new HclError('nesting is too deep', file, lineOf(node))
}

function firstError(node: Node, file: string, depth = 0): Node | null {
  if (depth > MAX_TREE_DEPTH) throw tooDeep(node, file)
  if (node.type === 'ERROR' || node.isMissing) return node
  for (const child of node.children) {
    if (child?.hasError) return firstError(child, file, depth + 1) ?? child
  }
  return null
}

function childOfType(node: Node, type: string): Node | null {
  return node.children.find((c) => c?.type === type) ?? null
}

/** Named children that carry meaning; comments are extras and never count. */
function meaningful(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null && c.type !== 'comment')
}

/** Every named node below `node`, found without recursion so depth cannot overflow the stack. */
function* namedDescendants(node: Node): Generator<Node> {
  const stack: Node[] = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const child of current.namedChildren) {
      if (!child) continue
      yield child
      stack.push(child)
    }
  }
}

const TEMPLATE_PARTS = new Set(['heredoc_start', 'heredoc_identifier', 'template_literal'])
const STRING_PARTS = new Set(['quoted_template_start', 'quoted_template_end', 'template_literal'])

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

/** `$${` and `%%{` are how a template writes a literal `${` and `%{`. */
function unescapeTemplate(raw: string, backslashes: boolean): string {
  if (!backslashes) return raw.replace(/\$\$\{|%%\{/g, (match) => match.slice(1))
  return raw.replace(
    /\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)|\$\$\{|%%\{/g,
    (match, e: string | undefined) => {
      if (e === undefined) return match.slice(1)
      if (e.startsWith('u') || e.startsWith('U'))
        return String.fromCodePoint(Number.parseInt(e.slice(1), 16))
      return ESCAPES[e] ?? e
    }
  )
}

/** `<<-` strips the smallest common indent; `<<` keeps the text as written. */
function heredocText(node: Node): string {
  const start = childOfType(node, 'heredoc_start')?.text ?? '<<'
  const lines = node.text.split('\n').slice(1, -1)
  if (lines.length === 0) return ''
  let body = lines
  if (start.startsWith('<<-')) {
    const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
    const strip = indents.length > 0 ? Math.min(...indents) : 0
    body = lines.map((l) => l.slice(strip))
  }
  return unescapeTemplate(`${body.join('\n')}\n`, false)
}

function numberOf(text: string, negative: boolean, node: Node, file: string): number {
  const value = Number(text)
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new HclError('number is too large to store exactly', file, lineOf(node))
  }
  return negative ? -value : value
}

/** The text of a quoted string with no template parts, or null when it has any. */
function plainString(node: Node): string | null {
  for (const part of namedDescendants(node)) if (!STRING_PARTS.has(part.type)) return null
  return unescapeTemplate(node.text.slice(1, -1), true)
}

/**
 * Converts a LITERAL expression to JSON and refuses anything else (ruling R14).
 * A tfvars file may only contain literals for Terraform too; an expression that
 * slipped through here would be stored as its source text and delivered as a
 * string, which is the one outcome worse than an error. The only evaluation
 * allowed is a unary minus on a numeric literal.
 */
function literal(node: Node, file: string, depth = 0): JsonValue {
  if (depth > MAX_LITERAL_DEPTH) throw tooDeep(node, file)
  let inner: Node = node
  if (node.type === 'expression') {
    const parts = meaningful(node)
    const only = parts[0]
    if (parts.length !== 1 || !only) {
      throw new HclError('expressions are not allowed in a variables file', file, lineOf(node))
    }
    inner = only
  }
  switch (inner.type) {
    case 'literal_value': {
      const value = meaningful(inner)[0]
      if (!value) throw new HclError('empty expression', file, lineOf(inner))
      return literal(value, file, depth)
    }
    case 'numeric_lit':
      return numberOf(inner.text, false, inner, file)
    case 'bool_lit':
      return inner.text === 'true'
    case 'null_lit':
      return null
    case 'operation': {
      const unary = meaningful(inner)[0]
      const operand = unary && meaningful(unary)[0]
      const number = operand?.type === 'literal_value' ? meaningful(operand)[0] : null
      if (
        meaningful(inner).length === 1 &&
        unary?.type === 'unary_operation' &&
        unary.children[0]?.type === '-' &&
        meaningful(unary).length === 1 &&
        number?.type === 'numeric_lit'
      ) {
        return numberOf(number.text, true, number, file)
      }
      throw new HclError('operations are not allowed in a variables file', file, lineOf(inner))
    }
    case 'string_lit': {
      const text = plainString(inner)
      if (text === null)
        throw new HclError('templates are not allowed in a variables file', file, lineOf(inner))
      return text
    }
    case 'template_expr': {
      const heredoc = meaningful(inner)[0]
      if (heredoc?.type === 'quoted_template') {
        throw new HclError('templates are not allowed in a variables file', file, lineOf(inner))
      }
      if (meaningful(inner).length !== 1 || heredoc?.type !== 'heredoc_template') {
        throw new HclError('only literal heredocs are allowed', file, lineOf(inner))
      }
      for (const part of namedDescendants(heredoc)) {
        if (!TEMPLATE_PARTS.has(part.type)) {
          throw new HclError('templates are not allowed in a variables file', file, lineOf(part))
        }
      }
      return heredocText(heredoc)
    }
    case 'collection_value': {
      const collection = meaningful(inner)[0]
      if (collection?.type === 'tuple') {
        return meaningful(collection)
          .filter((c) => c.type === 'expression')
          .map((c) => literal(c, file, depth + 1))
      }
      if (collection?.type === 'object') {
        const out: Record<string, JsonValue> = {}
        for (const elem of meaningful(collection)) {
          if (elem.type !== 'object_elem') continue
          const key = elem.childForFieldName('key')
          const val = elem.childForFieldName('val')
          if (!key || !val) throw new HclError('malformed object element', file, lineOf(elem))
          const name = keyName(key, file, depth + 1)
          if (Object.hasOwn(out, name))
            throw new HclError(`duplicate key "${name}"`, file, lineOf(elem))
          out[name] = literal(val, file, depth + 1)
        }
        return out
      }
      throw new HclError('unsupported collection', file, lineOf(inner))
    }
    default:
      throw new HclError(
        `expressions are not allowed in a variables file (found ${inner.type})`,
        file,
        lineOf(inner)
      )
  }
}

/** A bare name is its own text; a literal number, bool, null or string becomes its string form, as Terraform does. */
function keyName(key: Node, file: string, depth: number): string {
  const parts = key.type === 'expression' ? meaningful(key) : [key]
  const only = parts[0]
  if (parts.length === 1 && only?.type === 'variable_expr' && meaningful(only).length === 1)
    return only.text
  const value = literal(key, file, depth)
  if (typeof value === 'object' && value !== null) {
    throw new HclError('object keys must be names or strings', file, lineOf(key))
  }
  return String(value)
}

function attributes(body: Node | null, file: string): Map<string, Node> {
  const out = new Map<string, Node>()
  for (const child of body ? meaningful(body) : []) {
    if (child.type !== 'attribute') continue
    const name = childOfType(child, 'identifier')?.text
    const expr = childOfType(child, 'expression')
    if (!name || !expr) continue
    if (out.has(name))
      throw new HclError(`attribute "${name}" is defined twice`, file, lineOf(child))
    out.set(name, expr)
  }
  return out
}

/** Terraform requires a newline between two attributes or blocks of one body. */
function checkOnePerLine(root: Node, file: string): void {
  for (const node of [root, ...namedDescendants(root)]) {
    if (node.type !== 'body') continue
    let previous: Node | null = null
    for (const child of meaningful(node)) {
      if (previous && child.startPosition.row === previous.endPosition.row) {
        throw new HclError('attributes must be on separate lines', file, lineOf(child))
      }
      previous = child
    }
  }
}

/** A variable block takes exactly one label: a quoted string or a bare name. */
function variableName(block: Node, file: string): string {
  const labels = meaningful(block).filter(
    (c, i) => i > 0 && (c.type === 'string_lit' || c.type === 'identifier')
  )
  const label = labels[0]
  if (labels.length !== 1 || !label) {
    throw new HclError('a variable block needs exactly one label', file, lineOf(block))
  }
  if (label.type === 'identifier') return label.text
  const text = plainString(label)
  if (text === null) throw new HclError('a variable name cannot be a template', file, lineOf(label))
  return text
}

function sensitiveFlag(expr: Node, file: string): boolean {
  const value = literal(expr, file)
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new HclError('sensitive must be true or false', file, lineOf(expr))
}

export async function createHclToolkit(
  readAsset: (name: AssetName) => Promise<Uint8Array>
): Promise<HclToolkit> {
  await Parser.init({ wasmBinary: await readAsset('web-tree-sitter.wasm') })
  const language = await Language.load(await readAsset('tree-sitter-hcl.wasm'))
  const parser = new Parser()
  parser.setLanguage(language)

  /** The tree lives in the WASM heap, which the garbage collector cannot see, so it is freed here. */
  function withBody<T>(source: string, file: string, use: (body: Node | null) => T): T {
    // The grammar needs a newline after a closing heredoc identifier.
    const tree = parser.parse(source.endsWith('\n') ? source : `${source}\n`)
    if (!tree) throw new HclError('could not be parsed', file, 1)
    try {
      const root = tree.rootNode
      const error = root.hasError ? firstError(root, file) : null
      if (error) throw new HclError('syntax error', file, lineOf(error))
      checkOnePerLine(root, file)
      return use(childOfType(root, 'body'))
    } finally {
      tree.delete()
    }
  }

  return {
    extractVariables(source, file) {
      return withBody(source, file, (body) => {
        const out: DeclaredVariable[] = []
        for (const block of body ? meaningful(body) : []) {
          if (block.type !== 'block' || childOfType(block, 'identifier')?.text !== 'variable')
            continue
          const name = variableName(block, file)
          const attrs = attributes(childOfType(block, 'body'), file)
          const description = attrs.get('description')
          const sensitive = attrs.get('sensitive')
          out.push({
            name,
            typeExpr: attrs.get('type')?.text ?? null,
            hasDefault: attrs.has('default'),
            sensitive: sensitive ? sensitiveFlag(sensitive, file) : false,
            description: description ? String(literal(description, file)).trimEnd() : null,
            file,
            line: lineOf(block)
          })
        }
        return out
      })
    },

    parseTfvars(source) {
      const file = 'tfvars'
      return withBody(source, file, (body) => {
        const out: Record<string, JsonValue> = {}
        for (const child of body ? meaningful(body) : []) {
          if (child.type !== 'attribute') {
            throw new HclError(
              'a variables file may only contain name = value lines',
              file,
              lineOf(child)
            )
          }
          const name = childOfType(child, 'identifier')?.text
          const expr = childOfType(child, 'expression')
          if (!name || !expr) throw new HclError('malformed assignment', file, lineOf(child))
          if (Object.hasOwn(out, name))
            throw new HclError(`attribute "${name}" is defined twice`, file, lineOf(child))
          out[name] = literal(expr, file)
        }
        return out
      })
    }
  }
}
