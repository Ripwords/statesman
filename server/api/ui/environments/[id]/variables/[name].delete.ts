import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { deleteVariable, environmentContext } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { variableNameSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64), name: variableNameSchema })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id, name } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  if (!(await deleteVariable(id, name))) {
    throw createError({ statusCode: 404, statusMessage: `No variable named ${name}` })
  }
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'variable.delete',
    meta: { environment: ctx.slug, name }
  })
  return { ok: true }
})
