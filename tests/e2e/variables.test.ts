import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, cp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { auth } from '../../server/utils/auth'
import { createEnvironment, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from '../protocol/helpers'

await setup({ server: true })

const run = promisify(execFile)
const ORG = 'tf-vars'
let dir: string
let token: string
let envId: string
let userId: string

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'app')
  const user = await provisionUser(
    `tfvars-${Date.now()}@example.com`,
    'correct horse battery',
    'admin'
  )
  const env = await createEnvironment(projectId, 'production')
  envId = env.id
  userId = user.id
  await setVariable({
    environmentId: env.id,
    name: 'value',
    input: { value: 'two', sensitive: true },
    userId: user.id
  })
  await setVariable({
    environmentId: env.id,
    name: 'replicas',
    input: { value: 3, sensitive: false },
    userId: user.id
  })
  token = (
    await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: 'tfvars-e2e',
        permissions: { state: [], vars: ['read'] },
        metadata: { scope: { kind: 'projects', projects: [`${ORG}/app`] } }
      }
    })
  ).key
  dir = await mkdtemp(join(tmpdir(), 'statesman-vars-'))
  await cp(fileURLToPath(new URL('fixture-vars', import.meta.url)), dir, { recursive: true })
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('real terraform with delivered variables', () => {
  it('applies with the downloaded file and no -var flags', async () => {
    // The documented recipe, minus curl: the same request, the same file name.
    const response = await fetch(absoluteUrl(`/api/vars/${ORG}/app/production`), {
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
    })
    expect(response.status).toBe(200)
    await writeFile(join(dir, 'statesman.auto.tfvars.json'), await response.text())

    const env = { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
    await run('terraform', ['init', '-no-color'], { cwd: dir, env })
    await run('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: dir, env })
    const { stdout } = await run('terraform', ['output', '-raw', 'canary'], { cwd: dir, env })
    expect(stdout.trim()).toBe('two-3')
  })

  it('applies with the downloaded .tfvars file instead', async () => {
    // A changed value, so the result proves this file was read and not the last.
    await setVariable({
      environmentId: envId,
      name: 'replicas',
      input: { value: 5, sensitive: false },
      userId
    })
    const response = await fetch(absoluteUrl(`/api/vars/${ORG}/app/production?format=tfvars`), {
      headers: { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
    })
    expect(response.status).toBe(200)
    await rm(join(dir, 'statesman.auto.tfvars.json'))
    await writeFile(join(dir, 'statesman.auto.tfvars'), await response.text())

    const env = { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }
    await run('terraform', ['apply', '-auto-approve', '-no-color'], { cwd: dir, env })
    const { stdout } = await run('terraform', ['output', '-raw', 'canary'], { cwd: dir, env })
    expect(stdout.trim()).toBe('two-5')
  })
})
