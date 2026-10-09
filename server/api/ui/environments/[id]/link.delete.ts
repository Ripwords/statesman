import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { environmentContext } from '../../../../services/variables'
import { unlinkRepository } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/** Works without the app configured, so a deployment that dropped GitHub can still clean up. */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  if (!(await unlinkRepository(id)))
    throw createError({ statusCode: 404, statusMessage: 'This environment is not linked.' })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'repository.unlink',
    meta: { environment: ctx.slug }
  })
  return { ok: true }
})
