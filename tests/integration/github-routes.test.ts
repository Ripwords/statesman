// Must stay first: stands up the Nitro globals (createError, cookies) before any route loads.
import { testEvent, responseOf } from '../ui/nitro-globals'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation, repositoryLink } from '../../server/db/schema'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject } from '../protocol/helpers'
import { GitHubClient, type github as githubFn } from '../../server/github/client'
import type * as ClientModule from '../../server/github/client'
import type * as HclModule from '../../server/hcl'
import { createEnvironment } from '../../server/services/variables'
import { linkRepository, recordInstallation, listInstallations } from '../../server/services/sync'
import setup from '../../server/api/github/setup.get'
import putLink from '../../server/api/ui/environments/[id]/link.put'
import syncNow from '../../server/api/ui/environments/[id]/sync.post'
import listRepos from '../../server/api/ui/github/installations/[id]/repositories.get'

const fake = vi.hoisted(() => ({ client: null as unknown, hclFails: false }))
vi.mock('../../server/hcl', async (importOriginal) => {
  const original = await importOriginal<typeof HclModule>()
  return {
    ...original,
    hcl: () => (fake.hclFails ? Promise.reject(new Error('parser asset missing')) : original.hcl())
  }
})
vi.mock('../../server/github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  github: (() => fake.client) as typeof githubFn
}))

// The shared test database holds several organizations; production has exactly one.
vi.mock('../../server/utils/deployment-org', async () => {
  const { db: database } = await import('../../server/db/client')
  const { organization } = await import('../../server/db/schema')
  const { eq: equals } = await import('drizzle-orm')
  return {
    deploymentOrgId: async () =>
      (
        await database()
          .select({ id: organization.id })
          .from(organization)
          .where(equals(organization.slug, 'github-routes'))
      )[0]!.id
  }
})

const ORG = 'github-routes'
const PASSWORD = 'correct horse battery staple'
const KNOWN = 9_300_001
const FORGED = 9_300_002
let admin: Record<string, string>
let envId: string

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})

/** Answers by path; anything unlisted is GitHub's 404, and `unreachable` a network failure. */
function fakeGitHub(routes: Record<string, unknown>, unreachable?: string) {
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (unreachable && path.includes(unreachable)) throw new TypeError('fetch failed')
    if (path in routes) return Response.json(routes[path])
    return Response.json({ message: 'Not Found: secret detail' }, { status: 404 })
  }
  return new GitHubClient({ id: '1', slug: 'statesman', privateKey, webhookSecret: 'x' }, fetchImpl)
}

const REPOS = {
  total_count: 1,
  repositories: [{ id: 77, full_name: 'acme/infra', default_branch: 'main' }]
}

beforeAll(async () => {
  await resetDb(ORG)
  const a = await provisionUser(`gh-admin-${Date.now()}@example.com`, PASSWORD)
  await setRole(a.id, 'admin')
  admin = Object.fromEntries((await signInHeaders(a.email, PASSWORD)).entries())
  envId = (await createEnvironment(await seedProject(ORG, 'p'), 'dev')).id
})

beforeEach(async () => {
  for (const id of [KNOWN, FORGED, 4242]) {
    await db().delete(githubInstallation).where(eq(githubInstallation.installationId, id))
  }
  await db().delete(repositoryLink).where(eq(repositoryLink.environmentId, envId))
  fake.hclFails = false
  fake.client = fakeGitHub({
    [`/app/installations/${KNOWN}`]: { id: KNOWN, account: { login: 'acme' } },
    [`/app/installations/${KNOWN}/access_tokens`]: {
      token: 't',
      expires_at: new Date(Date.now() + 3_600_000).toISOString()
    },
    '/installation/repositories': REPOS
  })
})

const callback = (query: Record<string, string>, cookieState?: string) =>
  testEvent({
    headers: {
      ...admin,
      ...(cookieState === undefined
        ? {}
        : { cookie: `${admin.cookie}; statesman_gh_state=${cookieState}` })
    },
    query
  })

const recorded = async (id: number) =>
  (await listInstallations()).filter((i) => i.installationId === id)

describe('GET /api/github/setup', () => {
  it.each([
    ['no cookie', { installation_id: String(KNOWN), state: 'abc' }, undefined],
    ['empty cookie', { installation_id: String(KNOWN), state: 'abc' }, ''],
    ['no state', { installation_id: String(KNOWN) }, 'abc'],
    ['empty state', { installation_id: String(KNOWN), state: '' }, 'abc'],
    ['mismatched state', { installation_id: String(KNOWN), state: 'abd' }, 'abc']
  ])('refuses %s, records nothing, clears the cookie', async (_n, query, cookie) => {
    const event = callback(query, cookie)
    await expect(setup(event)).rejects.toMatchObject({ statusCode: 400 })
    expect(await recorded(KNOWN)).toEqual([])
    expect(responseOf(event).cookieWrites).toContainEqual(
      expect.objectContaining({ name: 'statesman_gh_state', value: null })
    )
  })

  it('clears the cookie even when the query is malformed', async () => {
    const event = callback({ installation_id: 'nope', state: 'abc' }, 'abc')
    await expect(setup(event)).rejects.toMatchObject({ statusCode: 400 })
    expect(responseOf(event).cookieWrites).toContainEqual(
      expect.objectContaining({ name: 'statesman_gh_state', value: null })
    )
  })

  it('rejects an installation id GitHub does not know, with a fixed message', async () => {
    const event = callback({ installation_id: String(FORGED), state: 'abc' }, 'abc')
    const error = await setup(event).catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 404 })
    expect(String((error as Error).message)).not.toContain('secret detail')
    expect(await recorded(FORGED)).toEqual([])
  })

  it('records the id and login GitHub reports, then redirects', async () => {
    const event = callback({ installation_id: String(KNOWN), state: 'abc' }, 'abc')
    await setup(event)
    expect(await recorded(KNOWN)).toEqual([{ installationId: KNOWN, accountLogin: 'acme' }])
    expect(responseOf(event).redirect).toBe('/?github=connected')
  })

  it('answers a malformed GitHub installation with a fixed 502, recording nothing', async () => {
    fake.client = fakeGitHub({ [`/app/installations/${KNOWN}`]: { id: KNOWN, account: null } })
    const event = callback({ installation_id: String(KNOWN), state: 'abc' }, 'abc')
    await expect(setup(event)).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: 'GitHub returned an error. Try again.'
    })
    expect(await recorded(KNOWN)).toEqual([])
  })

  it('sends a pending approval request back with a notice', async () => {
    const event = callback({ setup_action: 'request', state: 'abc' }, 'abc')
    await setup(event)
    expect(responseOf(event).redirect).toBe('/?github=requested')
    expect(responseOf(event).cookieWrites.length).toBeGreaterThan(0)
  })
})

describe('PUT /api/ui/environments/:id/link', () => {
  const put = (body: unknown) => putLink(testEvent({ headers: admin, params: { id: envId }, body }))

  it('refuses an installation that was never recorded', async () => {
    await expect(put({ installationId: 4242, repoId: 77 })).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'Unknown installation.'
    })
  })

  it('refuses a repository the installation cannot see, writing no link', async () => {
    await recordInstallation(KNOWN, 'acme')
    await expect(put({ installationId: KNOWN, repoId: 999 })).rejects.toMatchObject({
      statusCode: 400
    })
    const rows = await db()
      .select()
      .from(repositoryLink)
      .where(eq(repositoryLink.environmentId, envId))
    expect(rows).toEqual([])
  })

  const linkRow = async () =>
    (await db().select().from(repositoryLink).where(eq(repositoryLink.environmentId, envId)))[0]

  // The link is saved before the first sync runs; a 500 here would tell the
  // admin "Could not link" about a link that exists.
  it('reports a saved link with a failed first sync when the sync fails unexpectedly', async () => {
    await recordInstallation(KNOWN, 'acme')
    fake.hclFails = true
    const result = await put({ installationId: KNOWN, repoId: 77 })
    expect(result).toEqual({
      ok: false,
      error: 'The first sync could not finish. Press Sync now to try again.'
    })
    expect(await linkRow()).toMatchObject({ repoId: 77, ref: 'main' })
  })

  it('reports a network failure during the first sync on the saved link', async () => {
    await recordInstallation(KNOWN, 'acme')
    fake.client = fakeGitHub(
      {
        [`/app/installations/${KNOWN}/access_tokens`]: {
          token: 't',
          expires_at: new Date(Date.now() + 3_600_000).toISOString()
        },
        '/installation/repositories': REPOS
      },
      '/commits/'
    )
    const result = await put({ installationId: KNOWN, repoId: 77 })
    expect(result).toEqual({ ok: false, error: 'Could not reach GitHub.' })
    expect(await linkRow()).toMatchObject({ lastSyncError: 'Could not reach GitHub.' })
  })

  it('maps a GitHub 404 to a fixed 4xx', async () => {
    await recordInstallation(FORGED, 'ghost')
    const error = await put({ installationId: FORGED, repoId: 77 }).catch((e: unknown) => e)
    expect(error).toMatchObject({ statusCode: 404 })
    expect(String((error as Error).message)).not.toContain('secret detail')
  })
})

describe('GET /api/ui/github/installations/:id/repositories', () => {
  it('404s an unrecorded installation', async () => {
    await expect(
      listRepos(testEvent({ headers: admin, params: { id: '4242' } }))
    ).rejects.toMatchObject({ statusCode: 404, statusMessage: 'Unknown installation.' })
  })
})

describe('POST /api/ui/environments/:id/sync', () => {
  it('404s an unlinked environment without calling sync', async () => {
    await expect(
      syncNow(testEvent({ headers: admin, params: { id: envId } }))
    ).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: 'This environment is not linked to a repository.'
    })
  })

  it('still reaches sync for a linked environment', async () => {
    await recordInstallation(KNOWN, 'acme')
    await linkRepository({
      environmentId: envId,
      installationId: KNOWN,
      repoId: 77,
      repoFullName: 'acme/infra',
      ref: 'main',
      directory: ''
    })
    const result = await syncNow(testEvent({ headers: admin, params: { id: envId } }))
    expect(result).toMatchObject({ ok: false })
  })
})
