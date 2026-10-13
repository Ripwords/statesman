import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'
import { isDrift, reportEnvironment } from '../../cli/src/report'
import { mergeEnvFile, ownedEntries } from '../../cli/src/env-file'
import type { Manifest } from '../../shared/schemas/manifest'
import type { CheckoutResponse } from '../../shared/schemas/backend'

let hcl: HclToolkit
beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

const manifest: Manifest = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const checkout: CheckoutResponse = { variables: { a: 1, secret: 'shh' }, backend: { bucket: 'b' } }
const run = (files: Record<string, string>, c = checkout) =>
  reportEnvironment({ manifest, env: 'client', checkout: c, read: (f) => files[f] ?? null, hcl })

describe('reportEnvironment', () => {
  it('reports all three files missing in an empty directory, with desired contents', () => {
    const r = run({})
    expect(r.map((x) => [x.file, x.state])).toEqual([
      ['client.tfvars', 'missing'],
      ['backend.client.hcl', 'missing'],
      ['.env.client', 'missing']
    ])
    expect(r[0]?.desired).toBe('a = 1\nsecret = "shh"\n')
    expect(r.every(isDrift)).toBe(true)
  })

  it('reports ok for equivalent hand-formatted files', () => {
    const r = run({
      'client.tfvars': 'secret="shh"\na=1\n',
      'backend.client.hcl': 'bucket   = "b"\n',
      '.env.client': mergeEnvFile(
        'AWS_PROFILE=x\n',
        ownedEntries({ vars: 'client.tfvars', backend: 'backend.client.hcl' }, 'client')
      )
    })
    expect(r.map((x) => x.state)).toEqual(['ok', 'ok', 'ok'])
  })

  it('names differing variables without values', () => {
    const r = run({ 'client.tfvars': 'a = 2\nsecret = "shh"\nold = 1\n' })
    expect(r[0]).toMatchObject({ state: 'differs', detail: ['a', '-old'] })
    expect(JSON.stringify(r[0]?.detail)).not.toContain('shh')
  })

  it('reports an unparseable file as unreadable with its line', () => {
    const r = run({ 'client.tfvars': 'a = 1\nb = var.x\n' })
    expect(r[0]?.state).toBe('unreadable')
    expect(r[0]?.detail[0]).toMatch(/^client\.tfvars:2: /)
  })

  it('reports no-backend, not missing, when statesman has no backend settings', () => {
    const r = run({}, { variables: {}, backend: null })
    expect(r[1]).toMatchObject({ file: 'backend.client.hcl', state: 'no-backend', desired: null })
    expect(isDrift(r[1]!)).toBe(false)
    // and the .env file then has no TF_CLI_ARGS_init
    expect(r[2]?.desired).not.toContain('TF_CLI_ARGS_init')
  })
})
