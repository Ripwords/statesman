import { runRetentionForAllProjects } from '../../services/retention'
import { cronAuthOutcome } from '../../utils/cron-auth'
import { env } from '../../utils/env'

/**
 * The scheduler's door.
 *
 * Retention runs by itself only on a long-running server — Nitro's scheduler
 * needs a process that stays alive, and a serverless function does not (see
 * server/tasks/retention.ts). On Vercel the platform's cron calls this instead.
 *
 * GET, not POST, because Vercel Cron sends a GET and nothing else. That makes
 * this a state-changing GET, which is normally worth avoiding; the alternatives
 * were a scheduler that cannot reach the endpoint at all, or a second service
 * whose only job is to turn a GET into a POST. The route is not linked from
 * anywhere, is not reachable with a session, and needs a secret no browser has.
 *
 * The session-guarded POST alongside it stays the manual, human trigger.
 */
export default defineEventHandler(async (event) => {
  const outcome = cronAuthOutcome({
    secret: env().CRON_SECRET,
    authorization: event.headers.get('authorization') ?? undefined
  })

  if (outcome === 'not-configured') {
    // No CRON_SECRET on this deployment means no scheduler door. Saying 401
    // would advertise one that can never be opened.
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (outcome === 'denied') {
    throw createError({ statusCode: 401, statusMessage: 'Invalid cron credentials' })
  }

  return runRetentionForAllProjects()
})
