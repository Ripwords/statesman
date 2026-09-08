import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { db } from '../../../../db/client'
import { auditLog, project, stateLock } from '../../../../db/schema'
import { requireAdmin } from '../../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * Force-unlock (spec §9). Always audited: dropping someone else's lock is the
 * one dashboard action that can corrupt state, so it has to leave a trace.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  const rows = await db().select({ orgId: project.orgId }).from(project).where(eq(project.id, id))
  const orgId = rows[0]?.orgId
  if (!orgId) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Unknown project. Check the project id and try again.'
    })
  }

  await db().delete(stateLock).where(eq(stateLock.projectId, id))
  await db().insert(auditLog).values({
    id: ulid(),
    orgId,
    projectId: id,
    actorType: 'user',
    actorId: session.userId,
    action: 'lock.force_release',
    metaJson: null
  })
  return { ok: true }
})
