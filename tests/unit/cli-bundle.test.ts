import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCli } from '../../scripts/build-cli'

let bin: string
beforeAll(async () => {
  bin = await buildCli()
}, 120_000)

describe('bundled CLI', () => {
  it('ships the wasm beside the bundle', () => {
    expect(existsSync(join(dirname(bin), 'tree-sitter-hcl.wasm'))).toBe(true)
    expect(existsSync(join(dirname(bin), 'web-tree-sitter.wasm'))).toBe(true)
  })
  it('prints usage', () => {
    expect(execFileSync('node', [bin, '--help'], { encoding: 'utf8' })).toContain('statesman pull')
  })
  it('prints usage when started through a symlink (npm bin)', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'statesman-link-')), 'statesman')
    symlinkSync(bin, link)
    expect(execFileSync('node', [link, '--help'], { encoding: 'utf8' })).toContain('statesman pull')
  })
  it('exits 2 without a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'statesman-bundle-'))
    writeFileSync(
      join(dir, 'statesman.json'),
      JSON.stringify({
        server: 'http://127.0.0.1:9',
        project: 'a/b',
        environments: ['x'],
        files: { vars: '{env}.tfvars' }
      })
    )
    const r = spawnSync('node', [bin, 'status', '--dir', dir], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH }
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('set STATESMAN_TOKEN')
  })
})
