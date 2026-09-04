import { auth } from '../../utils/auth'
import { db } from '../../db/client'
import { project } from '../../db/schema'
import { runRetention } from '../../services/retention'
import { mapWithConcurrency } from '../../utils/concurrency'

/**
 * Each sweep lists the whole storage prefix and issues its own deletes, so the
 * fan-out width here is the project count — data, not a constant. Four at a
 * time keeps the pass parallel enough to finish quickly on a large deployment
 * without letting the blob store or the Postgres pool see hundreds of
 * simultaneous callers.
 */
const RETENTION_CONCURRENCY = 4

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })

  const projects = await db().select({ id: project.id }).from(project)
  const results = await mapWithConcurrency(projects, RETENTION_CONCURRENCY, (p) =>
    runRetention(p.id)
  )
  return {
    prunedVersions: results.reduce((sum, r) => sum + r.prunedVersions, 0),
    sweptBlobs: results.reduce((sum, r) => sum + r.sweptBlobs, 0)
  }
})
