import { z } from 'zod'
import { resetPassword } from '../../../../services/users'
import { requireAdmin } from '../../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * Generates a replacement password for someone locked out, and returns it once.
 * It is never stored in readable form and there is no endpoint that can show it
 * again — the same one-time-reveal contract the token flow already has.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)

  return resetPassword({ actorId: session.userId, targetId: id, headers: event.headers })
})
