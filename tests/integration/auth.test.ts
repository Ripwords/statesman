import { describe, it, expect, beforeAll } from 'vitest'
import { auth } from '../../server/utils/auth'

let userId: string

describe('api keys', () => {
  beforeAll(async () => {
    const created = await auth.api.signUpEmail({
      body: { email: `t${Date.now()}@example.com`, password: 'correct horse battery', name: 'T' }
    })
    userId = created.user.id
  })

  it('verifies a freshly created key', async () => {
    const key = await auth.api.createApiKey({
      body: { userId, name: 'ci', permissions: { state: ['read', 'write'] },
              metadata: { projects: ['acme/prod'] } }
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
