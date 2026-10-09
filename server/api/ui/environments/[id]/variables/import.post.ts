import { z } from 'zod'
import { requireSession } from '../../../../../utils/ui-auth'
import {
  projectIdOfEnvironment,
  requireProjectPermission
} from '../../../../../utils/project-access'
import { environmentContext, importValues } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { hcl } from '../../../../../hcl'
import { HclError } from '../../../../../hcl/toolkit'
import { importVariablesSchema, type JsonValue } from '../../../../../../shared/schemas/variable'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'variable:write'
  )
  const input = await readValidatedBody(event, importVariablesSchema.parse)
  const ctx = await environmentContext(id)
  let values: Record<string, JsonValue>
  if ('values' in input) {
    values = input.values
  } else {
    try {
      values = (await hcl()).parseTfvars(input.hcl)
    } catch (error) {
      if (error instanceof HclError)
        throw createError({ statusCode: 400, statusMessage: error.message })
      throw error
    }
    // Names from HCL have not been through the shared schema yet.
    const checked = importVariablesSchema.safeParse({ dryRun: input.dryRun, values })
    if (!checked.success || !('values' in checked.data)) {
      throw createError({
        statusCode: 400,
        statusMessage: checked.error?.issues[0]?.message ?? 'Invalid variables'
      })
    }
    values = checked.data.values
  }
  const result = await importValues({
    environmentId: id,
    values,
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
