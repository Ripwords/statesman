import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { requireProjectPermission } from '../../../../utils/project-access'
import { addMember } from '../../../../services/members'
import { addMemberSchema } from '../../../../../shared/schemas/project-role'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const principal = await requireProjectPermission(event, id, 'member:manage')
  const { email, role } = await readValidatedBody(event, addMemberSchema.parse)
  return addMember({ projectId: id, email, role, actorId: principal.userId })
})
