import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { environmentContext, listStoredForUi } from '../../../../services/variables'
import { linkSummary } from '../../../../services/sync'
import { mergeVariables } from '../../../../utils/variable-status'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  const found = await linkSummary(id)
  return {
    environment: { id, slug: ctx.slug },
    link: found?.summary ?? null,
    rows: mergeVariables(await listStoredForUi(id), found?.declared ?? null)
  }
})
