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
      // The plugin's own default is 10 requests per 24 hours, which would
      // throttle a single `terraform apply` into failure. Rate limiting is a
      // per-token control in the configurator, so it is off by default here
      // and switched on per key when the operator asks for it.
      rateLimit: { enabled: false },
      permissions: { defaultPermissions: { state: ['read'] } }
    })
  ]
})

export type Auth = typeof auth
