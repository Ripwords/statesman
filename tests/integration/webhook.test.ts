import { testEvent } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'
import { createEnvironment } from '../../server/services/variables'
import {
  recordInstallation,
  linkRepository,
  linkSummary,
  listInstallations
} from '../../server/services/sync'
import { handleWebhook, type AuditEvent } from '../../server/github/webhook'
import { GitHubClient } from '../../server/github/client'
import { createHclToolkit, type HclToolkit } from '../../server/hcl/toolkit'

void testEvent

const ORG = 'webhook'
// Distinct from every other suite's ids: the files share one database and run in parallel.
const INSTALLATION = 9_400_001
const SECRET = 'whsec'
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()
let hcl: HclToolkit
let envId: string
let projectId: string
const fetched: string[] = []

const client = new GitHubClient(
  { id: '1', slug: 's', privateKey: pem, webhookSecret: SECRET },
  async (input) => {
    const p = new URL(String(input)).pathname
    fetched.push(p)
    if (p === '/repos/acme/infra/contents/offline') throw new TypeError('fetch failed')
    if (p === '/repos/acme/infra/contents/broken')
      return new Response(JSON.stringify([{ type: 'file', name: 'v.tf', path: 'broken/v.tf' }]))
    if (p === '/repos/acme/infra/contents/broken/v.tf') return new Response('variable "x" {}\n')
    if (p.endsWith('/access_tokens'))
      return new Response(
        JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201 }
      )
    if (p === '/repos/acme/infra/commits/main') return new Response('sha-2')
    if (p === '/repos/acme/infra/contents/')
      return new Response(JSON.stringify([{ type: 'file', name: 'v.tf', path: 'v.tf' }]))
    if (p === '/repos/acme/infra/contents/v.tf') return new Response('variable "from_push" {}\n')
    return new Response('{"message":"Not Found"}', { status: 404 })
  }
)

const deliver = (
  event: string,
  payload: unknown,
  secret = SECRET,
  audit?: (event: AuditEvent) => Promise<void>
) => {
  const rawBody = Buffer.from(JSON.stringify(payload))
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
  // A parser fault in `broken/` stands in for any failure that is not GitHub's:
  // syncEnvironment rethrows those instead of recording them.
  const flaky: HclToolkit = {
    ...hcl,
    extractVariables: (source, file) => {
      if (file.startsWith('broken/')) throw new Error('unexpected')
      return hcl.extractVariables(source, file)
    }
  }
  return handleWebhook(
    { event, signature, rawBody },
    { secret: SECRET, sync: { client, hcl: flaky }, audit }
  )
}

beforeAll(async () => {
  hcl = await createHclToolkit(async (name) => readFileSync(join('server/assets/wasm', name)))
})

beforeEach(async () => {
  await resetDb(ORG)
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
  projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  await recordInstallation(INSTALLATION, 'acme')
  await linkRepository({
    environmentId: envId,
    installationId: INSTALLATION,
    repoId: 88,
    repoFullName: 'acme/infra',
    ref: 'main',
    directory: ''
  })
})

describe('handleWebhook', () => {
  it('refuses a bad signature with 401 and does nothing', async () => {
    const result = await deliver(
      'push',
      { ref: 'refs/heads/main', repository: { id: 88, full_name: 'acme/infra' } },
      'wrong'
    )
    expect(result).toEqual({ status: 401, synced: [] })
    expect((await linkSummary(envId))?.declared).toBeNull()
  })

  it('syncs every environment linked to the pushed branch', async () => {
    const result = await deliver('push', {
      ref: 'refs/heads/main',
      repository: { id: 88, full_name: 'acme/infra' }
    })
    expect(result).toEqual({ status: 202, synced: [envId] })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['from_push'])
  })

  it('records a network failure on the link instead of dropping it', async () => {
    const offline = (await createEnvironment(projectId, 'off')).id
    await linkRepository({
      environmentId: offline,
      installationId: INSTALLATION,
      repoId: 88,
      repoFullName: 'acme/infra',
      ref: 'main',
      directory: 'offline'
    })
    const result = await deliver('push', {
      ref: 'refs/heads/main',
      repository: { id: 88, full_name: 'acme/infra' }
    })
    expect(result.synced).toContain(offline)
    expect((await linkSummary(offline))?.summary.lastSyncError).toBe('Could not reach GitHub.')
  })

  it('ignores a push to another branch or a tag', async () => {
    expect(
      (
        await deliver('push', {
          ref: 'refs/heads/dev',
          repository: { id: 88, full_name: 'acme/infra' }
        })
      ).synced
    ).toEqual([])
    expect(
      (
        await deliver('push', {
          ref: 'refs/tags/main',
          repository: { id: 88, full_name: 'acme/infra' }
        })
      ).synced
    ).toEqual([])
  })

  it('follows a repository rename', async () => {
    await deliver('push', {
      ref: 'refs/heads/dev',
      repository: { id: 88, full_name: 'acme/infrastructure' }
    })
    expect((await linkSummary(envId))?.summary.repoFullName).toBe('acme/infrastructure')
  })

  it('drops links when the installation is deleted', async () => {
    await deliver('installation', { action: 'deleted', installation: { id: INSTALLATION } })
    expect(await linkSummary(envId)).toBeNull()
  })

  it('marks links when repository access is removed', async () => {
    await deliver('installation_repositories', {
      action: 'removed',
      installation: { id: INSTALLATION },
      repositories_removed: [{ id: 88 }]
    })
    expect((await linkSummary(envId))?.summary.lastSyncError).toMatch(/no longer has access/)
  })

  it('accepts and ignores other events', async () => {
    expect(await deliver('ping', { zen: 'hi' })).toEqual({ status: 202, synced: [] })
  })

  it('answers 400 to a signed body that is not JSON', async () => {
    const rawBody = Buffer.from('not json')
    const signature = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`
    expect(
      (
        await handleWebhook(
          { event: 'push', signature, rawBody },
          { secret: SECRET, sync: { client, hcl } }
        )
      ).status
    ).toBe(400)
  })

  it('reports an uninstall to the audit callback only for a verified delivery', async () => {
    let calls = 0
    const audit = async () => {
      calls++
    }
    await deliver(
      'installation',
      { action: 'deleted', installation: { id: INSTALLATION } },
      'wrong',
      audit
    )
    expect(calls).toBe(0)
    await deliver(
      'installation',
      { action: 'deleted', installation: { id: INSTALLATION } },
      SECRET,
      audit
    )
    expect(calls).toBe(1)
  })

  it('skips a branch deletion without calling GitHub', async () => {
    const before = fetched.length
    const repository = { id: 88, full_name: 'acme/infra' }
    expect(await deliver('push', { ref: 'refs/heads/main', deleted: true, repository })).toEqual({
      status: 202,
      synced: []
    })
    expect(
      await deliver('push', { ref: 'refs/heads/main', after: '0'.repeat(40), repository })
    ).toEqual({ status: 202, synced: [] })
    expect(fetched.length).toBe(before)
  })

  it('audits an uninstall once, not on a replayed or unknown delivery', async () => {
    let count = 0
    const audit = async () => {
      count++
    }
    const body = { action: 'deleted', installation: { id: INSTALLATION } }
    await deliver('installation', body, SECRET, audit)
    await deliver('installation', body, SECRET, audit)
    await deliver('installation', { action: 'deleted', installation: { id: 1 } }, SECRET, audit)
    expect(count).toBe(1)
  })

  it('keeps syncing the other environments when one fails unexpectedly', async () => {
    const second = (await createEnvironment(projectId, 'stg')).id
    await linkRepository({
      environmentId: second,
      installationId: INSTALLATION,
      repoId: 88,
      repoFullName: 'acme/infra',
      ref: 'main',
      directory: 'broken'
    })
    const result = await deliver('push', {
      ref: 'refs/heads/main',
      repository: { id: 88, full_name: 'acme/infra' }
    })
    expect(result).toEqual({ status: 202, synced: [envId] })
    expect((await linkSummary(envId))?.declared?.map((d) => d.name)).toEqual(['from_push'])
  })

  describe('records an installation GitHub reports', () => {
    const NEW = 9_400_003
    const body = (action: string, login = 'acme-org') => ({
      action,
      installation: { id: NEW, account: { login } }
    })
    const recorded = async () => (await listInstallations()).filter((i) => i.installationId === NEW)

    beforeEach(async () => {
      await db().delete(githubInstallation).where(eq(githubInstallation.installationId, NEW))
    })

    // An org owner approving a requested install has no statesman session, so
    // the Setup URL redirect cannot record it; the webhook is the only path.
    it.each(['created', 'unsuspend', 'new_permissions_accepted'])(
      'on %s, and audits it once',
      async (action) => {
        const events: AuditEvent[] = []
        const audit = async (event: AuditEvent) => {
          events.push(event)
        }
        expect((await deliver('installation', body(action), SECRET, audit)).status).toBe(202)
        await deliver('installation', body(action), SECRET, audit)
        expect(await recorded()).toEqual([{ installationId: NEW, accountLogin: 'acme-org' }])
        expect(events).toEqual([{ action: 'install', installationId: NEW, account: 'acme-org' }])
      }
    )

    it('follows an account rename on a repeated delivery', async () => {
      await deliver('installation', body('created'))
      await deliver('installation', body('new_permissions_accepted', 'acme-renamed'))
      expect(await recorded()).toEqual([{ installationId: NEW, accountLogin: 'acme-renamed' }])
    })

    it('records nothing for an unsigned delivery or one without an account', async () => {
      await deliver('installation', body('created'), 'wrong')
      await deliver('installation', { action: 'created', installation: { id: NEW } })
      expect(await recorded()).toEqual([])
    })

    it('records nothing for other actions', async () => {
      await deliver('installation', body('suspend'))
      expect(await recorded()).toEqual([])
    })
  })
})
