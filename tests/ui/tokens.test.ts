import { testEvent } from './nitro-globals'
import { describe, expect, it } from 'vitest'
import listTokens from '../../server/api/ui/tokens.get'
import createToken from '../../server/api/ui/tokens.post'
import deleteToken from '../../server/api/ui/tokens/[id].delete'
import { toApiKeyBody } from '../../server/utils/token-mapping'
import { tokenConfigSchema } from '../../shared/schemas/token'

describe('token config mapping', () => {
  it('maps actions onto state permissions', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read', 'write'], scope: { kind: 'all' }
    })
    expect(toApiKeyBody(config, 'u1').permissions).toEqual({ state: ['read', 'write'] })
  })

  it('carries project scope into metadata', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read'], scope: { kind: 'projects', projects: ['acme/prod'] }
    })
    expect(toApiKeyBody(config, 'u1').metadata).toEqual({
      scope: { kind: 'projects', projects: ['acme/prod'] }
    })
  })

  it('converts expiry days to seconds', () => {
    const config = tokenConfigSchema.parse({
      name: 'ci', actions: ['read'], scope: { kind: 'all' }, expiresInDays: 7
    })
    expect(toApiKeyBody(config, 'u1').expiresIn).toBe(604_800)
  })

  it('omits expiry when unset', () => {
    const config = tokenConfigSchema.parse({ name: 'ci', actions: ['read'], scope: { kind: 'all' } })
    expect(toApiKeyBody(config, 'u1').expiresIn).toBeUndefined()
  })

  it('names the owning user', () => {
    const config = tokenConfigSchema.parse({ name: 'ci', actions: ['read'], scope: { kind: 'all' } })
    expect(toApiKeyBody(config, 'u1').userId).toBe('u1')
  })

  /**
   * The brief asserts `rateLimitEnabled === false` when no max is given. That
   * contradicts CARRY-FORWARD §3, which wins: rate limiting is live and a token
   * created without explicit limits inherits the global 120 requests / 60s.
   * @better-auth/api-key persists `rateLimitEnabled` verbatim and falls back to
   * the global numbers only for max and window, so writing `false` here would
   * silently hand out an unmetered key.
   */
  it('leaves rate limiting on so an unconfigured token inherits the global ceiling', () => {
    const config = tokenConfigSchema.parse({ name: 'a', actions: ['read'], scope: { kind: 'all' } })
    const body = toApiKeyBody(config, 'u1')
    expect(body.rateLimitEnabled).toBe(true)
    expect(body.rateLimitMax).toBeUndefined()
    expect(body.rateLimitTimeWindow).toBeUndefined()
  })

  it('converts an explicit rate limit window from seconds to milliseconds', () => {
    const config = tokenConfigSchema.parse({
      name: 'b', actions: ['read'], scope: { kind: 'all' },
      rateLimitMax: 60, rateLimitWindowSeconds: 60
    })
    const body = toApiKeyBody(config, 'u1')
    expect(body.rateLimitEnabled).toBe(true)
    expect(body.rateLimitMax).toBe(60)
    expect(body.rateLimitTimeWindow).toBe(60_000)
  })
})

describe('token api', () => {
  it('rejects an unauthenticated token list', async () => {
    await expect(listTokens(testEvent())).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated token creation', async () => {
    await expect(
      createToken(testEvent({ body: { name: 'ci', actions: ['read'], scope: { kind: 'all' } } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an unauthenticated revoke', async () => {
    await expect(
      deleteToken(testEvent({ params: { id: 'k1' } }))
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
