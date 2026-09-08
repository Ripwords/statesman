import { describe, it, expect } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'

const CRON_SECRET = 'test-cron-secret-that-is-long-enough'

// A server configured the way a Vercel deployment is: CRON_SECRET set, so the
// scheduler's door exists. endpoints.test.ts covers the opposite deployment,
// where no secret is configured and the route must not exist at all.
await setup({ server: true, env: { CRON_SECRET } })

/**
 * Retention has no scheduler on serverless, so the platform's cron calls this.
 * Vercel sends a GET with `Authorization: Bearer $CRON_SECRET` and nothing
 * else — no cookie, no body, no way to send a POST.
 */
describe('GET /api/admin/retention', () => {
  it('runs for a caller carrying the cron secret', async () => {
    const result = await $fetch('/api/admin/retention', {
      headers: { authorization: `Bearer ${CRON_SECRET}` }
    })
    // The same shape the manual POST returns; the point is that it ran.
    expect(result).toBeTypeOf('object')
  })

  it('accepts the scheme in any case, because HTTP says it is case-insensitive', async () => {
    await expect(
      $fetch('/api/admin/retention', { headers: { authorization: `bearer ${CRON_SECRET}` } })
    ).resolves.toBeTypeOf('object')
  })

  it('refuses a request with no Authorization header', async () => {
    await expect($fetch('/api/admin/retention')).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses the wrong secret', async () => {
    await expect(
      $fetch('/api/admin/retention', { headers: { authorization: 'Bearer wrong' } })
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses a browser session, which is what the POST is for', async () => {
    // No cookie is sent here, but the point is the GET does not consult one at
    // all: a signed-in admin still needs the secret on this route.
    await expect(
      $fetch('/api/admin/retention', { headers: { cookie: 'better-auth.session_token=whatever' } })
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
