import { auth } from '../../utils/auth'
import { isBlockedAuthPath } from '../../utils/blocked-auth-paths'

/**
 * Better Auth's HTTP surface, minus the plugin endpoints statesman replaces
 * with its own doors (see server/utils/blocked-auth-paths.ts).
 *
 * The block is decided on the web Request handed to Better Auth, not on
 * `event.path`: better-call routes on `new URL(request.url).pathname`, which
 * resolves `/%2e/` and `/x/../`, so a raw-path check is one dot-segment away
 * from being bypassed. `disabledPaths` in server/utils/auth.ts refuses the same
 * endpoints inside Better Auth as a second line.
 */
export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  if (isBlockedAuthPath(request.url)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return auth.handler(request)
})
