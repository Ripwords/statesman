import { z } from 'zod'
import { requireAdmin } from '../../../../utils/ui-auth'
import { setArchived } from '../../../../services/projects'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  const principal = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  await setArchived({ projectId: id, actorId: principal.userId, archived: false })
  return { ok: true }
})
