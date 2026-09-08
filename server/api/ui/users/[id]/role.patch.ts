import { z } from 'zod'
import { changeRoleSchema } from '../../../../../shared/schemas/user'
import { changeRole } from '../../../../services/users'
import { requireAdmin } from '../../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  // Before the parameter and the body, so a member is refused for the reason
  // that actually applies rather than for a malformed id.
  const session = await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const input = await readValidatedBody(event, changeRoleSchema.parse)

  await changeRole({
    actorId: session.userId,
    targetId: id,
    role: input.role,
    headers: event.headers
  })
  return { ok: true }
})
