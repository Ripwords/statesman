import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const target = 'server/assets/wasm'
mkdirSync(target, { recursive: true })
copyFileSync(
  require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  join(target, 'web-tree-sitter.wasm')
)
copyFileSync(
  join(
    dirname(require.resolve('@tree-sitter-grammars/tree-sitter-hcl/package.json')),
    'tree-sitter-hcl.wasm'
  ),
  join(target, 'tree-sitter-hcl.wasm')
)
console.log(`copied parser wasm into ${target}`)
