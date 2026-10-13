import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { createEnvironment, setBackend, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from '../protocol/helpers'
import { buildCli } from '../../scripts/build-cli'

await setup({ server: true })

const sh = promisify(execFile)
const ORG = 'checkout-e2e'
let dir: string
let bin: string
let token: string
let userId: string
let clientEnvId: string

const cli = (...args: string[]) =>
  spawnSync('node', [bin, ...args, '--dir', dir], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, STATESMAN_TOKEN: token }
  })

const terraform = (env: string, args: string) =>
  sh('sh', ['-c', `set -a; . ./.env.${env}; set +a; terraform ${args}`], {
    cwd: dir,
    env: { PATH: process.env.PATH, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
  })

beforeAll(async () => {
  bin = await buildCli()
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'app')
  userId = (
    await provisionUser(`checkout-e2e-${Date.now()}@example.com`, 'correct horse battery', 'admin')
  ).id
  for (const [slug, value] of [
    ['internal', 'in'],
    ['client', 'cl']
  ] as const) {
    const env = await createEnvironment(projectId, slug)
    if (slug === 'client') clientEnvId = env.id
    await setVariable({
      environmentId: env.id,
      name: 'value',
      input: { value, sensitive: true },
      userId
    })
    await setVariable({
      environmentId: env.id,
      name: 'replicas',
      input: { value: 2, sensitive: false },
      userId
    })
    await setBackend(env.id, { path: `${slug}.tfstate` })
  }
  token = (
    await auth.api.createApiKey({
      body: {
        userId,
        name: 'checkout-e2e',
        permissions: { state: [], vars: ['read'] },
        metadata: { scope: { kind: 'projects', projects: [`${ORG}/app`] } }
      }
    })
  ).key
  dir = mkdtempSync(join(tmpdir(), 'statesman-checkout-'))
  cpSync(fileURLToPath(new URL('fixture-checkout', import.meta.url)), dir, { recursive: true })
  writeFileSync(
    join(dir, 'statesman.json'),
    JSON.stringify({
      server: new URL(absoluteUrl('/')).origin,
      project: `${ORG}/app`,
      environments: ['internal', 'client'],
      files: { vars: '{env}.tfvars', backend: 'backend.{env}.hcl', env: '.env.{env}' }
    })
  )
}, 180_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('statesman pull with real terraform', () => {
  it('writes six files that terraform uses for each environment', async () => {
    const r = cli('pull')
    expect(r.status, r.stderr).toBe(0)
    for (const env of ['internal', 'client']) {
      for (const f of [`${env}.tfvars`, `backend.${env}.hcl`, `.env.${env}`])
        expect(existsSync(join(dir, f))).toBe(true)
      await terraform(env, 'init -no-color')
      await terraform(env, 'apply -auto-approve -no-color')
      const { stdout } = await terraform(env, 'output -raw canary')
      expect(stdout.trim()).toBe(`${env === 'internal' ? 'in' : 'cl'}-2`)
      expect(existsSync(join(dir, `${env}.tfstate`))).toBe(true)
      expect(existsSync(join(dir, `.terraform-${env}`))).toBe(true)
    }
    expect(cli('status').status).toBe(0)
  }, 300_000)

  it('detects a dashboard change, refuses without --force, keeps foreign .env lines', async () => {
    await setVariable({
      environmentId: clientEnvId,
      name: 'replicas',
      input: { value: 5, sensitive: false },
      userId
    })
    const s = cli('status')
    expect(s.status).toBe(1)
    expect(s.stdout).toMatch(/client\.tfvars\s+differs: replicas/)
    expect(s.stdout).not.toContain('"cl"')

    expect(cli('pull').status).toBe(1)
    appendFileSync(join(dir, '.env.client'), 'AWS_PROFILE=client-profile\n')
    expect(cli('pull', '--force').status).toBe(0)
    expect(cli('status').status).toBe(0)
    expect(readFileSync(join(dir, '.env.client'), 'utf8')).toContain('AWS_PROFILE=client-profile')
  })
})
