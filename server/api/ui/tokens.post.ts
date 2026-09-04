import { tokenConfigSchema } from '../../../shared/schemas/token'
import { auth } from '../../utils/auth'
import { toApiKeyBody } from '../../utils/token-mapping'
import { requireSession } from '../../utils/ui-auth'

/**
 * Creates a token and returns its raw value exactly once (spec §4). Keys are
 * stored hashed, so nothing here can be recovered afterwards.
 *
 * `createApiKey` is deliberately called WITHOUT `headers`: the plugin treats a
 * call carrying headers as a client request and rejects `permissions`,
 * `rateLimitMax` and `rateLimitTimeWindow` as server-only properties. The
 * owning user is named through the body instead, which is the documented
 * server-side path.
 */
export default defineEventHandler(async (event) => {
  const session = await requireSession(event)
  // A malformed configuration is a 400, which is exactly what h3 raises from a
  // validator throw, so this needs no catch (CARRY-FORWARD §7c).
  const config = await readValidatedBody(event, tokenConfigSchema.parse)
  const created = await auth.api.createApiKey({ body: toApiKeyBody(config, session.userId) })
  return { id: created.id, key: created.key, name: created.name ?? config.name }
})
