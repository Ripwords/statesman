import { z } from 'zod'
import { requireAdmin } from '../../../utils/ui-auth'
import { deleteProject } from '../../../services/projects'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const principal = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  return deleteProject({ projectId: id, actorId: principal.userId })
})
