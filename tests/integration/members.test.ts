import { testEvent, isApiError } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { auditLog, projectAccess } from '../../server/db/schema'
import listMembers from '../../server/api/ui/projects/[id]/members.get'
import addMember from '../../server/api/ui/projects/[id]/members.post'
import changeRole from '../../server/api/ui/projects/[id]/members/[userId].patch'
import removeMember from '../../server/api/ui/projects/[id]/members/[userId].delete'

const ORG = 'members'
const PASSWORD = 'correct horse battery staple'
let projectId: string
type Actor = { id: string; email: string; h: Record<string, string> }
const ACTORS = ['admin', 'owner', 'viewer', 'outsider'] as const
const u = {} as Record<(typeof ACTORS)[number], Actor>

beforeAll(async () => {
  await resetDb(ORG)
  projectId = await seedProject(ORG, 'p')
  const stamp = Date.now()
  for (const name of ACTORS) {
    const p = await provisionUser(`mb-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(p.id, name === 'admin' ? 'admin' : 'member')
    if (name === 'owner' || name === 'viewer') await grantProjectRole(projectId, p.id, name)
    u[name] = { ...p, h: Object.fromEntries((await signInHeaders(p.email, PASSWORD)).entries()) }
  }
})

async function status(call: Promise<unknown>): Promise<number | undefined> {
  try {
    await call
    return undefined
  } catch (e) {
    return isApiError(e) ? e.statusCode : undefined
  }
}

describe('members', () => {
  it('lists members with name, email, role for any member', async () => {
    const res = await listMembers(testEvent({ headers: u.viewer.h, params: { id: projectId } }))
    expect(res.members.map((m) => m.email).toSorted()).toEqual(
      [u.owner.email, u.viewer.email].toSorted()
    )
    expect(res.ownerCount).toBe(1)
  })

  it('matches email case-insensitively and trims', async () => {
    await addMember(
      testEvent({
        headers: u.owner.h,
        params: { id: projectId },
        body: { email: `  ${u.outsider.email.toUpperCase()} `, role: 'editor' }
      })
    )
    const res = await listMembers(testEvent({ headers: u.owner.h, params: { id: projectId } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('editor')
  })

  it('answers 409 for an existing member', async () => {
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.owner.h,
            params: { id: projectId },
            body: { email: u.viewer.email, role: 'owner' }
          })
        )
      )
    ).toBe(409)
  })

  it('answers 404 for an unknown email', async () => {
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.owner.h,
            params: { id: projectId },
            body: { email: 'nobody@example.com', role: 'viewer' }
          })
        )
      )
    ).toBe(404)
  })

  it('refuses a viewer with 403', async () => {
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.viewer.h,
            params: { id: projectId },
            body: { email: u.admin.email, role: 'viewer' }
          })
        )
      )
    ).toBe(403)
  })

  it('lets an admin with no membership row manage members', async () => {
    await changeRole(
      testEvent({
        headers: u.admin.h,
        params: { id: projectId, userId: u.outsider.id },
        body: { role: 'viewer' }
      })
    )
    const res = await listMembers(testEvent({ headers: u.admin.h, params: { id: projectId } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('viewer')
  })

  it('audits add, role change and removal', async () => {
    await removeMember(
      testEvent({ headers: u.owner.h, params: { id: projectId, userId: u.outsider.id } })
    )
    const rows = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.projectId, projectId))
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set(['member.add', 'member.role', 'member.remove'])
    )
  })

  it('answers 404 with the member message for an unknown userId', async () => {
    const message = async (call: Promise<unknown>) => {
      try {
        await call
      } catch (e) {
        return isApiError(e) ? e.statusMessage : undefined
      }
    }
    const params = { id: projectId, userId: 'nobody' }
    expect(await status(removeMember(testEvent({ headers: u.owner.h, params })))).toBe(404)
    expect(await message(removeMember(testEvent({ headers: u.owner.h, params })))).toBe(
      'That account is not a member of this project.'
    )
  })

  it('answers 404 when changing or removing a non-member', async () => {
    expect(
      await status(
        changeRole(
          testEvent({
            headers: u.owner.h,
            params: { id: projectId, userId: u.outsider.id },
            body: { role: 'owner' }
          })
        )
      )
    ).toBe(404)
    expect(
      await status(
        removeMember(
          testEvent({ headers: u.owner.h, params: { id: projectId, userId: u.outsider.id } })
        )
      )
    ).toBe(404)
  })

  it("a demoted owner's next member write is 403", async () => {
    const p = await seedProject(ORG, 'demote')
    await grantProjectRole(p, u.owner.id, 'owner')
    await grantProjectRole(p, u.viewer.id, 'viewer')
    await changeRole(
      testEvent({
        headers: u.owner.h,
        params: { id: p, userId: u.owner.id },
        body: { role: 'viewer' }
      })
    )
    expect(
      await status(
        removeMember(testEvent({ headers: u.owner.h, params: { id: p, userId: u.viewer.id } }))
      )
    ).toBe(403)
  })

  it('allows the last owner to leave (zero owners)', async () => {
    const p = await seedProject(ORG, 'leave')
    await grantProjectRole(p, u.owner.id, 'owner')
    await removeMember(testEvent({ headers: u.owner.h, params: { id: p, userId: u.owner.id } }))
    const res = await listMembers(testEvent({ headers: u.admin.h, params: { id: p } }))
    expect(res.ownerCount).toBe(0)
  })

  it('creates a missing access record on first use', async () => {
    const p = await seedProject(ORG, 'healme')
    await db().delete(projectAccess).where(eq(projectAccess.id, p))
    await addMember(
      testEvent({
        headers: u.admin.h,
        params: { id: p },
        body: { email: u.viewer.email, role: 'viewer' }
      })
    )
    expect(
      await db()
        .select()
        .from(projectAccess)
        .where(and(eq(projectAccess.id, p)))
    ).toHaveLength(1)
  })
})
