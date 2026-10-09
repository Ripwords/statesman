import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { environmentContext, importValues } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { importVariablesSchema } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, importVariablesSchema.parse)
  const ctx = await environmentContext(id)
  if (!('values' in input)) {
    throw createError({ statusCode: 400, statusMessage: 'HCL import is not available yet.' })
  }
  const result = await importValues({
    environmentId: id,
    values: input.values,
    userId: session.userId,
    dryRun: input.dryRun
  })
  if (!input.dryRun) {
    await recordAuditBestEffort({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      actorType: 'user',
      actorId: session.userId,
      action: 'variable.import',
      meta: {
        environment: ctx.slug,
        created: result.created.length,
        overwritten: result.overwritten.length
      }
    })
  }
  return result
})
