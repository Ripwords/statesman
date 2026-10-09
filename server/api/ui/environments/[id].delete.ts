import { z } from 'zod'
import { requireSession } from '../../../utils/ui-auth'
import { projectIdOfEnvironment, requireProjectPermission } from '../../../utils/project-access'
import { deleteEnvironment, environmentContext } from '../../../services/variables'
import { recordAuditBestEffort } from '../../../services/audit'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'environment:delete'
  )
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
