import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { requireGitHub } from '../../../../utils/github-guard'
import { environmentContext } from '../../../../services/variables'
import { linkSummary, syncEnvironment } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  if (!(await linkSummary(id)))
    throw createError({
      statusCode: 404,
      statusMessage: 'This environment is not linked to a repository.'
    })
  const result = await syncEnvironment(id, { client, hcl: await hcl() })
  if (!result.ok) {
    await recordAuditBestEffort({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      actorType: 'user',
      actorId: session.userId,
      action: 'repository.sync_failed',
      meta: { environment: ctx.slug, error: result.error }
    })
  }
  return result
})
