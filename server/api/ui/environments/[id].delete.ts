import { z } from 'zod'
import { requireAdmin } from '../../../utils/ui-auth'
import { deleteEnvironment, environmentContext } from '../../../services/variables'
import { recordAuditBestEffort } from '../../../services/audit'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  await deleteEnvironment(id)
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'environment.delete',
    meta: { environment: ctx.slug }
  })
  return { ok: true }
})
