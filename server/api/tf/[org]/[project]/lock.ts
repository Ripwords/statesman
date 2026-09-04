import { authenticateTf, authorizeTf } from '../../../../utils/tf-auth'
import {
  refFromEvent,
  resolveProject,
  handleLockAcquire,
  handleLockRelease
} from '../../../../utils/tf-handler'

// Spec §2: the dedicated sub-path exists so a client that cannot send the
// WebDAV-inherited LOCK/UNLOCK verbs can still distinguish "write state" from
// "acquire lock". Both spellings are accepted.
const ACQUIRE = new Set(['POST', 'LOCK'])
const RELEASE = new Set(['DELETE', 'UNLOCK'])

export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  if (!ACQUIRE.has(method) && !RELEASE.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  // Same guard, same order as the base path (spec §9); never re-implemented.
  const principal = await authenticateTf(event)
  const ref = await refFromEvent(event)
  const resolved = await resolveProject(ref)
  authorizeTf(principal, ref, 'lock')

  return ACQUIRE.has(method)
    ? handleLockAcquire(event, resolved, principal)
    : handleLockRelease(event, resolved, principal)
})
