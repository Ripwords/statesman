import { describe, it, expect, beforeAll } from 'vitest'
import { setup, url as absoluteUrl } from '@nuxt/test-utils/e2e'
import { and, eq } from 'drizzle-orm'
import { auth } from '../../server/utils/auth'
import { db } from '../../server/db/client'
import { auditLog } from '../../server/db/schema'
import { createEnvironment, setVariable } from '../../server/services/variables'
import { resetDb, seedProject, provisionUser } from './helpers'

await setup({ server: true })

const ORG = 'vars-delivery'
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
    `vars-${Date.now()}@example.com`,
    'correct horse battery',
    'admin'
  )
  const env = await createEnvironment(projectId, 'production')
  await setVariable({
    environmentId: env.id,
    name: 'db_password',
    input: { value: 'hunter2', sensitive: true },
    userId: user.id
  })
  await setVariable({
    environmentId: env.id,
    name: 'replicas',
    input: { value: 3, sensitive: false },
    userId: user.id
  })

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
  tokens.stateOnly = await make('state', { state: ['read', 'write'] }, [`${ORG}/prod`])
  tokens.elsewhere = await make('elsewhere', { state: [], vars: ['read'] }, [`${ORG}/other`])
  tokens.varsOnly = await make('vars-only', { vars: ['read'] }, [`${ORG}/prod`])
})

const path = `/api/vars/${ORG}/prod/production`

describe('GET /api/vars/:org/:project/:environment', () => {
  it('answers 401 without credentials', async () => {
    expect((await get(path)).status).toBe(401)
  })

  it('answers 404 for an unknown environment', async () => {
    expect((await get(`/api/vars/${ORG}/prod/staging`, tokens.vars)).status).toBe(404)
  })

  it('answers 404 for a malformed environment slug', async () => {
    expect((await get(`/api/vars/${ORG}/prod/Bad_Slug`, tokens.vars)).status).toBe(404)
  })

  it('answers 403 to a state-only token', async () => {
    expect((await get(path, tokens.stateOnly)).status).toBe(403)
  })

  it('answers 403 to a token scoped to another project', async () => {
    expect((await get(path, tokens.elsewhere)).status).toBe(403)
  })

  it('returns the tfvars.json body, uncached, and audits the read', async () => {
    const response = await get(path, tokens.vars)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ db_password: 'hunter2', replicas: 3 })
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'variables.read')))
    expect(
      rows.some(
        (r) => (r.metaJson as { environment?: string } | null)?.environment === 'production'
      )
    ).toBe(true)
  })
})
describe('GET /api/tf/:org/:project with a variables-only token', () => {
  it('answers 403: a vars token with no state permission cannot read state', async () => {
    expect((await get(`/api/tf/${ORG}/prod`, tokens.varsOnly)).status).toBe(403)
  })
})
