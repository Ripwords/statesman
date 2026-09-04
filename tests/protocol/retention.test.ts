import { describe, it, expect, beforeEach } from 'vitest'
import { runRetention } from '../../server/services/retention'
import { writeState, listVersions, readCurrentState } from '../../server/services/state'
import { store } from '../../server/storage'
import { ulid } from 'ulid'
import { db } from '../../server/db/client'
import { stateVersion } from '../../server/db/schema'
import { seedProject, seedUser, resetDb } from './helpers'

// This suite owns this organization slug; see resetDb in ./helpers.
const ORG = 'retention-suite'

let projectId: string
const body = (n: number) => Buffer.from(JSON.stringify({ version: 4, serial: n }))

beforeEach(async () => {
  await resetDb(ORG)
  await seedUser('u')
  projectId = await seedProject(ORG, 'prod')
})

/**
 * writeState always stamps createdAt = now, so a version old enough to prune
 * has to be inserted directly. The blob is filler: nothing decrypts it, the
 * sweep only cares that a row claims the key.
 */
async function seedOldVersion(index: number): Promise<void> {
  const id = ulid()
  const key = `${ORG}/prod/${id}.tfstate.enc`
  await store().put(key, new Uint8Array([index % 256]))
  await db().insert(stateVersion).values({
    id,
    projectId,
    serial: index,
    lineage: 'old',
    sizeBytes: 1,
    md5: 'x',
    blobKey: key,
    createdBy: 'u',
    createdAt: new Date(Date.now() - 60 * 86_400_000 - index * 60_000)
  })
}

describe('retention', () => {
  it('keeps everything below the version threshold', async () => {
    for (let i = 1; i <= 5; i++) {
      await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(i), userId: 'u' })
    }
    await runRetention(projectId)
    expect(await listVersions(projectId)).toHaveLength(5)
  })

  it('never prunes the current version', async () => {
    for (let i = 1; i <= 3; i++) {
      await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(i), userId: 'u' })
    }
    await runRetention(projectId)
    expect(await readCurrentState(projectId)).toEqual(body(3))
  })

  it('sweeps a blob with no version row', async () => {
    await store().put(`${ORG}/prod/ORPHAN.tfstate.enc`, new Uint8Array([1, 2, 3]))
    const result = await runRetention(projectId)
    expect(result.sweptBlobs).toBe(1)
    expect(await store().get(`${ORG}/prod/ORPHAN.tfstate.enc`)).toBeNull()
  })

  it('prunes versions that are both beyond the count and past the window', async () => {
    // One current version stamped now, then 104 versions from 60 days ago.
    await writeState({ projectId, orgSlug: ORG, projectSlug: 'prod', body: body(9), userId: 'u' })
    for (let i = 1; i <= 104; i++) await seedOldVersion(i)

    const result = await runRetention(projectId)

    // RETENTION_KEEP_VERSIONS=100: indexes 100-104 in newest-first order are
    // the only rows that are past BOTH the count and the 30-day window.
    expect(result.prunedVersions).toBe(5)
    expect(result.sweptBlobs).toBe(0)
    // An explicit limit above the expected count: listVersions defaults to
    // limit 100, which cannot tell 100 remaining from 150 remaining.
    expect(await listVersions(projectId, 500)).toHaveLength(100)
    expect(await readCurrentState(projectId)).toEqual(body(9))
  })
})
