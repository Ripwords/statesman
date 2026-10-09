import { auth } from '../../utils/auth'

/**
 * The organization plugin's endpoints check authority against plugin
 * membership alone, which would refuse a deployment admin who is not a member
 * and would let an owner act outside statesman's audit. Member management goes
 * through /api/ui/projects/:id/members only (project-access spec §6).
 */
const BLOCKED = '/api/auth/organization/'

export default defineEventHandler(async (event) => {
  if (event.path.startsWith(BLOCKED)) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return auth.handler(toWebRequest(event))
})
