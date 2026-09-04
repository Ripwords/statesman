import { testEvent } from './nitro-globals'
import { describe, expect, it } from 'vitest'
import projectsHandler from '../../server/api/ui/projects.get'
import versionsHandler from '../../server/api/ui/projects/[id]/versions.get'
import lockHandler from '../../server/api/ui/projects/[id]/lock.delete'
import versionHandler from '../../server/api/ui/versions/[id].get'

/**
 * The brief drives these through `@nuxt/test-utils/e2e`. That package is not a
 * dependency of this repo and package.json is frozen, so the handlers are
 * invoked directly instead. The property under test is unchanged and still
 * real: `requireSession` calls Better Auth against the live database, and an
 * anonymous request must be refused with 401 before any parameter is read.
 */
describe('dashboard api', () => {
  it('rejects an unauthenticated project list', async () => {
    await expect(projectsHandler(testEvent())).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated version list', async () => {
    await expect(
      versionsHandler(testEvent({ params: { id: 'p1' } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated version read', async () => {
    await expect(
      versionHandler(testEvent({ params: { id: '01ABC' } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated force-unlock', async () => {
    await expect(
      lockHandler(testEvent({ params: { id: 'p1' } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses before validating the route parameter, so a bad id is still 401', async () => {
    await expect(
      lockHandler(testEvent({ params: {} }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
