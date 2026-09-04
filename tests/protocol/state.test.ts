import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { readCurrentState, writeState, purgeState, listVersions } from '../../server/services/state'
import { db } from '../../server/db/client'
import { stateVersion } from '../../server/db/schema'
import { store } from '../../server/storage'
import { seedProject, seedUser, resetDb } from './helpers'

const payload = (serial: number) =>
  Buffer.from(JSON.stringify({ version: 4, serial, lineage: 'abc', resources: [] }))

let projectId: string

beforeEach(async () => {
  await resetDb()
  await seedUser('u1')
  projectId = await seedProject('acme', 'prod')
})

describe('state service', () => {
  it('returns null before any state is written', async () => {
    expect(await readCurrentState(projectId)).toBeNull()
  })

  it('round-trips a written state', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    expect(await readCurrentState(projectId)).toEqual(payload(1))
  })

  it('keeps every version and moves the pointer', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(2), userId: 'u1' })
    expect(await listVersions(projectId)).toHaveLength(2)
    expect(await readCurrentState(projectId)).toEqual(payload(2))
  })

  it('never overwrites a blob key', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(2), userId: 'u1' })
    const rows = await db().select().from(stateVersion).where(eq(stateVersion.projectId, projectId))
    expect(new Set(rows.map((r) => r.blobKey)).size).toBe(2)
  })

  it('stores ciphertext, not plaintext', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    const rows = await db().select().from(stateVersion).where(eq(stateVersion.projectId, projectId))
    const row = rows[0]
    if (!row) throw new Error('expected a state_version row')
    const sealed = await store().get(row.blobKey)
    if (!sealed) throw new Error(`expected a blob at ${row.blobKey}`)
    const raw = Buffer.from(sealed)
    expect(raw.toString('utf8')).not.toContain('lineage')
  })

  it('records serial and lineage for display', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(7), userId: 'u1' })
    const [version] = await listVersions(projectId)
    expect(version?.serial).toBe(7)
    expect(version?.lineage).toBe('abc')
  })

  it('accepts state that is not valid JSON', async () => {
    const junk = Buffer.from('not json at all')
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: junk, userId: 'u1' })
    expect(await readCurrentState(projectId)).toEqual(junk)
  })

  it('purges state and clears the pointer', async () => {
    await writeState({ projectId, orgSlug: 'acme', projectSlug: 'prod', body: payload(1), userId: 'u1' })
    await purgeState(projectId)
    expect(await readCurrentState(projectId)).toBeNull()
  })
})
