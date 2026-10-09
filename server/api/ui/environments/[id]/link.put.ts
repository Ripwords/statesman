import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { requireGitHub } from '../../../../utils/github-guard'
import { environmentContext } from '../../../../services/variables'
import { linkRepository, syncEnvironment } from '../../../../services/sync'
import { recordAuditBestEffort } from '../../../../services/audit'
import { hcl } from '../../../../hcl'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })
export const linkInputSchema = z.object({
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
  ref: z.string().min(1).max(255).optional(),
  directory: z.string().max(1024).default('')
})

export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, linkInputSchema.parse)
  const ctx = await environmentContext(id)
  // The repo list comes from GitHub, not the request, so a link can only name
  // a repository this installation can actually read.
  const repo = (await client.listRepositories(input.installationId)).find(
    (r) => r.id === input.repoId
  )
  if (!repo)
    throw createError({
      statusCode: 400,
      statusMessage: 'The GitHub App cannot see that repository.'
    })
  await linkRepository({
    environmentId: id,
    installationId: input.installationId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    ref: input.ref ?? repo.defaultBranch,
    directory: input.directory
  })
  await recordAuditBestEffort({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorType: 'user',
    actorId: session.userId,
    action: 'repository.link',
    meta: {
      environment: ctx.slug,
      repo: repo.fullName,
      ref: input.ref ?? repo.defaultBranch,
      directory: input.directory
    }
  })
  return syncEnvironment(id, { client, hcl: await hcl() })
})
