// Must stay first: stands up the Nitro globals (createError) before sync.ts loads.
import { testEvent } from '../ui/nitro-globals'
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { githubInstallation } from '../../server/db/schema'
import { resetDb, seedProject } from '../protocol/helpers'
import { createEnvironment } from '../../server/services/variables'
import {
  recordInstallation,
  removeInstallation,
  linkRepository,
  unlinkRepository,
  linkSummary,
  normaliseDirectory
} from '../../server/services/sync'

void testEvent

const ORG = 'sync-service'
// Installation ids are global, so each suite picks its own range.
const INSTALLATION = 9_100_001
let envId: string

beforeEach(async () => {
  await resetDb(ORG)
  await db().delete(githubInstallation).where(eq(githubInstallation.installationId, INSTALLATION))
  const projectId = await seedProject(ORG, 'p')
  envId = (await createEnvironment(projectId, 'dev')).id
  await recordInstallation(INSTALLATION, 'acme')
})

const link = (over: Partial<Parameters<typeof linkRepository>[0]> = {}) =>
  linkRepository({
    environmentId: envId,
    installationId: INSTALLATION,
    repoId: 55,
    repoFullName: 'acme/infra',
    ref: 'main',
    directory: 'envs/dev',
    ...over
  })

describe('normaliseDirectory', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['/envs/dev/', 'envs/dev'],
    ['envs//dev', 'envs/dev']
  ])('%j -> %j', (input, output) => {
    expect(normaliseDirectory(input)).toBe(output)
  })
  it('refuses parent segments', () => {
    expect(() => normaliseDirectory('envs/../secrets')).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })
})

describe('links', () => {
  it('records an installation idempotently', async () => {
    await recordInstallation(INSTALLATION, 'acme')
    const rows = await db()
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.installationId, INSTALLATION))
    expect(rows).toHaveLength(1)
  })

  it('links, relinks, and summarises without a sync', async () => {
    await link()
    await link({ ref: 'release' })
    const found = await linkSummary(envId)
    expect(found?.summary).toMatchObject({
      repoFullName: 'acme/infra',
      ref: 'release',
      lastSyncedAt: null
    })
    expect(found?.declared).toBeNull()
  })

  it('unlinks', async () => {
    await link()
    expect(await unlinkRepository(envId)).toBe(true)
    expect(await linkSummary(envId)).toBeNull()
  })

  it('drops links when the installation is removed', async () => {
    await link()
    await removeInstallation(INSTALLATION)
    expect(await linkSummary(envId)).toBeNull()
  })
})
