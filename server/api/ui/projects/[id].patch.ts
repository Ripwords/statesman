import { z } from 'zod'
import { requireSession } from '../../../utils/ui-auth'
import { requireProjectPermission } from '../../../utils/project-access'
import { updateProject } from '../../../services/projects'
import { updateProjectSchema } from '../../../../shared/schemas/project'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const principal = await requireProjectPermission(event, id, 'project:update')
  const changes = await readValidatedBody(event, updateProjectSchema.parse)
  // Lowering retention destroys history at the next pass: a deployment power.
  const touchesRetention =
    changes.retentionKeepVersions !== undefined || changes.retentionKeepDays !== undefined
  if (touchesRetention && principal.projectRole !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Only an admin can change retention.' })
  }
  await updateProject({ projectId: id, actorId: principal.userId, changes })
  return { ok: true }
})
