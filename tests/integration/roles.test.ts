import { describe, it, expect, beforeAll } from 'vitest'
import { testEvent } from '../ui/nitro-globals'
import { requireSession, requireAdmin } from '../../server/utils/ui-auth'
import { provisionUser, signInHeaders, setRole } from '../protocol/helpers'

const PASSWORD = 'correct horse battery staple'

let adminHeaders: Headers
let memberHeaders: Headers
let adminId: string
let memberId: string

/**
 * Real accounts, real sign-ins, real cookies. A mocked session would test the
 * shape of the mock; the property that matters is that the guard reaches the
 * database, reads the role column and refuses on what it finds there.
 */
beforeAll(async () => {
  const stamp = Date.now()
  const adminUser = await provisionUser(`role-admin-${stamp}@example.com`, PASSWORD)
  const memberUser = await provisionUser(`role-member-${stamp}@example.com`, PASSWORD)
  adminId = adminUser.id
  memberId = memberUser.id
  await setRole(adminId, 'admin')
  await setRole(memberId, 'member')
  adminHeaders = await signInHeaders(adminUser.email, PASSWORD)
  memberHeaders = await signInHeaders(memberUser.email, PASSWORD)
})

describe('requireSession', () => {
  it('reports the role alongside the user id', async () => {
    await expect(requireSession(testEvent({ headers: headersOf(adminHeaders) }))).resolves.toEqual({
      userId: adminId,
      role: 'admin'
    })
    await expect(requireSession(testEvent({ headers: headersOf(memberHeaders) }))).resolves.toEqual(
      { userId: memberId, role: 'member' }
    )
  })

  it('still refuses an anonymous request with 401', async () => {
    await expect(requireSession(testEvent())).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('requireAdmin', () => {
  it('lets an admin through', async () => {
    await expect(requireAdmin(testEvent({ headers: headersOf(adminHeaders) }))).resolves.toEqual({
      userId: adminId,
      role: 'admin'
    })
  })

  /**
   * 403, not 404. The member is a legitimate signed-in account and the route
   * exists; hiding it would be a different claim, and would also make a genuine
   * routing mistake indistinguishable from a permission one in the logs.
   */
  it('refuses a member with 403, not 401 and not 404', async () => {
    await expect(
      requireAdmin(testEvent({ headers: headersOf(memberHeaders) }))
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses an anonymous request with 401, because it is not signed in at all', async () => {
    await expect(requireAdmin(testEvent())).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses an account whose role column is NULL', async () => {
    // Rows written before the role column existed. The backfill sets them to
    // admin, but a row that escapes it must not be one by default.
    const stranger = await provisionUser(`role-null-${Date.now()}@example.com`, PASSWORD)
    const headers = await signInHeaders(stranger.email, PASSWORD)
    await expect(requireAdmin(testEvent({ headers: headersOf(headers) }))).rejects.toMatchObject({
      statusCode: 403
    })
  })
})

function headersOf(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}
