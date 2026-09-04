import { describe, it, expect, beforeAll } from 'vitest'
import { auth } from '../../server/utils/auth'
import { provisionUser } from '../protocol/helpers'

let userId: string

describe('api keys', () => {
  beforeAll(async () => {
    // Through the operator path: the server sets disableSignUp, which refuses
    // server-side signUpEmail calls too.
    const created = await provisionUser(`t${Date.now()}@example.com`, 'correct horse battery')
    userId = created.id
  })

  it('verifies a freshly created key', async () => {
    const key = await auth.api.createApiKey({
      body: {
        userId,
        name: 'ci',
        permissions: { state: ['read', 'write'] },
        metadata: { projects: ['acme/prod'] }
      }
    })
    const result = await auth.api.verifyApiKey({ body: { key: key.key } })
    expect(result.valid).toBe(true)
    expect(result.key?.id).toBe(key.id)
  })

  it('rejects a key that does not exist', async () => {
    const result = await auth.api.verifyApiKey({ body: { key: 'sm_not_a_real_key' } })
    expect(result.valid).toBe(false)
  })

  it('enforces declared permissions', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'read-only', permissions: { state: ['read'] } }
    })
    const ok = await auth.api.verifyApiKey({
      body: { key: key.key, permissions: { state: ['read'] } }
    })
    const denied = await auth.api.verifyApiKey({
      body: { key: key.key, permissions: { state: ['write'] } }
    })
    expect(ok.valid).toBe(true)
    expect(denied.valid).toBe(false)
  })

  it('rejects a disabled key', async () => {
    const key = await auth.api.createApiKey({ body: { userId, name: 'off' } })
    await auth.api.updateApiKey({ body: { keyId: key.id, userId, enabled: false } })
    expect((await auth.api.verifyApiKey({ body: { key: key.key } })).valid).toBe(false)
  })

  it('round-trips project scope through metadata', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'scoped', metadata: { projects: ['acme/prod', 'acme/staging'] } }
    })
    const result = await auth.api.verifyApiKey({ body: { key: key.key } })
    expect(result.key?.metadata).toMatchObject({ projects: ['acme/prod', 'acme/staging'] })
  })
})

describe('rate limiting', () => {
  it('enforces a per-key limit once it is exceeded', async () => {
    const key = await auth.api.createApiKey({
      body: {
        userId,
        name: 'throttled',
        rateLimitEnabled: true,
        rateLimitMax: 2,
        rateLimitTimeWindow: 60_000
      }
    })

    const outcomes: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const result = await auth.api.verifyApiKey({ body: { key: key.key } })
      outcomes.push(result.valid)
    }

    // The first calls are inside the window allowance, the later ones are not.
    expect(outcomes[0]).toBe(true)
    expect(outcomes.at(-1)).toBe(false)
  })

  it('does not throttle a key created without explicit limits', async () => {
    const key = await auth.api.createApiKey({ body: { userId, name: 'unthrottled' } })

    // Regression test for the plugin's own default of 10 requests per 24 hours,
    // which would fail partway through a single terraform apply.
    for (let i = 0; i < 12; i++) {
      const result = await auth.api.verifyApiKey({ body: { key: key.key } })
      expect(result.valid, `request ${i + 1} was rejected`).toBe(true)
    }
  })
})

describe('public sign-up', () => {
  it('is refused, even through the server-side api', async () => {
    // The whole authorization model rests on this: every authenticated user can
    // read every project's decrypted state (spec §5, single organization), so
    // an open sign-up endpoint is an open door to production secrets.
    await expect(
      auth.api.signUpEmail({
        body: {
          email: `stranger${Date.now()}@example.com`,
          password: 'correct horse battery',
          name: 'S'
        }
      })
    ).rejects.toThrow(/sign up is not enabled/i)
  })
})
