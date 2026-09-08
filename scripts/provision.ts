import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { schema, user } from '../server/db/schema'
import type { UserRole } from '../shared/schemas/user'

export type ProvisionedUser = { id: string; email: string }

export type Provisioning = {
  createUser: (input: {
    email: string
    password: string
    name?: string
    role?: UserRole
  }) => Promise<ProvisionedUser>
  /** Whether any admin account exists, which is what decides the first role. */
  hasAdmin: () => Promise<boolean>
  close: () => Promise<void>
}

/**
 * An operator-side Better Auth instance whose only job is creating accounts.
 *
 * Two things about it are deliberate.
 *
 * It does NOT import server/utils/auth: that module reaches env(), which
 * requires STATESMAN_ENCRYPTION_KEY. A tool that writes two rows has no business
 * holding the key that decrypts state, and requiring it would mean giving the
 * migration container every application secret.
 *
 * It enables email sign-up, which the server disables. That asymmetry is the
 * whole control: the public endpoint refuses to mint accounts, and creating one
 * requires database access plus the auth secret — which is to say, the operator.
 * Passwords are hashed the same way either side (scrypt, not keyed by the
 * secret), so an account created here signs in against the running server.
 */
export function provisioning(options: { databaseUrl: string; secret: string }): Provisioning {
  const pool = new Pool({ connectionString: options.databaseUrl })
  const db = drizzle(pool, { schema })

  const auth = betterAuth({
    secret: options.secret,
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true }
  })

  return {
    async createUser(input) {
      const result = await auth.api.signUpEmail({
        body: {
          email: input.email,
          password: input.password,
          name: input.name ?? input.email.split('@')[0] ?? input.email
        }
      })
      // The role is written directly rather than passed to signUpEmail. The
      // admin plugin declares `role` as `input: false`, so a sign-up body
      // carrying one is ignored — and this operator-side instance does not load
      // the plugin anyway, deliberately: it exists to write two rows, not to
      // hold every capability the running server has.
      if (input.role !== undefined) {
        await db.update(user).set({ role: input.role }).where(eq(user.id, result.user.id))
      }
      return { id: result.user.id, email: result.user.email }
    },
    async hasAdmin() {
      const rows = await db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.role, 'admin'))
        .limit(1)
      return rows.length > 0
    },
    async close() {
      await pool.end()
    }
  }
}

/** Reads the two variables provisioning needs, and only those. */
export function provisioningConfig(): { databaseUrl: string; secret: string } {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required, and must match the running server')
  return { databaseUrl, secret }
}
