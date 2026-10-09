import { createHclToolkit, type HclToolkit } from './toolkit'

let toolkit: Promise<HclToolkit> | undefined

/**
 * The binaries are Nitro server assets (server/assets/wasm), which every preset
 * bundles, Vercel included, proven in Task 0 of the variables plan. Memoised:
 * instantiating the parser costs tens of milliseconds and the result is
 * stateless between parses.
 *
 * `getItemRaw` returns a Buffer, Uint8Array or ArrayBuffer depending on the
 * driver, so the bytes are normalised before web-tree-sitter sees them.
 */
export function hcl(): Promise<HclToolkit> {
  toolkit ??= createHclToolkit(async (name) => {
    const raw = await useStorage('assets:server').getItemRaw<Uint8Array | ArrayBuffer>(
      `wasm:${name}`
    )
    if (!raw) throw new Error(`parser asset missing: server/assets/wasm/${name}`)
    return raw instanceof Uint8Array
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : new Uint8Array(raw)
  })
  toolkit.catch(() => {
    toolkit = undefined
  })
  return toolkit
}
