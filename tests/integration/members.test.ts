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
type Actor = { id: string; email: string; h: Record<string, string> }
const ACTORS = ['admin', 'owner', 'viewer', 'outsider'] as const
const u = {} as Record<(typeof ACTORS)[number], Actor>

beforeAll(async () => {
  await resetDb(ORG)
  const stamp = Date.now()
  for (const name of ACTORS) {
    const p = await provisionUser(`mb-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(p.id, name === 'admin' ? 'admin' : 'member')
    u[name] = { ...p, h: Object.fromEntries((await signInHeaders(p.email, PASSWORD)).entries()) }
  }
})

let seq = 0
/** A project of its own with the owner and viewer granted, so no test leans on another's rows. */
async function fresh(): Promise<string> {
  const id = await seedProject(ORG, `t${++seq}`)
  await grantProjectRole(id, u.owner.id, 'owner')
  await grantProjectRole(id, u.viewer.id, 'viewer')
  return id
}

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
    const pid = await fresh()
    const res = await listMembers(testEvent({ headers: u.viewer.h, params: { id: pid } }))
    expect(res.members.map((m) => m.email).toSorted()).toEqual(
      [u.owner.email, u.viewer.email].toSorted()
    )
    expect(res.ownerCount).toBe(1)
  })

  it('matches email case-insensitively and trims', async () => {
    const pid = await fresh()
    await addMember(
      testEvent({
        headers: u.owner.h,
        params: { id: pid },
        body: { email: `  ${u.outsider.email.toUpperCase()} `, role: 'editor' }
      })
    )
    const res = await listMembers(testEvent({ headers: u.owner.h, params: { id: pid } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('editor')
  })

  it('answers 409 for an existing member', async () => {
    const pid = await fresh()
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.owner.h,
            params: { id: pid },
            body: { email: u.viewer.email, role: 'owner' }
          })
        )
      )
    ).toBe(409)
  })

  it('answers 404 for an unknown email', async () => {
    const pid = await fresh()
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.owner.h,
            params: { id: pid },
            body: { email: 'nobody@example.com', role: 'viewer' }
          })
        )
      )
    ).toBe(404)
  })

  it('refuses a viewer with 403', async () => {
    const pid = await fresh()
    expect(
      await status(
        addMember(
          testEvent({
            headers: u.viewer.h,
            params: { id: pid },
            body: { email: u.admin.email, role: 'viewer' }
          })
        )
      )
    ).toBe(403)
  })

  it('lets an admin with no membership row manage members', async () => {
    const pid = await fresh()
    await grantProjectRole(pid, u.outsider.id, 'editor')
    await changeRole(
      testEvent({
        headers: u.admin.h,
        params: { id: pid, userId: u.outsider.id },
        body: { role: 'viewer' }
      })
    )
    const res = await listMembers(testEvent({ headers: u.admin.h, params: { id: pid } }))
    expect(res.members.find((m) => m.userId === u.outsider.id)?.role).toBe('viewer')
  })

  it('audits add, role change and removal once each, with actor and meta', async () => {
    const pid = await fresh()
    const params = { id: pid, userId: u.outsider.id }
    await addMember(
      testEvent({
        headers: u.owner.h,
        params: { id: pid },
        body: { email: u.outsider.email, role: 'viewer' }
      })
    )
    await changeRole(testEvent({ headers: u.owner.h, params, body: { role: 'editor' } }))
    await removeMember(testEvent({ headers: u.owner.h, params }))
    const rows = await db()
      .select({ action: auditLog.action, actorId: auditLog.actorId, meta: auditLog.metaJson })
      .from(auditLog)
      .where(eq(auditLog.projectId, pid))
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]))
    expect(rows).toHaveLength(3)
    expect(byAction['member.add']?.meta).toEqual({ userId: u.outsider.id, role: 'viewer' })
    expect(byAction['member.role']?.meta).toEqual({
      userId: u.outsider.id,
      from: 'viewer',
      to: 'editor'
    })
    expect(byAction['member.remove']?.meta).toEqual({ userId: u.outsider.id, role: 'editor' })
    for (const r of rows) expect(r.actorId).toBe(u.owner.id)
  })

  it('answers 404 with the member message for an unknown userId', async () => {
    const message = async (call: Promise<unknown>) => {
      try {
        await call
      } catch (e) {
        return isApiError(e) ? e.statusMessage : undefined
      }
    }
    const pid = await fresh()
    const params = { id: pid, userId: 'nobody' }
    expect(await status(removeMember(testEvent({ headers: u.owner.h, params })))).toBe(404)
    expect(await message(removeMember(testEvent({ headers: u.owner.h, params })))).toBe(
      'That account is not a member of this project.'
    )
  })

  it('answers 404 when changing or removing a non-member', async () => {
    const pid = await fresh()
    expect(
      await status(
        changeRole(
          testEvent({
            headers: u.owner.h,
            params: { id: pid, userId: u.outsider.id },
            body: { role: 'owner' }
          })
        )
      )
    ).toBe(404)
    expect(
      await status(
        removeMember(testEvent({ headers: u.owner.h, params: { id: pid, userId: u.outsider.id } }))
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
