import { z } from 'zod'
import { requireSession } from '../../../../../utils/ui-auth'
import { requireProjectPermission } from '../../../../../utils/project-access'
import { removeMember } from '../../../../../services/members'

const paramsSchema = z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id, userId } = await getValidatedRouterParams(event, paramsSchema.parse)
  const principal = await requireProjectPermission(event, id, 'member:manage')
  await removeMember({ projectId: id, userId, actorId: principal.userId })
  return { ok: true }
})
