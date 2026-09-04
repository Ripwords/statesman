import { runRetentionForAllProjects } from '../../services/retention'
import { requireSession } from '../../utils/ui-auth'

/**
 * Runs retention on demand. The scheduled task in server/tasks/retention.ts
 * runs the same function on a long-running server; this is the manual trigger,
 * and the only one that exists on serverless.
 */
export default defineEventHandler(async (event) => {
  await requireSession(event)
  return runRetentionForAllProjects()
})
