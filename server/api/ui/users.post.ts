import { createAccount } from '../../services/users'
import { requireAdmin } from '../../utils/ui-auth'
import { createUserSchema } from '../../../shared/schemas/user'

/**
 * Creates an account and returns its generated password once. Nothing stores
 * it readably and no endpoint shows it again, as with a password reset.
 */
export default defineEventHandler(async (event) => {
  const session = await requireAdmin(event)
  const input = await readValidatedBody(event, createUserSchema.parse)
  return createAccount({ actorId: session.userId, ...input, headers: event.headers })
})
