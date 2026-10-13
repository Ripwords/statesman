import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function buildCli(): Promise<string> {
  const outdir = join(root, 'cli/dist')
  const outfile = join(outdir, 'statesman.mjs')
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: [join(root, 'cli/src/main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // web-tree-sitter's ESM build still calls require() for node builtins.
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    },
    logLevel: 'warning'
  })
  for (const name of ['web-tree-sitter.wasm', 'tree-sitter-hcl.wasm']) {
    copyFileSync(join(root, 'server/assets/wasm', name), join(outdir, name))
  }
  return outfile
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await buildCli())
}
