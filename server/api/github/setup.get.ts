import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { requireAdmin } from '../../utils/ui-auth'
import { requireGitHub } from '../../utils/github-guard'
import { recordInstallation } from '../../services/sync'
import { recordAuditBestEffort } from '../../services/audit'
import { deploymentOrgId } from '../../utils/deployment-org'

const querySchema = z.object({
  installation_id: z.coerce.number().int().positive(),
  state: z.string().min(1)
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
  const query = await getValidatedQuery(event, querySchema.parse)
  const expected = getCookie(event, 'statesman_gh_state') ?? ''
  deleteCookie(event, 'statesman_gh_state', { path: '/api/github' })
  const a = Buffer.from(expected)
  const b = Buffer.from(query.state)
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'The install link expired or did not start here. Try Connect GitHub again.'
    })
  }
  const installation = await client.getInstallation(query.installation_id)
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
