import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pull, status } from '../../cli/src/commands'
import { readOrNull } from '../../cli/src/files'
import { isDirectRun, main } from '../../cli/src/main'
import { formatJson, formatText } from '../../cli/src/output'

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
    for (const f of [
      'internal.tfvars',
      'client.tfvars',
      'backend.internal.hcl',
      'backend.client.hcl',
      '.env.internal',
      '.env.client'
    ]) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
    expect(statSync(join(dir, 'client.tfvars')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'internal.tfvars')).mode & 0o777).toBe(0o600)
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

  it('refuses a differing .env file without --force and merges it with --force', async () => {
    writeFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client\nTF_DATA_DIR=.terraform\n')
    const refused = await pull({ ...opts(), force: false })
    expect(refused.exitCode).toBe(1)
    expect(refused.reports.find((r) => r.file === '.env.client')).toMatchObject({
      action: 'refused'
    })
    expect(readFileSync(join(dir, '.env.client'), 'utf8')).toContain('TF_DATA_DIR=.terraform\n')
    const forced = await pull({ ...opts(), force: true })
    expect(forced.exitCode).toBe(0)
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

describe('fix round 1', () => {
  const urls: string[] = []
  const recordingFetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return fakeFetch(input)
  }) as typeof fetch
  beforeEach(() => {
    urls.length = 0
  })

  it('keeps the permission bits of an existing file', async () => {
    writeFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client\n', { mode: 0o600 })
    chmodSync(join(dir, '.env.client'), 0o600)
    await pull({ ...opts(), force: true })
    expect(statSync(join(dir, '.env.client')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'backend.client.hcl')).mode & 0o777).toBe(0o644)
  })

  it('never puts a variable value in the text or json output', async () => {
    const result = await pull({ ...opts(), force: false })
    expect(result.reports.some((r) => r.desired?.includes('shh'))).toBe(true)
    expect(formatText(result)).not.toContain('shh')
    expect(formatJson(result)).not.toContain('shh')
    const lines: string[] = []
    const original = console.log
    console.log = (m: string) => lines.push(m)
    try {
      await main(['status', '--dir', dir, '--json'], { STATESMAN_TOKEN: 't' }).catch(() => 2)
    } finally {
      console.log = original
    }
    expect(lines.join('\n')).not.toContain('shh')
  })

  it('exits 2 and writes nothing when one environment cannot be fetched', async () => {
    const half = (async (input: RequestInfo | URL) =>
      String(input).endsWith('/client')
        ? new Response('{}', { status: 500 })
        : fakeFetch(input)) as typeof fetch
    await expect(pull({ ...opts({ fetchImpl: half }), force: false })).rejects.toMatchObject({
      exitCode: 2
    })
    expect(existsSync(join(dir, 'internal.tfvars'))).toBe(false)
  })

  it('STATESMAN_URL overrides the manifest server and keeps a path prefix', async () => {
    await status(opts({ fetchImpl: recordingFetch, serverOverride: 'https://o.example.com/base/' }))
    expect(urls).toContain('https://o.example.com/base/api/checkout/acme/p/client')
    expect(urls.every((u) => u.startsWith('https://o.example.com/base/'))).toBe(true)
  })

  it.each(['ftp://o.example.com', 'https://user:pw@o.example.com', 'not a url'])(
    'rejects STATESMAN_URL %s without echoing it',
    async (value) => {
      const e = await status(opts({ serverOverride: value })).catch((x: unknown) => x)
      expect(e).toMatchObject({ exitCode: 2, message: expect.stringContaining('STATESMAN_URL') })
      expect(String((e as Error).message)).not.toContain('pw')
      expect(String((e as Error).message)).not.toContain(value)
    }
  )

  it('turns a failing write into an exit-2 error naming the file', async () => {
    chmodSync(dir, 0o500)
    try {
      const e = await pull({ ...opts(), force: false }).catch((x: unknown) => x)
      expect(e).toMatchObject({ exitCode: 2 })
      expect(String((e as Error).message)).toMatch(/tfvars: cannot write \(EACCES\)/)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('does not follow a symlink planted at the temp path', async () => {
    const target = join(dir, 'victim')
    writeFileSync(target, 'keep')
    symlinkSync(target, join(dir, `.backend.client.hcl.statesman-${process.pid}`))
    await pull({ ...opts({ envs: ['client'] }), force: false })
    expect(readFileSync(target, 'utf8')).toBe('keep')
    expect(existsSync(join(dir, 'backend.client.hcl'))).toBe(true)
  })

  it('stops with exit 2 when git itself fails, writing nothing', async () => {
    writeFileSync(join(dir, '.git'), 'garbage')
    await expect(pull({ ...opts(), force: false })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('git') as unknown as string
    })
    expect(existsSync(join(dir, 'client.tfvars'))).toBe(false)
  })

  it('isDirectRun follows a symlink to the module', () => {
    const real = join(dir, 'real.mjs')
    writeFileSync(real, '')
    const link = join(dir, 'link.mjs')
    symlinkSync(real, link)
    const metaUrl = pathToFileURL(realpathSync(real)).href
    expect(isDirectRun(link, metaUrl)).toBe(true)
    expect(isDirectRun(undefined, metaUrl)).toBe(false)
    expect(isDirectRun(join(dir, 'other.mjs'), metaUrl)).toBe(false)
  })
})

describe('final review fixes', () => {
  it('writes a vars file 0600 even when it overwrites a 0644 file', async () => {
    writeFileSync(join(dir, 'client.tfvars'), 'a = 99\n')
    chmodSync(join(dir, 'client.tfvars'), 0o644)
    expect((await pull({ ...opts(), force: true })).exitCode).toBe(0)
    expect(statSync(join(dir, 'client.tfvars')).mode & 0o777).toBe(0o600)
  })
})
