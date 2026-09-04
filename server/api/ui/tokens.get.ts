import { z } from 'zod'
import { stateActionSchema, tokenScopeSchema } from '../../../shared/schemas/token'
import { auth } from '../../utils/auth'
import { requireSession } from '../../utils/ui-auth'

// The plugin types `metadata` as an open record and `permissions` as
// string arrays, so both are re-parsed here rather than handed to the client
// untyped. A key written by an older shape degrades to "no scope, no actions"
// instead of crashing the list.
const metadataSchema = z.object({ scope: tokenScopeSchema })
const actionsSchema = z.array(stateActionSchema)

export default defineEventHandler(async (event) => {
  await requireSession(event)
  const { apiKeys } = await auth.api.listApiKeys({ headers: event.headers })

  return apiKeys.map((key) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    start: key.start,
    enabled: key.enabled,
    expiresAt: key.expiresAt,
    lastRequest: key.lastRequest,
    createdAt: key.createdAt,
    rateLimitMax: key.rateLimitMax,
    rateLimitTimeWindow: key.rateLimitTimeWindow,
    actions: actionsSchema.safeParse(key.permissions?.state ?? []).data ?? [],
    scope: metadataSchema.safeParse(key.metadata).data?.scope ?? null
  }))
})
