import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { project, organization } from '../../db/schema'
import { RollbackError, rollbackTo } from '../../services/state'
import { recordAuditBestEffort } from '../../services/audit'
import { requireSession } from '../../utils/ui-auth'

const bodySchema = z.object({ projectId: z.string().min(1), versionId: z.string().min(1) })

export default defineEventHandler(async (event) => {
  // requireSession, not a second inline copy of it: the two had already drifted
  // and the guard is the only thing between a stranger and every project.
  const session = await requireSession(event)

  // 400 is the right status for a malformed body, so h3's rewrite of any
  // validator throw into "400 Validation Error" is exactly what we want here
  // and needs no wrapping (CARRY-FORWARD §7c).
  const input = await readValidatedBody(event, bodySchema.parse)

  const rows = await db()
    .select({ orgId: project.orgId, orgSlug: organization.slug, projectSlug: project.slug })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(eq(project.id, input.projectId))
  const target = rows[0]
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Unknown project' })

  try {
    const result = await rollbackTo({
      projectId: input.projectId,
      orgSlug: target.orgSlug,
      projectSlug: target.projectSlug,
      versionId: input.versionId,
      userId: session.userId
    })
    // The rollback version is already written; a 500 here would invite the
    // operator to click again and write a third identical version.
    await recordAuditBestEffort({
      orgId: target.orgId,
      projectId: input.projectId,
      actorType: 'user',
      actorId: session.userId,
      action: 'state.rollback',
      meta: { from: input.versionId, to: result.versionId }
    })
    return result
  } catch (error) {
    // Only the two modelled failures are translated. Anything else — a storage
    // or database fault — propagates as a 500, which is what spec §11 asks for
    // and what the old catch-all silently reported as 404.
    if (error instanceof RollbackError) {
      throw createError({
        statusCode: error.reason === 'locked' ? 409 : 404,
        statusMessage: error.message
      })
    }
    throw error
  }
})
