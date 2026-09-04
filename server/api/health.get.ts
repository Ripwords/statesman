import { runHealthChecks } from '../utils/health'

/**
 * Unauthenticated by design — a load balancer cannot hold a session. It returns
 * check names, pass/fail and timings only; details are redacted in
 * runHealthChecks.
 */
export default defineEventHandler(async (event) => {
  const result = await runHealthChecks()
  if (!result.ok) setResponseStatus(event, 503)
  return { status: result.ok ? 'ok' : 'degraded', checks: result.checks }
})
