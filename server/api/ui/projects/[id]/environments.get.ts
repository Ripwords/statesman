import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { listEnvironments } from '../../../../services/variables'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  return listEnvironments(id)
})
