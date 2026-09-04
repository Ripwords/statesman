export type DiffLine = { kind: 'add' | 'remove' | 'same', path: string, value: string }

/**
 * Flattens a document to leaf paths. An empty object or array is recorded as a
 * leaf of its own, so `{}` becoming `[]` reads as a change rather than as
 * nothing at all.
 */
function flatten(
  value: unknown,
  prefix = '',
  out = new Map<string, string>()
): Map<string, string> {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, JSON.stringify(value) ?? 'undefined')
    return out
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    out.set(prefix, Array.isArray(value) ? '[]' : '{}')
    return out
  }
  for (const [key, child] of entries) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out)
  }
  return out
}

/**
 * A path-wise diff of two decrypted state documents. A changed value comes back
 * as a remove followed by an add, which is what a reader of a unified diff
 * expects and what lets the table colour each side independently.
 */
export function diffJson(a: unknown, b: unknown): DiffLine[] {
  const left = flatten(a)
  const right = flatten(b)
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()

  const lines: DiffLine[] = []
  for (const path of paths) {
    const before = left.get(path)
    const after = right.get(path)
    if (before === after) {
      lines.push({ kind: 'same', path, value: after ?? '' })
      continue
    }
    if (before !== undefined) lines.push({ kind: 'remove', path, value: before })
    if (after !== undefined) lines.push({ kind: 'add', path, value: after })
  }
  return lines
}
