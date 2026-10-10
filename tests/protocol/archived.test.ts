import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { eq } from 'drizzle-orm'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { project } from '../../server/db/schema'
import { acquireLock, currentLock } from '../../server/services/lock'
import { seedProject, resetDb, provisionUser } from './helpers'

await setup({ server: true })

// This suite owns this organization slug; see resetDb in ./helpers.
const ORG = 'archived-suite'
const base = `/api/tf/${ORG}/prod`
const tokens = { all: '', scoped: '' }
let projectId: string

function send(path: string, token: string, method: string, body?: string): Promise<Response> {
  return fetch(absoluteUrl(path), {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}`,
      'content-type': 'application/json'
    },
    body
  })
}

const state = (serial: number) => JSON.stringify({ version: 4, serial, lineage: 'l1' })

beforeAll(async () => {
  const user = await provisionUser(
    `arch${Date.now()}@example.com`,
    'correct horse battery',
    'admin'
  )
  for (const [name, scope] of [
    ['all', { kind: 'all' }],
    ['scoped', { kind: 'projects', projects: [`${ORG}/prod`] }]
  ] as const) {
    const key = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: `archived-${name}`,
        permissions: { state: ['read', 'write', 'delete', 'lock'] },
        metadata: { scope }
      }
    })
    tokens[name] = key.key
  }
})

beforeEach(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'prod')
  const seeded = await send(base, tokens.all, 'POST', state(1))
  if (seeded.status !== 200) throw new Error(`seeding state answered ${seeded.status}`)
})

async function archive(): Promise<void> {
  await db().update(project).set({ archivedAt: new Date() }).where(eq(project.id, projectId))
}

describe.each(['all', 'scoped'] as const)('an archived project, %s token', (kind) => {
  it('still serves the state', async () => {
    await archive()
    expect((await send(base, tokens[kind], 'GET')).status).toBe(200)
  })

  it('refuses a state write with 409 naming the archive', async () => {
    await archive()
    const res = await send(base, tokens[kind], 'POST', state(2))
    expect(res.status).toBe(409)
    expect(await res.text()).toContain(`Project ${ORG}/prod is archived`)
  })

  it('refuses a state delete with 409', async () => {
    await archive()
    expect((await send(base, tokens[kind], 'DELETE')).status).toBe(409)
  })

  it.each([
    ['POST', `${base}/lock`],
    ['LOCK', `${base}/lock`],
    ['LOCK', base]
  ])('refuses %s %s with 409, not 423', async (method, path) => {
    await archive()
    const res = await send(path, tokens[kind], method, JSON.stringify({ ID: 'run-1' }))
    expect(res.status).toBe(409)
    expect(await currentLock(projectId)).toBeNull()
  })

  it('still releases a lock taken before archiving', async () => {
    await acquireLock(projectId, { ID: 'stuck' })
    await archive()
    const res = await send(`${base}/lock`, tokens[kind], 'DELETE', JSON.stringify({ ID: 'stuck' }))
    expect(res.status).toBe(200)
    expect(await currentLock(projectId)).toBeNull()
  })
})

describe('variables delivery on an archived project', () => {
  it('answers exactly as before archiving', async () => {
    const path = `/api/vars/${ORG}/prod/production`
    const before = (await send(path, tokens.all, 'GET')).status
    await archive()
    expect((await send(path, tokens.all, 'GET')).status).toBe(before)
  })
})
