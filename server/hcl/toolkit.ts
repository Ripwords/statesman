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

function firstError(node: Node): Node | null {
  if (node.type === 'ERROR' || node.isMissing) return node
  for (const child of node.children) {
    if (child?.hasError) return firstError(child) ?? child
  }
  return null
}

function childOfType(node: Node, type: string): Node | null {
  return node.children.find((c) => c?.type === type) ?? null
}

/**
 * `<<-` strips the smallest common indent; `<<` keeps the text as written.
 * The grammar's `template_literal` drops the first line's indent and the final
 * newline, so the body is rebuilt from the lines between the delimiters.
 */
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
  return `${body.join('\n')}\n`
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }

function unescape(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    if (e.startsWith('u') || e.startsWith('U'))
      return String.fromCodePoint(Number.parseInt(e.slice(1), 16))
    return ESCAPES[e] ?? e
  })
}

/**
 * Converts a LITERAL expression to JSON and refuses anything else. A tfvars
 * file may only contain literals for Terraform too; an expression that slipped
 * through here would be stored as its source text and delivered as a string,
 * which is the one outcome worse than an error.
 */
function literal(node: Node, file: string): JsonValue {
  const inner = node.type === 'expression' ? node.firstNamedChild : node
  if (!inner) throw new HclError('empty expression', file, lineOf(node))
  switch (inner.type) {
    case 'literal_value':
      return literal(inner.firstNamedChild ?? inner, file)
    case 'numeric_lit':
      return Number(inner.text)
    case 'bool_lit':
      return inner.text === 'true'
    case 'null_lit':
      return null
    case 'string_lit': {
      if (
        childOfType(inner, 'template_interpolation') ||
        childOfType(inner, 'template_directive')
      ) {
        throw new HclError('interpolation is not allowed in a variables file', file, lineOf(inner))
      }
      return unescape(childOfType(inner, 'template_literal')?.text ?? '')
    }
    case 'template_expr': {
      const heredoc = childOfType(inner, 'heredoc_template')
      if (!heredoc || childOfType(heredoc, 'template_interpolation')) {
        throw new HclError('only literal heredocs are allowed', file, lineOf(inner))
      }
      return heredocText(heredoc)
    }
    case 'collection_value': {
      const collection = inner.firstNamedChild
      if (collection?.type === 'tuple') {
        return collection.namedChildren
          .filter((c): c is Node => c?.type === 'expression')
          .map((c) => literal(c, file))
      }
      if (collection?.type === 'object') {
        const out: Record<string, JsonValue> = {}
        for (const elem of collection.namedChildren) {
          if (elem?.type !== 'object_elem') continue
          const key = elem.childForFieldName('key')
          const val = elem.childForFieldName('val')
          if (!key || !val) throw new HclError('malformed object element', file, lineOf(elem))
          const keyInner = key.firstNamedChild
          const name =
            keyInner?.type === 'variable_expr'
              ? keyInner.text
              : (() => {
                  const k = literal(key, file)
                  if (typeof k !== 'string')
                    throw new HclError('object keys must be names or strings', file, lineOf(key))
                  return k
                })()
          out[name] = literal(val, file)
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

function blockLabel(block: Node): string | null {
  const label = childOfType(block, 'string_lit')
  return label ? (childOfType(label, 'template_literal')?.text ?? '') : null
}

function attributes(body: Node | null): Map<string, Node> {
  const out = new Map<string, Node>()
  for (const child of body?.namedChildren ?? []) {
    if (child?.type !== 'attribute') continue
    const name = childOfType(child, 'identifier')?.text
    const expr = childOfType(child, 'expression')
    if (name && expr) out.set(name, expr)
  }
  return out
}

export async function createHclToolkit(
  readAsset: (name: AssetName) => Promise<Uint8Array>
): Promise<HclToolkit> {
  await Parser.init({ wasmBinary: await readAsset('web-tree-sitter.wasm') })
  const language = await Language.load(await readAsset('tree-sitter-hcl.wasm'))
  const parser = new Parser()
  parser.setLanguage(language)

  function parse(source: string, file: string): Node {
    // The grammar needs a newline after a closing heredoc identifier.
    const tree = parser.parse(source.endsWith('\n') ? source : `${source}\n`)
    if (!tree) throw new HclError('could not be parsed', file, 1)
    const error = tree.rootNode.hasError ? firstError(tree.rootNode) : null
    if (error) throw new HclError('syntax error', file, lineOf(error))
    return tree.rootNode
  }

  return {
    extractVariables(source, file) {
      const body = childOfType(parse(source, file), 'body')
      const out: DeclaredVariable[] = []
      for (const block of body?.namedChildren ?? []) {
        if (block?.type !== 'block' || childOfType(block, 'identifier')?.text !== 'variable')
          continue
        const name = blockLabel(block)
        if (!name) continue
        const attrs = attributes(childOfType(block, 'body'))
        const description = attrs.get('description')
        const sensitive = attrs.get('sensitive')
        out.push({
          name,
          typeExpr: attrs.get('type')?.text ?? null,
          hasDefault: attrs.has('default'),
          sensitive: sensitive ? literal(sensitive, file) === true : false,
          description: description ? String(literal(description, file)).trimEnd() : null,
          file,
          line: lineOf(block)
        })
      }
      return out
    },

    parseTfvars(source) {
      const file = 'tfvars'
      const body = childOfType(parse(source, file), 'body')
      const out: Record<string, JsonValue> = {}
      for (const child of body?.namedChildren ?? []) {
        if (!child) continue
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
        out[name] = literal(expr, file)
      }
      return out
    }
  }
}
