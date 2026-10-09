import { testEvent } from './nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { provisionUser, signInHeaders, setRole, resetDb, seedProject } from '../protocol/helpers'
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
  it('appears in no UI response or audit row', async () => {
    const responses = [
      await listEnvironments(testEvent({ headers: admin, params: { id: projectId } })),
      await listVariables(testEvent({ headers: admin, params: { id: envId } })),
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
