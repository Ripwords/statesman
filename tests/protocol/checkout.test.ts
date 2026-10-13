import { describe, it, expect, beforeAll } from 'vitest'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { eq } from 'drizzle-orm'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { auditLog } from '../../server/db/schema'
import { createEnvironment, setBackend, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from './helpers'

await setup({ server: true })

const ORG = 'checkout'
const tokens: Record<string, string> = {}
const get = (path: string, token?: string) =>
  fetch(absoluteUrl(path), {
    headers: token
      ? { authorization: `Basic ${Buffer.from(`statesman:${token}`).toString('base64')}` }
      : {}
  })

beforeAll(async () => {
  await resetDb(ORG)
  const projectId = await seedProject(ORG, 'prod')
  await seedProject(ORG, 'other')
  const user = await provisionUser(
    `checkout-${Date.now()}@example.com`,
    'correct horse battery',
    'admin'
  )
  const client = await createEnvironment(projectId, 'client')
  await createEnvironment(projectId, 'internal')
  await setVariable({
    environmentId: client.id,
    name: 'db_password',
    input: { value: 'hunter2', sensitive: true },
    userId: user.id
  })
  await setBackend(client.id, { bucket: 'b', encrypt: true })
  const make = async (name: string, permissions: Record<string, string[]>, projects: string[]) =>
    (
      await auth.api.createApiKey({
        body: {
          userId: user.id,
          name,
          permissions,
          metadata: { scope: { kind: 'projects', projects } }
        }
      })
    ).key
  tokens.vars = await make('vars', { state: [], vars: ['read'] }, [`${ORG}/prod`])
  tokens.stateOnly = await make('state', { state: ['read'] }, [`${ORG}/prod`])
  tokens.elsewhere = await make('elsewhere', { state: [], vars: ['read'] }, [`${ORG}/other`])
})

const path = `/api/checkout/${ORG}/prod/client`

describe('GET /api/checkout/:org/:project/:environment', () => {
  it('answers 401 without credentials', async () => {
    expect((await get(path)).status).toBe(401)
  })
  it('answers 404 for an unknown project', async () => {
    expect((await get(`/api/checkout/${ORG}/nope/client`, tokens.vars)).status).toBe(404)
  })
  it('answers 404 for an unknown environment', async () => {
    expect((await get(`/api/checkout/${ORG}/prod/staging`, tokens.vars)).status).toBe(404)
  })
  it('answers 403 to a state-only token, even for an unknown environment', async () => {
    expect((await get(path, tokens.stateOnly)).status).toBe(403)
    expect((await get(`/api/checkout/${ORG}/prod/staging`, tokens.stateOnly)).status).toBe(403)
  })
  it('answers 403 to a token scoped to another project', async () => {
    expect((await get(path, tokens.elsewhere)).status).toBe(403)
  })
  it('returns variables and backend settings, uncached, with one audit row', async () => {
    const before = (await db().select().from(auditLog).where(eq(auditLog.action, 'checkout.read')))
      .length
    const response = await get(path, tokens.vars)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      variables: { db_password: 'hunter2' },
      backend: { bucket: 'b', encrypt: true }
    })
    const rows = await db().select().from(auditLog).where(eq(auditLog.action, 'checkout.read'))
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)?.metaJson).toEqual({ environment: 'client', count: 1 })
  })
  it('returns backend null for an environment without settings', async () => {
    const response = await get(`/api/checkout/${ORG}/prod/internal`, tokens.vars)
    expect(await response.json()).toEqual({ variables: {}, backend: null })
  })
})
