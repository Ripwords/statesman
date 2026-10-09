import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { environmentContext, setVariable } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { setVariableSchema, variableNameSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64), name: variableNameSchema })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id, name } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, setVariableSchema.parse)
  const ctx = await environmentContext(id)
  const outcome = await setVariable({ environmentId: id, name, input, userId: session.userId })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'variable.set',
    // Names and flags only: never the value (variables spec §10).
    meta: {
      environment: ctx.slug,
      name,
      sensitive: input.sensitive,
      outcome,
      valueChanged: input.value !== undefined
    }
  })
  return { name, outcome }
})
