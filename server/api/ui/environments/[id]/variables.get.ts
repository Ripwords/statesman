import { z } from 'zod'
import { requireSession } from '../../../../utils/ui-auth'
import { environmentContext, listStoredForUi } from '../../../../services/variables'
import { mergeVariables, type LinkSummary } from '../../../../utils/variable-status'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  const ctx = await environmentContext(id)
  const link: LinkSummary | null = null
  return {
    environment: { id, slug: ctx.slug },
    link,
    rows: mergeVariables(await listStoredForUi(id), null)
  }
})
