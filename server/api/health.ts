import { runHealthChecks } from '../utils/health'

/**
 * Unauthenticated by design — a load balancer cannot hold a session. It returns
 * check names, pass/fail and timings only; details are redacted in
 * runHealthChecks.
 *
 * Not `health.get.ts`: that filename registers the route for GET alone, so a
 * HEAD probe fell through to the SPA catch-all and answered 302 to /login.
 * Uptime monitors default to HEAD, so every one of them reported a redirect
 * instead of health. Node strips the body from a HEAD response itself; the
 * status is what the monitor reads.
 */
export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const result = await runHealthChecks()
  if (!result.ok) setResponseStatus(event, 503)
  return { status: result.ok ? 'ok' : 'degraded', checks: result.checks }
})
