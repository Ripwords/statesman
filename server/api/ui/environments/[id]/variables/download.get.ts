import { z } from 'zod'
import { requireSession } from '../../../../../utils/ui-auth'
import {
  projectIdOfEnvironment,
  requireProjectPermission
} from '../../../../../utils/project-access'
import { environmentContext, readDeliveryValues } from '../../../../../services/variables'
import { recordAuditBestEffort } from '../../../../../services/audit'
import { toTfvars } from '../../../../../hcl/tfvars'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * The environment as a `.tfvars` file, for someone about to run
 * `terraform apply` by hand. The one route that hands sensitive values to the
 * browser, so it needs what a token reading them needs from its creator: owner
 * (project-access spec §7).
 */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const session = await requireProjectPermission(
    event,
    await projectIdOfEnvironment(id),
    'variable:download'
  )
  const ctx = await environmentContext(id)
  const values = await readDeliveryValues(id)
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'variables.download',
    meta: { environment: ctx.slug, count: Object.keys(values).length }
  })
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'attachment; filename="statesman.auto.tfvars"')
  return toTfvars(values)
})
