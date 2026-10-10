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
import { auditLog, project, projectAccess } from '../../server/db/schema'
import patchProject from '../../server/api/ui/projects/[id].patch'
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

function patch(actor: Actor, id: string, body: unknown): Promise<unknown> {
  return patchProject(testEvent({ headers: actor.h, params: { id }, body }))
}

async function row(id: string) {
  const [found] = await db().select().from(project).where(eq(project.id, id))
  return found
}

describe('PATCH /api/ui/projects/:id', () => {
  it('lets an owner rename and describe, and keeps the access row in step', async () => {
    const pid = await fresh()
    await patch(u.owner, pid, { name: 'Production', description: 'Main account' })
    expect(await row(pid)).toMatchObject({ name: 'Production', description: 'Main account' })
    const [access] = await db().select().from(projectAccess).where(eq(projectAccess.id, pid))
    expect(access?.name).toBe('Production')
  })

  it('refuses an editor with 403', async () => {
    const pid = await fresh()
    expect(await status(patch(u.editor, pid, { name: 'x' }))).toBe(403)
  })

  it('refuses retention from an owner with 403 and changes nothing', async () => {
    const pid = await fresh()
    expect(await status(patch(u.owner, pid, { name: 'Renamed', retentionKeepDays: 7 }))).toBe(403)
    expect(await row(pid)).toMatchObject({ name: slugs.get(pid), retentionKeepDays: null })
  })

  it('lets an admin set and clear retention', async () => {
    const pid = await fresh()
    await patch(u.admin, pid, { retentionKeepDays: 7, retentionKeepVersions: 10 })
    expect(await row(pid)).toMatchObject({ retentionKeepDays: 7, retentionKeepVersions: 10 })
    await patch(u.admin, pid, { retentionKeepDays: null })
    expect(await row(pid)).toMatchObject({ retentionKeepDays: null, retentionKeepVersions: 10 })
  })

  it('rejects a slug field with 400', async () => {
    const pid = await fresh()
    expect(await status(patch(u.admin, pid, { slug: 'moved' }))).toBe(400)
  })

  it('still renames an archived project', async () => {
    const pid = await fresh()
    await archive(pid)
    await patch(u.owner, pid, { name: 'Retired' })
    expect((await row(pid))?.name).toBe('Retired')
  })

  it('audits field names, not values', async () => {
    const pid = await fresh()
    await patch(u.owner, pid, { name: 'Secretly', description: 'hush' })
    const [entry] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, 'project.update')))
    expect(entry?.metaJson).toEqual({ fields: ['description', 'name'] })
  })
})
