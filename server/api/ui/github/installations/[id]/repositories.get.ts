import { z } from 'zod'
import { requireAdmin } from '../../../../../utils/ui-auth'
import { requireGitHub } from '../../../../../utils/github-guard'

const paramsSchema = z.object({ id: z.coerce.number().int().positive() })

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const client = requireGitHub()
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  return client.listRepositories(id)
})
