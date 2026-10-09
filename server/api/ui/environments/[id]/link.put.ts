import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { requireGitHub, requireInstallation, viaGitHub } from '../../../../utils/github-guard'
import { environmentContext } from '../../../../services/variables'
import { linkRepository, normaliseDirectory, syncEnvironment } from '../../../../services/sync'
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
  await requireInstallation(input.installationId)
  const directory = normaliseDirectory(input.directory)
  const repos = await viaGitHub(() => client.listRepositories(input.installationId))
  const repo = repos.find((r) => r.id === input.repoId)
  if (!repo)
    throw createError({
      statusCode: 400,
      statusMessage: 'The GitHub App cannot see that repository.'
    })
  const ref = input.ref ?? repo.defaultBranch
  await linkRepository({
    environmentId: id,
    installationId: input.installationId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    ref,
    directory
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
      ref,
      directory
    }
  })
  // The link is saved, so from here a failure is a failed first sync, never a
  // failed link: a 500 would tell the admin "Could not link" about a link that exists.
  try {
    return await syncEnvironment(id, { client, hcl: await hcl() })
  } catch (error) {
    console.error(`First sync failed unexpectedly for environment ${id}`, error)
    return {
      ok: false as const,
      error: 'The first sync could not finish. Press Sync now to try again.'
    }
  }
})
