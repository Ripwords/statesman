import { authenticateTf, authorizeVars } from '../../../../utils/tf-auth'
import { resolveProject } from '../../../../utils/tf-handler'
import { findEnvironment, readDeliveryValues } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { environmentRefSchema } from '../../../../../shared/schemas/project'

/**
 * Delivery (variables spec §5). The body is a `.tfvars.json` file, and the
 * order of checks is the state door's: credentials before anything touches the
 * database, existence before authorization.
 */
export default defineEventHandler(async (event) => {
  const principal = await authenticateTf(event)

  let params: { org: string; project: string; environment: string }
  try {
    params = await getValidatedRouterParams(event, environmentRefSchema.parse)
  } catch {
    // Same reasoning as refFromEvent: h3 turns any validator throw into 400,
    // and a slug that cannot exist is an unknown address, which is 404.
    throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })
  }
  const ref = { org: params.org, project: params.project }
  const resolved = await resolveProject(ref)
  // Authorize before looking the environment up, so a token that may not read
  // variables cannot use 403 versus 404 to learn which environments exist.
  authorizeVars(principal, ref)
  const found = await findEnvironment(resolved.id, params.environment)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })

  const values = await readDeliveryValues(found.id)
  setResponseHeader(event, 'cache-control', 'no-store')
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'variables.read',
    meta: { environment: params.environment, count: Object.keys(values).length }
  })
  return values
})
