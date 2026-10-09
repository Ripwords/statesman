import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { requireAdmin } from '../../utils/ui-auth'
import { requireGitHub, viaGitHub } from '../../utils/github-guard'
import { recordInstallation } from '../../services/sync'
import { recordAuditBestEffort } from '../../services/audit'
import { deploymentOrgId } from '../../utils/deployment-org'

const STATE_COOKIE = 'statesman_gh_state'
const querySchema = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.string().optional(),
  state: z.string().optional()
})

/**
 * GitHub's redirect after an install. Two checks before anything is stored:
 * the state cookie proves this browser started the install here, and asking
 * GitHub about the id with the app's own JWT proves the installation exists and
 * belongs to this app — a forged id fails the second.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  // Read and clear first: the state is single-use even when the callback is malformed.
  const expected = getCookie(event, STATE_COOKIE) ?? ''
  deleteCookie(event, STATE_COOKIE, { path: '/api/github' })
  const query = await getValidatedQuery(event, querySchema.parse)
  // An org member asked for the app and an owner has yet to approve: nothing to record.
  if (query.setup_action === 'request' && query.installation_id === undefined) {
    return sendRedirect(event, '/?github=requested')
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(query.state ?? '')
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'The install link expired or did not start here. Try Connect GitHub again.'
    })
  }
  if (query.installation_id === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'GitHub did not send an installation id.' })
  }
  const id = query.installation_id
  const installation = await viaGitHub(() => client.getInstallation(id))
  await recordInstallation(installation.id, installation.accountLogin)
  await recordAuditBestEffort({
    orgId: await deploymentOrgId(),
    actorType: 'user',
    actorId: session.userId,
    action: 'github.install',
    meta: { installationId: installation.id, account: installation.accountLogin }
  })
  return sendRedirect(event, '/?github=connected')
})
