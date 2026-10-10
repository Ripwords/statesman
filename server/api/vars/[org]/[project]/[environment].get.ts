import { authenticateTf, authorizeVars, requireCreatorAccess } from '../../../../utils/tf-auth'
import { resolveProject } from '../../../../utils/tf-handler'
import { findEnvironment, readDeliveryValues } from '../../../../services/variables'
import { recordAuditBestEffort } from '../../../../services/audit'
import { environmentRefSchema } from '../../../../../shared/schemas/project'
import { toTfvars } from '../../../../hcl/tfvars'

const FORMATS = ['json', 'tfvars'] as const
type Format = (typeof FORMATS)[number]
const isFormat = (value: unknown): value is Format => FORMATS.some((f) => f === value)

/**
 * Delivery (variables spec §5). The body is a `.tfvars.json` file, or with
 * `?format=tfvars` the same values as HCL for workflows that apply by hand. The
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
  await requireCreatorAccess(principal, resolved, 'vars:read')
  const found = await findEnvironment(resolved.id, params.environment)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Unknown environment' })

  // Checked after authorization, so a bad format teaches an outsider nothing.
  const format = getQuery(event).format ?? 'json'
  if (!isFormat(format)) {
    throw createError({ statusCode: 400, statusMessage: 'format must be json or tfvars' })
  }

  const values = await readDeliveryValues(found.id)
  setResponseHeader(event, 'cache-control', 'no-store')
  await recordAuditBestEffort({
    orgId: resolved.orgId,
    projectId: resolved.id,
    actorType: 'api-key',
    actorId: principal.keyId,
    action: 'variables.read',
    meta: { environment: params.environment, count: Object.keys(values).length, format }
  })
  if (format === 'json') return values
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return toTfvars(values)
})
