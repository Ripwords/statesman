import { z } from 'zod'
import { requireSession } from '../../../../../utils/ui-auth'
import {
  projectIdOfEnvironment,
  requireProjectPermission
} from '../../../../../utils/project-access'
import { deleteVariable, environmentContext } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { variableNameSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64), name: variableNameSchema })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id, name } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'variable:write'
  )
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
