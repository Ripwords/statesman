import { testEvent, isApiError } from '../ui/nitro-globals'
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  provisionUser,
  signInHeaders,
  setRole,
  resetDb,
  seedProject,
  grantProjectRole
} from '../protocol/helpers'
import { db } from '../../server/db/client'
import { project } from '../../server/db/schema'
import { requireProjectPermission, requireTokenAuthority } from '../../server/utils/project-access'
import type { ProjectPermission } from '../../shared/project-permissions'

// This suite owns this organization slug; see resetDb in ../protocol/helpers.
const ORG = 'settings'
const PASSWORD = 'correct horse battery staple'
type Actor = { id: string; email: string; h: Record<string, string> }
const ACTORS = ['admin', 'owner', 'editor', 'viewer'] as const
const u = {} as Record<(typeof ACTORS)[number], Actor>

beforeAll(async () => {
  await resetDb(ORG)
  const stamp = Date.now()
  for (const name of ACTORS) {
    const p = await provisionUser(`ps-${name}-${stamp}@example.com`, PASSWORD)
    await setRole(p.id, name === 'admin' ? 'admin' : 'member')
    u[name] = { ...p, h: Object.fromEntries((await signInHeaders(p.email, PASSWORD)).entries()) }
  }
})

let seq = 0
const slugs = new Map<string, string>()
/** A project of its own with owner, editor and viewer granted. */
async function fresh(): Promise<string> {
  const slug = `p${++seq}`
  const id = await seedProject(ORG, slug)
  slugs.set(id, slug)
  await grantProjectRole(id, u.owner.id, 'owner')
  await grantProjectRole(id, u.editor.id, 'editor')
  await grantProjectRole(id, u.viewer.id, 'viewer')
  return id
}

async function archive(id: string): Promise<void> {
  await db().update(project).set({ archivedAt: new Date() }).where(eq(project.id, id))
}

async function status(call: Promise<unknown>): Promise<number | undefined> {
  try {
    await call
    return undefined
  } catch (e) {
    return isApiError(e) ? e.statusCode : undefined
  }
}

describe('archived guard', () => {
  it('refuses variable writes on an archived project with 409', async () => {
    const pid = await fresh()
    await archive(pid)
    expect(
      await status(
        requireProjectPermission(testEvent({ headers: u.owner.h }), pid, 'variable:write')
      )
    ).toBe(409)
  })

  it('refuses an admin too', async () => {
    const pid = await fresh()
    await archive(pid)
    expect(
      await status(
        requireProjectPermission(testEvent({ headers: u.admin.h }), pid, 'project:rollback')
      )
    ).toBe(409)
  })

  it.each<ProjectPermission>([
    'project:read',
    'project:unlock',
    'project:update',
    'variable:download',
    'member:manage'
  ])('still allows %s on an archived project', async (permission) => {
    const pid = await fresh()
    await archive(pid)
    await expect(
      requireProjectPermission(testEvent({ headers: u.owner.h }), pid, permission)
    ).resolves.toMatchObject({ projectRole: 'owner' })
  })

  it('answers 403, not 409, when the role is short as well', async () => {
    const pid = await fresh()
    await archive(pid)
    expect(
      await status(
        requireProjectPermission(testEvent({ headers: u.viewer.h }), pid, 'variable:write')
      )
    ).toBe(403)
  })

  it('lets an owner update a project', async () => {
    const pid = await fresh()
    await expect(
      requireProjectPermission(testEvent({ headers: u.owner.h }), pid, 'project:update')
    ).resolves.toMatchObject({ projectRole: 'owner' })
    expect(
      await status(
        requireProjectPermission(testEvent({ headers: u.editor.h }), pid, 'project:update')
      )
    ).toBe(403)
  })

  it('refuses a token naming an archived project, admins included', async () => {
    const pid = await fresh()
    await archive(pid)
    const scope = { kind: 'projects' as const, projects: [`${ORG}/${slugs.get(pid)}`] }
    for (const actor of [u.owner, u.admin]) {
      const role = actor === u.admin ? ('admin' as const) : ('member' as const)
      expect(await status(requireTokenAuthority({ userId: actor.id, role }, scope))).toBe(409)
    }
  })
})
