import { z } from 'zod'
import { auth } from '../../../utils/auth'
import { requireAdmin } from '../../../utils/ui-auth'

const paramsSchema = z.object({ id: z.string().min(1).max(64) })

/**
 * Revokes a token. The plugin's own handler refuses a key whose `referenceId`
 * is not the session user, so ownership does not need re-checking here — but it
 * does mean `headers` must be forwarded.
 */
export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const { id } = await getValidatedRouterParams(event, paramsSchema.parse)
  await auth.api.deleteApiKey({ body: { keyId: id }, headers: event.headers })
  return { ok: true }
})
