import type { H3Event } from 'h3'
import { auth } from './auth'
import { isAdmin, roleOf, type UserRole } from '../../shared/schemas/user'

export type Principal = { userId: string; role: UserRole }

/**
 * The browser door (spec §4). Every `/api/ui/*` route calls this first, before
 * it reads a parameter or a body, so an anonymous request is answered 401
 * rather than 400 for a malformed id it was never entitled to name.
 *
 * The role rides along because every caller that needs one already has the
 * session in hand; a separate lookup would be a second round trip to the
 * database for a value the first one already returned.
 */
export async function requireSession(event: H3Event): Promise<Principal> {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Sign in required' })
  }
  return { userId: session.user.id, role: roleOf(session.user.role) }
}

/**
 * The same door, for the routes that CHANGE something: accounts, roles, tokens,
 * locks, history, retention. Reading is a member's job and writing is an
 * admin's.
 *
 * A member gets 403 rather than 404. They are a legitimate signed-in account
 * and the route genuinely exists, so hiding it would state something untrue —
 * and would make a real routing mistake indistinguishable from a permission one
 * in the logs. There is nothing to conceal here anyway: a member can already
 * read every project's decrypted state, so the existence of an admin route is
 * not the secret.
 */
export async function requireAdmin(event: H3Event): Promise<Principal> {
  const principal = await requireSession(event)
  if (!isAdmin(principal.role)) {
    throw createError({
      statusCode: 403,
      statusMessage:
        'This action needs an admin account. Ask an admin to do it, or to change your role.'
    })
  }
  return principal
}
