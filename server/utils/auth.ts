import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { apiKey } from '@better-auth/api-key'
import { admin } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'
import { db } from '../db/client'
import { schema } from '../db/schema'
import { env } from './env'

/**
 * What the two roles may do, in the admin plugin's own vocabulary.
 *
 * statesman does not consult these permissions directly — `requireAdmin` is the
 * guard, and it asks one question. They exist so `member` is a role the plugin
 * recognises rather than an unknown string, which is what keeps `setRole`
 * type-safe and stops a future plugin version rejecting a role it never knew
 * about.
 *
 * A member has no entry for `user` or `session` at all: reading projects and
 * versions is not something the admin plugin models, and granting nothing here
 * is the accurate statement.
 */
const ac = createAccessControl({
  user: ['create', 'list', 'set-role', 'set-password', 'get', 'update', 'delete'],
  session: ['list', 'revoke', 'delete']
})

const adminRole = ac.newRole({
  user: ['create', 'list', 'set-role', 'set-password', 'get', 'update', 'delete'],
  session: ['list', 'revoke', 'delete']
})

const memberRole = ac.newRole({})

export const auth = betterAuth({
  secret: env().BETTER_AUTH_SECRET,
  baseURL: env().BETTER_AUTH_URL,
  database: drizzleAdapter(db(), { provider: 'pg', schema }),
  // Sign-in only. Public sign-up on a self-hosted deployment is an open door:
  // spec §5 gives one organization per deployment and every authenticated user
  // can read every project's decrypted state, so "anyone can create an account"
  // and "anyone can read your production secrets" are the same sentence.
  // Accounts are created by the operator with `pnpm user:create`, which needs
  // database access and the auth secret.
  emailAndPassword: { enabled: true, disableSignUp: true },
  user: {
    additionalFields: {
      /**
       * Declared here as well as by the admin plugin, and only for the type.
       *
       * The plugin's own schema marks `role` as `input: false`, and the session
       * type is built with InferDBFieldsFromPluginsInput, which drops every
       * field carrying that flag. The column is written and returned correctly
       * at runtime; it is `session.user.role` in TypeScript that does not exist
       * without this. Re-declaring the field in additionalFields — where there
       * is no `input: false` to filter on — puts it back.
       *
       * https://github.com/better-auth/better-auth/issues/5047
       */
      role: { type: 'string', required: false }
    }
  },
  plugins: [
    admin({
      // `member`, not the plugin's built-in `user`: see shared/schemas/user.ts.
      // This is what stops the plugin writing a third role name into a column
      // that userRoleSchema only accepts two values for.
      defaultRole: 'member',
      adminRoles: ['admin'],
      // Declared, not merely named. `roles` is what makes `member` a role the
      // plugin knows: without it, `setRole` still accepts the string at runtime
      // but its type is the built-in `'user' | 'admin'`, so every call is a
      // type error and the only ways out are a cast or trusting undocumented
      // runtime behaviour. Neither is a foundation for an authorization check.
      roles: { admin: adminRole, member: memberRole }
    }),
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
      // One ceiling, stated in three places that must agree: here,
      // tokenConfigSchema.expiresInDays.max, and the configurator's input. The
      // plugin's own default is 365 days, so left alone it rejected values the
      // schema accepts with a server-side 400 the form could not explain. (The
      // configurator's input said 365 until this review; it now says 3650 too.)
      keyExpiration: { maxExpiresIn: 3650 },
      permissions: { defaultPermissions: { state: ['read'] } }
    })
  ]
})

export type Auth = typeof auth
