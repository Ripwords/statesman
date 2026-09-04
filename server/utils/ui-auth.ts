import type { H3Event } from 'h3'
import { auth } from './auth'

/**
 * The browser door (spec §4). Every `/api/ui/*` route calls this first, before
 * it reads a parameter or a body, so an anonymous request is answered 401
 * rather than 400 for a malformed id it was never entitled to name.
 */
export async function requireSession(event: H3Event): Promise<{ userId: string }> {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Sign in required' })
  }
  return { userId: session.user.id }
}
