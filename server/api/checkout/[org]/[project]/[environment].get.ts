import { authenticateTf, authorizeVars, requireCreatorAccess } from '../../../../utils/tf-auth'
import { resolveProject } from '../../../../utils/tf-handler'
import { findEnvironment, readBackend, readDeliveryValues } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { environmentRefSchema } from '../../../../../shared/schemas/project'
import type { CheckoutResponse } from '../../../../../shared/schemas/backend'

/**
 * What `statesman pull` needs for one environment (checkout spec §4): the
 * variables /api/vars delivers plus the backend settings. Same door, same
 * order of checks, no new token permission.
 */
export default defineEventHandler(async (event): Promise<CheckoutResponse> => {
  const principal = await authenticateTf(event)

  let params: { org: string; project: string; environment: string }
  try {
    params = await getValidatedRouterParams(event, environmentRefSchema.parse)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  }
  const ref = { org: params.org, project: params.project }
  const resolved = await resolveProject(ref)
  authorizeVars(principal, ref)
  await requireCreatorAccess(principal, resolved, 'vars:read')
  const found = await findEnvironment(resolved.id, params.environment)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })

  const [variables, backend] = await Promise.all([
    readDeliveryValues(found.id),
    readBackend(found.id)
  ])
  setResponseHeader(event, 'cache-control', 'no-store')
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'checkout.read',
    meta: { environment: params.environment, count: Object.keys(variables).length }
  })
  return { variables, backend }
})
