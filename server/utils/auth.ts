import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from '@better-auth/api-key'
import { db } from '../db/client'
import { schema } from '../db/schema'
import { env } from './env'

export const auth = betterAuth({
  secret: env().BETTER_AUTH_SECRET,
  baseURL: env().BETTER_AUTH_URL,
  database: drizzleAdapter(db(), { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  plugins: [
    apiKey({
      defaultPrefix: 'sm_',
      // Project scope rides in metadata; the plugin has no resource-instance
      // model of its own (spec §4, "Known gap").
      enableMetadata: true,
      // Rate limiting must stay ENABLED globally. The plugin's gate reads
      // `opts.rateLimit.enabled === false` and returns early, before it ever
      // looks at the per-key `rateLimitEnabled` column — the relationship is
      // AND, not OR, so a global `false` makes every per-key limit dead. It
      // also persists that false onto each key at creation time, so
      // requestCount would never increment either.
      //
      // The numbers are raised instead. One `terraform apply` costs roughly
      // 4-6 requests (LOCK, GET, POST, UNLOCK) and a `plan` about 3, so 120
      // per minute absorbs a CI fan-out of ~20 concurrent workspaces sharing
      // one token while still capping abuse. The plugin's own default of 10
      // per 24 hours would fail partway through a single apply.
      rateLimit: {
        enabled: true,
        timeWindow: 60_000,
        maxRequests: 120
      },
      permissions: { defaultPermissions: { state: ['read'] } }
    })
  ]
})

export type Auth = typeof auth
