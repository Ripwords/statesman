import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { requireProjectPermission } from '../../../../utils/project-access'
import { listMembers } from '../../../../services/members'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  await requireProjectPermission(event, id, 'project:read')
  const members = await listMembers(id)
  return { members, ownerCount: members.filter((m) => m.role === 'owner').length }
})
