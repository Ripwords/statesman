import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { user } from '../db/schema'
import { auth } from '../utils/auth'
import { roleOf, type UserRole } from '../../shared/schemas/user'

export type Account = {
  id: string
  email: string
  name: string
  role: UserRole
  createdAt: Date
}

/**
 * Columns are listed rather than selecting the row, so a column added to the
 * table later — the ban fields already sit there — cannot arrive in a dashboard
 * response nobody meant to widen. `account.password` lives in a different table
 * and is never joined here at all.
 */
export async function listAccounts(): Promise<Account[]> {
  const rows = await db()
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt
    })
    .from(user)
    .orderBy(user.createdAt)

  return rows.map((row) => ({ ...row, role: roleOf(row.role) }))
}

async function requireAccount(id: string): Promise<{ id: string; role: UserRole }> {
  const rows = await db().select({ id: user.id, role: user.role }).from(user).where(eq(user.id, id))
  const found = rows[0]
  if (!found) {
    throw createError({ statusCode: 404, statusMessage: 'No such account' })
  }
  return { id: found.id, role: roleOf(found.role) }
}

async function countAdmins(): Promise<number> {
  const rows = await db().select({ id: user.id }).from(user).where(eq(user.role, 'admin'))
  return rows.length
}

/**
 * Whether a role change would leave the deployment with no admin at all.
 *
 * Pure, and separate from the query that counts, because the condition is the
 * part worth testing exhaustively and the count is deployment-wide state that
 * parallel test files are all writing to at once. Given the count, the answer
 * is arithmetic.
 */
export function wouldOrphanDeployment(input: {
  currentRole: UserRole
  nextRole: UserRole
  adminCount: number
}): boolean {
  const losingAnAdmin = input.currentRole === 'admin' && input.nextRole !== 'admin'
  return losingAnAdmin && input.adminCount <= 1
}

/**
 * Sets an account's role.
 *
 * The one refusal is demoting the last admin. It is not a hypothetical: the
 * deployment keeps serving Terraform perfectly afterwards, so nothing looks
 * broken, while every route that could restore an admin is itself admin-only.
 * The way back would be a database console.
 *
 * Demoting yourself is allowed as long as somebody else is left holding the
 * role — that is a legitimate handover, not a lockout.
 */
export async function changeRole(input: {
  actorId: string
  targetId: string
  role: UserRole
  headers: Headers
}): Promise<void> {
  const target = await requireAccount(input.targetId)
  if (target.role === input.role) return

  const orphans = wouldOrphanDeployment({
    currentRole: target.role,
    nextRole: input.role,
    adminCount: await countAdmins()
  })
  if (orphans) {
    throw createError({
      statusCode: 409,
      statusMessage:
        'This is the only admin. Promote someone else first, or the deployment would be left with nobody able to manage accounts, tokens or locks.'
    })
  }

  // Through the plugin rather than a direct UPDATE: it is the plugin's column,
  // and going through its endpoint means the caller's admin session is checked
  // a second time, by the code that owns the rule.
  await auth.api.setRole({
    body: { userId: input.targetId, role: input.role },
    headers: input.headers
  })
}

/**
 * Generates a password for someone who has lost theirs, and ends their existing
 * sessions so the old one stops working immediately rather than at expiry.
 *
 * Refuses on the caller's own account. This path does not ask for the current
 * password — that is the point of a reset — and an endpoint that changes your
 * own password without proving you know it is exactly what a stolen session
 * would reach for. `/account` is the route for your own, and it asks.
 */
export async function resetPassword(input: {
  actorId: string
  targetId: string
  headers: Headers
}): Promise<{ password: string }> {
  if (input.actorId === input.targetId) {
    throw createError({
      statusCode: 400,
      statusMessage:
        'Use Account → Change Password for your own password. A reset does not ask for the current one, so it is not offered on the account you are signed in as.'
    })
  }
  await requireAccount(input.targetId)

  const password = randomBytes(18).toString('base64url')
  await auth.api.setUserPassword({
    body: { userId: input.targetId, newPassword: password },
    headers: input.headers
  })
  // Anything still signed in as that account was signed in under the password
  // that was just replaced.
  await auth.api.revokeUserSessions({ body: { userId: input.targetId }, headers: input.headers })

  return { password }
}
