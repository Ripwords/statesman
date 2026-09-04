import type { TokenConfig } from '../../shared/schemas/token'

export type ApiKeyBody = {
  userId: string
  name: string
  prefix: string
  permissions: { state: string[] }
  metadata: { scope: TokenConfig['scope'] }
  expiresIn?: number
  rateLimitEnabled: boolean
  rateLimitMax?: number
  rateLimitTimeWindow?: number
}

/**
 * Translates the configurator's shape into the API Key plugin's create body.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * - Project scope rides in `metadata`, not `permissions`. The plugin models
 *   resource -> actions, not resource -> instances (spec §4, "Known gap"), so
 *   the scope is enforced by our own guard on `/api/tf/*`.
 * - `rateLimitEnabled` stays `true` unconditionally. The plugin writes this
 *   column verbatim but falls back to the global 120 requests / 60s for the max
 *   and the window, so a token with no explicit limits is metered, and only an
 *   explicit `false` here could hand out an unmetered key (CARRY-FORWARD §3).
 */
export function toApiKeyBody(config: TokenConfig, userId: string): ApiKeyBody {
  return {
    userId,
    name: config.name,
    prefix: 'sm_',
    permissions: { state: [...config.actions] },
    metadata: { scope: config.scope },
    expiresIn: config.expiresInDays ? config.expiresInDays * 86_400 : undefined,
    rateLimitEnabled: true,
    rateLimitMax: config.rateLimitMax,
    rateLimitTimeWindow: config.rateLimitWindowSeconds
      ? config.rateLimitWindowSeconds * 1000
      : undefined
  }
}
