import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pull, status } from '../../cli/src/commands'
import { readOrNull } from '../../cli/src/files'
import { main } from '../../cli/src/main'

const MANIFEST = {
  server: 'https://s.example.com',
  project: 'acme/p',
  environments: ['internal', 'client'],
  files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
}
const DATA: Record<string, unknown> = {
  internal: { variables: { a: 1 }, backend: { bucket: 'bi' } },
  client: { variables: { a: 2, secret: 'shh' }, backend: { bucket: 'bc' } }
}
const fakeFetch = (async (input: RequestInfo | URL) => {
  const env = String(input).split('/').at(-1) ?? ''
  return new Response(JSON.stringify(DATA[env]), { status: DATA[env] ? 200 : 404 })
}) as typeof fetch

let dir: string
const opts = (extra: object = {}) => ({
  dir,
  envs: [],
  token: 't',
  serverOverride: undefined,
  fetchImpl: fakeFetch,
  ...extra
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'statesman-cli-'))
  writeFileSync(join(dir, 'statesman.json'), JSON.stringify(MANIFEST))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pull and status outside git', () => {
  it('pull writes six files, the vars files 0600; status is then clean', async () => {
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(0)
    for (const f of ['internal.tfvars', 'client.tfvars', 'backend.client.hcl', '.env.client']) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
    expect(statSync(join(dir, 'client.tfvars')).mode & 0o777).toBe(0o600)
    expect((await status(opts())).exitCode).toBe(0)
  })

  it('refuses to overwrite a changed vars file without --force, but writes the rest', async () => {
    writeFileSync(join(dir, 'client.tfvars'), 'a = 99\n')
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(1)
    expect(result.reports.find((r) => r.file === 'client.tfvars')).toMatchObject({
      action: 'refused',
      detail: ['a', '+secret']
    })
    expect(readFileSync(join(dir, 'client.tfvars'), 'utf8')).toBe('a = 99\n')
    expect(existsSync(join(dir, 'internal.tfvars'))).toBe(true)
    const forced = await pull({ ...opts(), force: true })
    expect(forced.exitCode).toBe(0)
    expect(readFileSync(join(dir, 'client.tfvars'), 'utf8')).toContain('secret = "shh"')
  })

  it('always merges .env files and keeps foreign lines, without --force', async () => {
    writeFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client\nTF_DATA_DIR=.terraform\n')
    const result = await pull({ ...opts(), force: false })
    expect(result.exitCode).toBe(0)
    const text = readFileSync(join(dir, '.env.client'), 'utf8')
    expect(text).toContain('AWS_PROFILE=client\nTF_DATA_DIR=.terraform-client\n')
  })

  it('--env limits the run and refuses an environment not in the manifest', async () => {
    const result = await pull({ ...opts({ envs: ['client'] }), force: false })
    expect(result.reports.every((r) => r.env === 'client' || r.env === null)).toBe(true)
    await expect(status(opts({ envs: ['staging'] }))).rejects.toMatchObject({ exitCode: 2 })
  })

  it('status reports a stray and exits 1', async () => {
    await pull({ ...opts(), force: false })
    writeFileSync(join(dir, '.env.staging'), 'X=1\n')
    const result = await status(opts())
    expect(result.exitCode).toBe(1)
    expect(result.reports.find((r) => r.state === 'stray')).toMatchObject({
      file: '.env.staging',
      env: null
    })
  })

  it('turns an unreadable file into an exit-2 error naming the file', async () => {
    mkdirSync(join(dir, 'client.tfvars'))
    await expect(status(opts())).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/client\.tfvars: cannot read \(EISDIR\)/) as unknown as string
    })
  })
})

describe('readOrNull', () => {
  it('returns null for a missing file and a CliError for other failures', () => {
    expect(readOrNull(join(dir, 'nope'))).toBeNull()
    mkdirSync(join(dir, 'd'))
    expect(() => readOrNull(join(dir, 'd'))).toThrowError(/d: cannot read \(EISDIR\)/)
  })
})

describe('inside git', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })

  it('refuses before writing anything when a vars file would be committed', async () => {
    await expect(pull({ ...opts(), force: false })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('internal.tfvars') as unknown as string
    })
    expect(existsSync(join(dir, 'backend.client.hcl'))).toBe(false)
  })

  it('writes once the vars files are ignored, and a tracked .env.example is not stray', async () => {
    writeFileSync(join(dir, '.gitignore'), '*.tfvars\n')
    writeFileSync(join(dir, '.env.example'), 'X=1\n')
    execFileSync('git', ['add', '.env.example', '.gitignore'], { cwd: dir })
    expect((await pull({ ...opts(), force: false })).exitCode).toBe(0)
    expect((await status(opts())).reports.some((r) => r.state === 'stray')).toBe(false)
  })
})

describe('main', () => {
  it('exits 2 with the fix when STATESMAN_TOKEN is unset, writing nothing', async () => {
    const errors: string[] = []
    const original = console.error
    console.error = (m: string) => errors.push(m)
    try {
      expect(await main(['pull', '--dir', dir], {})).toBe(2)
    } finally {
      console.error = original
    }
    expect(errors.join('\n')).toContain('set STATESMAN_TOKEN')
    expect(existsSync(join(dir, 'client.tfvars'))).toBe(false)
  })

  it('exits 2 for a missing manifest and for an unknown command', async () => {
    rmSync(join(dir, 'statesman.json'))
    expect(await main(['status', '--dir', dir], { STATESMAN_TOKEN: 't' })).toBe(2)
    expect(await main(['frobnicate'], { STATESMAN_TOKEN: 't' })).toBe(2)
  })

  it('prints a CliError as one line without a stack', async () => {
    mkdirSync(join(dir, 'client.tfvars'))
    const errors: unknown[] = []
    const original = console.error
    console.error = (m: unknown) => errors.push(m)
    try {
      expect(await main(['status', '--dir', dir], { STATESMAN_TOKEN: 't' })).toBe(2)
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
    expect(typeof errors[0]).toBe('string')
    expect(String(errors[0])).not.toContain('\n    at ')
  })
})
