import { describe, it, expect, beforeEach } from 'vitest'
import { writeState, readCurrentState, listVersions, rollbackTo } from '../../server/services/state'
import { acquireLock } from '../../server/services/lock'
import { seedProject, seedUser, resetDb } from './helpers'

// This suite owns this organization slug; see resetDb in ./helpers.
const ORG = 'rollback-suite'

let projectId: string
const body = (n: number) => Buffer.from(JSON.stringify({ version: 4, serial: n }))

beforeEach(async () => {
  await resetDb(ORG)
  await seedUser('u')
  projectId = await seedProject(ORG, 'prod')
})

async function firstVersionId(): Promise<string> {
  const versions = await listVersions(projectId)
  const first = versions[0]
  if (!first) throw new Error('expected at least one state version')
  return first.id
}

describe('rollback', () => {
  it('restores an older version as the current state', async () => {
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(1), userId: 'u' })
    const first = await firstVersionId()
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(2), userId: 'u' })

    await rollbackTo({ projectId, orgSlug: ORG, projectSlug: 'prod', versionId: first, userId: 'u' })
    expect(await readCurrentState(projectId)).toEqual(body(1))
  })

  it('appends rather than rewriting history', async () => {
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(1), userId: 'u' })
    const first = await firstVersionId()
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(2), userId: 'u' })

    await rollbackTo({ projectId, orgSlug: ORG, projectSlug: 'prod', versionId: first, userId: 'u' })
    expect(await listVersions(projectId)).toHaveLength(3)
  })

  it('refuses to roll back while the state is locked', async () => {
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(1), userId: 'u' })
    const first = await firstVersionId()
    await acquireLock(projectId, { ID: 'held', Who: 'someone' })

    await expect(
      rollbackTo({ projectId, orgSlug: ORG, projectSlug: 'prod', versionId: first, userId: 'u' })
    ).rejects.toThrow(/locked/i)
  })

  it('rejects an unknown version id', async () => {
    await expect(
      rollbackTo({ projectId, orgSlug: ORG, projectSlug: 'prod', versionId: 'nope', userId: 'u' })
    ).rejects.toThrow(/not found/i)
  })
})
