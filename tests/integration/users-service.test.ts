import { isApiError } from '../ui/nitro-globals'
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/db/client'
import { user } from '../../server/db/schema'
import { listAccounts, changeRole, resetPassword } from '../../server/services/users'
import { provisionUser, signInHeaders } from '../protocol/helpers'
import { auth } from '../../server/utils/auth'

const PASSWORD = 'correct horse battery staple'

/**
 * Vitest runs test FILES in parallel against one database, so this suite owns
 * only the accounts it creates — never the `user` table. An earlier draft
 * cleared the table to make the admin count predictable and broke every sibling
 * suite that had provisioned an account of its own.
 *
 * That is also why the last-admin refusal is not tested here: it depends on a
 * deployment-wide count that parallel files are all writing to. The rule is a
 * pure function, exhaustively covered in tests/unit/last-admin.test.ts; what
 * this file checks is everything that can be scoped to its own rows.
 */
async function pair(): Promise<{
  adminId: string
  memberId: string
  memberEmail: string
  headers: Headers
}> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const a = await provisionUser(`us-admin-${stamp}@example.com`, PASSWORD)
  const m = await provisionUser(`us-member-${stamp}@example.com`, PASSWORD)
  await db().update(user).set({ role: 'admin' }).where(eq(user.id, a.id))
  await db().update(user).set({ role: 'member' }).where(eq(user.id, m.id))
  return {
    adminId: a.id,
    memberId: m.id,
    memberEmail: m.email,
    headers: await signInHeaders(a.email, PASSWORD)
  }
}

describe('listAccounts', () => {
  it('reports each account with its role, and never a password hash', async () => {
    const { adminId, memberId } = await pair()
    const accounts = await listAccounts()
    expect(accounts.find((a) => a.id === adminId)?.role).toBe('admin')
    expect(accounts.find((a) => a.id === memberId)?.role).toBe('member')
    expect(JSON.stringify(accounts)).not.toMatch(/password|hash|\$2[aby]\$|scrypt/i)
  })

  it('reports a NULL role as member rather than leaking the null onward', async () => {
    const { memberId } = await pair()
    await db().update(user).set({ role: null }).where(eq(user.id, memberId))
    expect((await listAccounts()).find((a) => a.id === memberId)?.role).toBe('member')
  })
})

describe('changeRole', () => {
  it('promotes a member', async () => {
    const { adminId, memberId, headers } = await pair()
    await changeRole({ actorId: adminId, targetId: memberId, role: 'admin', headers })
    expect((await listAccounts()).find((a) => a.id === memberId)?.role).toBe('admin')
  })

  it('demotes an admin while another admin remains', async () => {
    const { adminId, memberId, headers } = await pair()
    await changeRole({ actorId: adminId, targetId: memberId, role: 'admin', headers })
    await changeRole({ actorId: memberId, targetId: adminId, role: 'member', headers })
    expect((await listAccounts()).find((a) => a.id === adminId)?.role).toBe('member')
  })

  it('refuses for an account that does not exist', async () => {
    const { adminId, headers } = await pair()
    expect(
      await refusalOf(changeRole({ actorId: adminId, targetId: 'nobody', role: 'member', headers }))
    ).toEqual({ apiError: true, statusCode: 404 })
  })

  it('is a no-op that still succeeds when the role is unchanged', async () => {
    const { adminId, memberId, headers } = await pair()
    await changeRole({ actorId: adminId, targetId: memberId, role: 'member', headers })
    expect((await listAccounts()).find((a) => a.id === memberId)?.role).toBe('member')
  })
})

describe('resetPassword', () => {
  it('sets a password the target can actually sign in with', async () => {
    const { adminId, memberId, memberEmail, headers } = await pair()
    const { password } = await resetPassword({ actorId: adminId, targetId: memberId, headers })
    expect(password.length).toBeGreaterThanOrEqual(16)
    await expect(signInHeaders(memberEmail, password)).resolves.toBeInstanceOf(Headers)
  })

  it('ends the target’s existing sessions, so the old password stops working now', async () => {
    const { adminId, memberId, memberEmail, headers } = await pair()
    const before = await signInHeaders(memberEmail, PASSWORD)
    expect(await auth.api.getSession({ headers: before })).not.toBeNull()

    await resetPassword({ actorId: adminId, targetId: memberId, headers })

    expect(await auth.api.getSession({ headers: before })).toBeNull()
  })

  /**
   * An admin resetting their own password would be a change that does not need
   * the current one — exactly the property to keep away from your own account.
   * /account requires the current password and is the route for this.
   */
  it('refuses to reset the caller’s own password', async () => {
    const { adminId, headers } = await pair()
    expect(
      await refusalOf(resetPassword({ actorId: adminId, targetId: adminId, headers }))
    ).toEqual({ apiError: true, statusCode: 400 })
  })

  it('refuses for an account that does not exist', async () => {
    const { adminId, headers } = await pair()
    expect(
      await refusalOf(resetPassword({ actorId: adminId, targetId: 'nobody', headers }))
    ).toEqual({ apiError: true, statusCode: 404 })
  })
})

/**
 * Describes how a call refused, as a value, so the assertion can be made
 * unconditionally — an expectation inside a `catch` that never runs is a test
 * that never asserted.
 *
 * `isApiError` rather than a bare status check: the services signal through
 * `createError`, and a plain object that happens to carry a statusCode would
 * satisfy the looser check while meaning something else entirely.
 */
async function refusalOf(
  call: Promise<unknown>
): Promise<{ apiError: boolean; statusCode: number | undefined }> {
  try {
    await call
    return { apiError: false, statusCode: undefined }
  } catch (error) {
    return {
      apiError: isApiError(error),
      statusCode: isApiError(error) ? error.statusCode : undefined
    }
  }
}
