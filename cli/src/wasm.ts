import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'

/** Bundled: the wasm sits beside statesman.mjs. From source: server/assets/wasm. */
function wasmDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  if (existsSync(join(here, 'tree-sitter-hcl.wasm'))) return here
  return join(here, '../../server/assets/wasm')
}

export function loadHcl(): Promise<HclToolkit> {
  const dir = wasmDir()
  return createHclToolkit(async (name) => readFileSync(join(dir, name)))
}
