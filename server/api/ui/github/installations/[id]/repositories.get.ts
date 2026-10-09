import { z } from 'zod'
import { requireSession } from '../../../../../utils/ui-auth'
import { ownsAnyProject } from '../../../../../utils/project-access'
import { isAdmin } from '../../../../../../shared/schemas/user'
import { requireGitHub, requireInstallation, viaGitHub } from '../../../../../utils/github-guard'

const paramsSchema = z.object({ id: z.coerce.number().int().positive() })

export default defineEventHandler(async (event) => {
  const session = await requireSession(event)
  if (!isAdmin(session.role) && !(await ownsAnyProject(session.userId))) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Needs owner access to a project. Ask an admin.'
    })
  }
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  await requireInstallation(id)
  return viaGitHub(() => client.listRepositories(id))
})
