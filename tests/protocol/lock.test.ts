import { describe, it, expect, beforeEach } from 'vitest'
import { acquireLock, releaseLock, forceReleaseLock, currentLock } from '../../server/services/lock'
import { seedProject, resetDb } from './helpers'

const info = (id: string) => ({ ID: id, Who: 'jj@laptop', Operation: 'OperationTypeApply' })

// This suite owns this organization slug; see resetDb in ./helpers.
const ORG = 'lock-suite'

let projectId: string

beforeEach(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'prod')
})

describe('locking', () => {
  it('acquires a free lock', async () => {
    expect(await acquireLock(projectId, info('lock-1'))).toEqual({ ok: true })
  })

  it('refuses a held lock and reports the holder', async () => {
    await acquireLock(projectId, info('lock-1'))
    const result = await acquireLock(projectId, info('lock-2'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.held.ID).toBe('lock-1')
  })

  it('gives the lock to exactly one of many concurrent callers', async () => {
    const attempts = Array.from({ length: 20 }, (_, i) => acquireLock(projectId, info(`c-${i}`)))
    const results = await Promise.all(attempts)
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('releases with the matching id', async () => {
    await acquireLock(projectId, info('lock-1'))
    expect(await releaseLock(projectId, 'lock-1')).toBe(true)
    expect(await currentLock(projectId)).toBeNull()
  })

  it('refuses to release with a mismatched id', async () => {
    await acquireLock(projectId, info('lock-1'))
    expect(await releaseLock(projectId, 'wrong')).toBe(false)
    expect((await currentLock(projectId))?.ID).toBe('lock-1')
  })

  it('force-releases regardless of id', async () => {
    await acquireLock(projectId, info('lock-1'))
    await forceReleaseLock(projectId)
    expect(await currentLock(projectId)).toBeNull()
  })

  it('is re-acquirable after release', async () => {
    await acquireLock(projectId, info('lock-1'))
    await releaseLock(projectId, 'lock-1')
    expect(await acquireLock(projectId, info('lock-2'))).toEqual({ ok: true })
  })
})
