import { testEvent } from './nitro-globals'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { GitHubClient, type github as githubFn } from '../../server/github/client'
import type * as ClientModule from '../../server/github/client'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { auditLog, repositoryLink } from '../../server/db/schema'
import listEnvironments from '../../server/api/ui/projects/[id]/environments.get'
import createEnvironment from '../../server/api/ui/projects/[id]/environments.post'
import deleteEnvironment from '../../server/api/ui/environments/[id].delete'
import githubStatus from '../../server/api/ui/github.get'
import { recordInstallation, linkRepository } from '../../server/services/sync'
import listVariables from '../../server/api/ui/environments/[id]/variables.get'
import putVariable from '../../server/api/ui/environments/[id]/variables/[name].put'
import deleteVariable from '../../server/api/ui/environments/[id]/variables/[name].delete'
import importVariables from '../../server/api/ui/environments/[id]/variables/import.post'
import putLink from '../../server/api/ui/environments/[id]/link.put'
import syncNow from '../../server/api/ui/environments/[id]/sync.post'
import unlink from '../../server/api/ui/environments/[id]/link.delete'
import listRepositories from '../../server/api/ui/github/installations/[id]/repositories.get'

// Off by default, so this deployment reads as having no GitHub App; the sweep
// below turns it on to reach the link and sync routes.
const fake = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../server/github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  github: (() => fake.client) as typeof githubFn
}))

const ORG = 'ui-variables'
const PASSWORD = 'correct horse battery staple'
const CANARY = `sensitive-canary-${Date.now()}`
let admin: Record<string, string>
let adminId: string
let member: Record<string, string>
let projectId: string
let envId: string

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const a = await provisionUser(`uv-admin-${Date.now()}@example.com`, PASSWORD)
  const m = await provisionUser(`uv-member-${Date.now()}@example.com`, PASSWORD)
  adminId = a.id
  await setRole(a.id, 'admin')
  await setRole(m.id, 'member')
  await grantProjectRole(projectId, m.id, 'viewer')
  admin = Object.fromEntries((await signInHeaders(a.email, PASSWORD)).entries())
  member = Object.fromEntries((await signInHeaders(m.email, PASSWORD)).entries())
  const created = await createEnvironment(
    testEvent({ headers: admin, params: { id: projectId }, body: { slug: 'dev' } })
  )
  envId = created.id
  await putVariable(
    testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { value: CANARY } })
  )
  await putVariable(
    testEvent({
      headers: admin,
      params: { id: envId, name: 'region' },
      body: { value: 'eu', sensitive: false }
    })
  )
})

describe('environments', () => {
  it('lists for a member', async () => {
    const rows = await listEnvironments(testEvent({ headers: member, params: { id: projectId } }))
    expect(rows.map((r) => r.slug)).toEqual(['dev'])
  })
  it('404s for an unknown project', async () => {
    await expect(
      createEnvironment(testEvent({ headers: admin, params: { id: 'nope' }, body: { slug: 'x' } }))
    ).rejects.toMatchObject({ statusCode: 404 })
  })
  it('deletes', async () => {
    const tmp = await createEnvironment(
      testEvent({ headers: admin, params: { id: projectId }, body: { slug: 'tmp' } })
    )
    await deleteEnvironment(testEvent({ headers: admin, params: { id: tmp.id } }))
    const rows = await listEnvironments(testEvent({ headers: member, params: { id: projectId } }))
    expect(rows.map((r) => r.slug)).toEqual(['dev'])
  })
})

describe('variables', () => {
  it('lists rows with no status when nothing is linked', async () => {
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.link).toBeNull()
    expect(body.rows.map((r) => [r.name, r.status])).toEqual([
      ['pw', null],
      ['region', null]
    ])
    expect(body.rows.find((r) => r.name === 'region')?.value).toBe('eu')
  })

  it('names who last updated each row, and never ships the user id', async () => {
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.rows.find((r) => r.name === 'region')?.updatedByName).toBe('Test')
    expect(JSON.stringify(body)).not.toContain(adminId)
  })

  it('refuses a malformed name with 400', async () => {
    await expect(
      putVariable(
        testEvent({ headers: admin, params: { id: envId, name: '1bad' }, body: { value: 'x' } })
      )
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('keeps a sensitive value when an edit omits it', async () => {
    await putVariable(
      testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { description: 'd' } })
    )
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.rows.find((r) => r.name === 'pw')?.description).toBe('d')
  })

  it('deletes, and 404s the second time', async () => {
    await putVariable(
      testEvent({ headers: admin, params: { id: envId, name: 'gone' }, body: { value: 1 } })
    )
    await deleteVariable(testEvent({ headers: admin, params: { id: envId, name: 'gone' } }))
    await expect(
      deleteVariable(testEvent({ headers: admin, params: { id: envId, name: 'gone' } }))
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('previews an import', async () => {
    const preview = await importVariables(
      testEvent({
        headers: admin,
        params: { id: envId },
        body: { values: { region: 'us', fresh: 1 }, dryRun: true }
      })
    )
    expect(preview).toEqual({ created: ['fresh'], overwritten: ['region'] })
  })

  it('imports HCL and reports an expression with its line', async () => {
    const preview = await importVariables(
      testEvent({
        headers: admin,
        params: { id: envId },
        body: { hcl: 'zone = "a"\n', dryRun: true }
      })
    )
    expect(preview.created).toContain('zone')
    await expect(
      importVariables(
        testEvent({
          headers: admin,
          params: { id: envId },
          body: { hcl: 'a = 1\nb = var.x\n', dryRun: true }
        })
      )
    ).rejects.toMatchObject({ statusCode: 400, statusMessage: expect.stringContaining('tfvars:2') })
  })
})

/**
 * The write-only promise (variables spec §7), checked across every UI read
 * route rather than one: a sensitive value must not appear in any of them,
 * raw or sealed, nor in the audit rows the writes leave behind.
 */
describe('sensitive values never leave through the UI', () => {
  const INSTALLATION = 9_200_002
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  const files: Record<string, unknown> = {
    [`/app/installations/${INSTALLATION}/access_tokens`]: {
      token: 't',
      expires_at: new Date(Date.now() + 3_600_000).toISOString()
    },
    '/installation/repositories': {
      total_count: 1,
      repositories: [{ id: 66, full_name: 'acme/vars', default_branch: 'main' }]
    },
    '/repos/acme/vars/contents/': [{ type: 'file', name: 'v.tf', path: 'v.tf' }]
  }
  const githubFake = new GitHubClient(
    { id: '1', slug: 'statesman', privateKey, webhookSecret: 'x' },
    async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/repos/acme/vars/commits/main') return new Response('sha-sweep')
      if (path === '/repos/acme/vars/contents/v.tf')
        return new Response('variable "pw" {\n  sensitive = true\n}\n')
      if (path in files) return Response.json(files[path])
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }
  )

  it('appears in no UI response or audit row', async () => {
    fake.client = githubFake
    await recordInstallation(INSTALLATION, 'acme')
    const scratch = await createEnvironment(
      testEvent({ headers: admin, params: { id: projectId }, body: { slug: 'sweep' } })
    )
    await putVariable(
      testEvent({
        headers: admin,
        params: { id: scratch.id, name: 'doomed' },
        body: { value: CANARY }
      })
    )
    const responses = [
      scratch,
      await listEnvironments(testEvent({ headers: admin, params: { id: projectId } })),
      await listVariables(testEvent({ headers: admin, params: { id: envId } })),
      await putLink(
        testEvent({
          headers: admin,
          params: { id: envId },
          body: { installationId: INSTALLATION, repoId: 66 }
        })
      ),
      await syncNow(testEvent({ headers: admin, params: { id: envId } })),
      await listVariables(testEvent({ headers: admin, params: { id: envId } })),
      await githubStatus(testEvent({ headers: admin })),
      await listRepositories(testEvent({ headers: admin, params: { id: String(INSTALLATION) } })),
      await unlink(testEvent({ headers: admin, params: { id: envId } })),
      await deleteVariable(
        testEvent({ headers: admin, params: { id: scratch.id, name: 'doomed' } })
      ),
      await deleteEnvironment(testEvent({ headers: admin, params: { id: scratch.id } })),
      await putVariable(
        testEvent({ headers: admin, params: { id: envId, name: 'pw' }, body: { value: CANARY } })
      ),
      await importVariables(
        testEvent({
          headers: admin,
          params: { id: envId },
          body: { values: { pw: CANARY }, dryRun: true }
        })
      ),
      await importVariables(
        testEvent({
          headers: admin,
          params: { id: envId },
          body: { values: { pw: CANARY }, dryRun: false }
        })
      )
    ]
    fake.client = null
    // The sweep reached the routes it names, rather than each throwing early.
    expect(responses[3]).toMatchObject({ ok: true })
    expect(responses[6]).toMatchObject({ configured: true })
    const audit = await db().select().from(auditLog).where(eq(auditLog.projectId, projectId))
    expect(audit.length).toBeGreaterThan(0)
    const text = JSON.stringify([responses, audit])
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain(Buffer.from(CANARY).toString('base64'))
  })
})

describe('github status and declared variables', () => {
  it('reports GitHub as not configured', async () => {
    expect(await githubStatus(testEvent({ headers: member }))).toEqual({
      configured: false,
      installUrl: null,
      installations: []
    })
  })

  it('merges a synced declared set into the variables rows', async () => {
    await recordInstallation(9_200_001, 'acme')
    await linkRepository({
      environmentId: envId,
      installationId: 9_200_001,
      repoId: 77,
      repoFullName: 'acme/infra',
      ref: 'main',
      directory: ''
    })
    await db()
      .update(repositoryLink)
      .set({
        declared: [
          {
            name: 'needed',
            typeExpr: 'string',
            hasDefault: false,
            sensitive: false,
            description: null,
            file: 'v.tf',
            line: 1
          }
        ],
        lastSyncedSha: 'abc'
      })
      .where(eq(repositoryLink.environmentId, envId))
    const body = await listVariables(testEvent({ headers: member, params: { id: envId } }))
    expect(body.link).toMatchObject({ repoFullName: 'acme/infra', lastSyncedSha: 'abc' })
    expect(body.rows[0]).toMatchObject({ name: 'needed', status: 'missing' })
  })
})
