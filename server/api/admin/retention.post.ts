import { auth } from '../../utils/auth'
import { db } from '../../db/client'
import { project } from '../../db/schema'
import { runRetention } from '../../services/retention'

export default defineEventHandler(async (event) => {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session) throw createError({ statusCode: 401, statusMessage: 'Sign in required' })

  const projects = await db().select({ id: project.id }).from(project)
  const results = await Promise.all(projects.map((p) => runRetention(p.id)))
  return {
    prunedVersions: results.reduce((sum, r) => sum + r.prunedVersions, 0),
    sweptBlobs: results.reduce((sum, r) => sum + r.sweptBlobs, 0)
  }
})
