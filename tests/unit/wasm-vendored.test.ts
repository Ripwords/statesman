import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The parser binaries are committed under server/assets so Nitro bundles them
 * into every preset, Vercel included. A committed binary can silently fall
 * behind the package that produced it; this fails the moment it does, and
 * `pnpm vendor:wasm` is the fix.
 */
const PAIRS: Array<[string, string]> = [
  ['web-tree-sitter.wasm', require.resolve('web-tree-sitter/web-tree-sitter.wasm')],
  [
    'tree-sitter-hcl.wasm',
    join(
      dirname(require.resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')),
      'tree-sitter-hcl.wasm'
    )
  ]
]

describe('vendored wasm', () => {
  it.each(PAIRS)('%s matches node_modules', (name, source) => {
    const vendored = readFileSync(join('server/assets/wasm', name))
    expect(vendored.equals(readFileSync(source))).toBe(true)
  })
})
