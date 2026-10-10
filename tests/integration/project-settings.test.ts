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
import archiveRoute from '../../server/api/ui/projects/[id]/archive.post'
import unarchiveRoute from '../../server/api/ui/projects/[id]/unarchive.post'
import { acquireLock, currentLock } from '../../server/services/lock'
import { acquireWritableLock } from '../../server/utils/tf-handler'
import deleteRoute from '../../server/api/ui/projects/[id].delete'
import { writeState } from '../../server/services/state'
import { store } from '../../server/storage'
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

function hit(
  route: (e: ReturnType<typeof testEvent>) => Promise<unknown>,
  actor: Actor,
  id: string
): Promise<unknown> {
  return route(testEvent({ headers: actor.h, params: { id } }))
}

async function audits(pid: string, action: string): Promise<number> {
  const rows = await db()
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, action)))
  return rows.length
}

describe('archive and unarchive', () => {
  it('lets an admin archive, once', async () => {
    const pid = await fresh()
    await hit(archiveRoute, u.admin, pid)
    await hit(archiveRoute, u.admin, pid)
    expect((await row(pid))?.archivedAt).toBeInstanceOf(Date)
    expect(await audits(pid, 'project.archive')).toBe(1)
  })

  it('refuses an owner with 403', async () => {
    const pid = await fresh()
    expect(await status(hit(archiveRoute, u.owner, pid))).toBe(403)
    expect(await status(hit(unarchiveRoute, u.owner, pid))).toBe(403)
  })

  it('answers 404 for an unknown id', async () => {
    expect(await status(hit(archiveRoute, u.admin, 'no-such-project'))).toBe(404)
  })

  it('refuses to archive a locked project with 409', async () => {
    const pid = await fresh()
    await acquireLock(pid, { ID: 'run-1' })
    expect(await status(hit(archiveRoute, u.admin, pid))).toBe(409)
    expect((await row(pid))?.archivedAt).toBeNull()
  })

  it('unarchives and audits, and does nothing to an active project', async () => {
    const active = await fresh()
    await hit(unarchiveRoute, u.admin, active)
    expect(await audits(active, 'project.unarchive')).toBe(0)

    const pid = await fresh()
    await archive(pid)
    await hit(unarchiveRoute, u.admin, pid)
    expect((await row(pid))?.archivedAt).toBeNull()
    expect(await audits(pid, 'project.unarchive')).toBe(1)
  })
})

describe('archive racing a lock acquire', () => {
  // The handler resolved the project as active, then an admin archived it
  // before the lock row went in. The run must not end up holding a lock it
  // can never write under.
  it('refuses a lock taken after an archive the handler did not see, and leaves none', async () => {
    const pid = await fresh()
    const slug = slugs.get(pid) ?? ''
    const resolved = { id: pid, orgId: '', ref: { org: ORG, project: slug }, archived: false }
    await archive(pid)
    expect(await status(acquireWritableLock(resolved, { ID: 'run-race' }))).toBe(409)
    expect(await currentLock(pid)).toBeNull()
  })

  it('takes the lock on an active project', async () => {
    const pid = await fresh()
    const slug = slugs.get(pid) ?? ''
    const resolved = { id: pid, orgId: '', ref: { org: ORG, project: slug }, archived: false }
    expect(await acquireWritableLock(resolved, { ID: 'run-ok' })).toEqual({ ok: true })
    expect((await currentLock(pid))?.ID).toBe('run-ok')
  })
})

describe('DELETE /api/ui/projects/:id', () => {
  async function withState(): Promise<{ pid: string; prefix: string }> {
    const pid = await fresh()
    for (const serial of [1, 2]) {
      await writeState({
        projectId: pid,
        orgSlug: ORG,
        projectSlug: slugs.get(pid) ?? '',
        body: Buffer.from(JSON.stringify({ version: 4, serial })),
        userId: u.admin.id
      })
    }
    return { pid, prefix: `${ORG}/${slugs.get(pid)}/` }
  }

  it('refuses to delete an active project with 409', async () => {
    const pid = await fresh()
    expect(await status(hit(deleteRoute, u.admin, pid))).toBe(409)
    expect(await row(pid)).toBeDefined()
  })

  it('refuses a non-admin with 403', async () => {
    const pid = await fresh()
    await archive(pid)
    expect(await status(hit(deleteRoute, u.owner, pid))).toBe(403)
  })

  it('removes every blob and row, and keeps the audit record', async () => {
    const { pid, prefix } = await withState()
    expect(await store().list(prefix)).toHaveLength(2)
    await archive(pid)
    await hit(deleteRoute, u.admin, pid)
    expect(await store().list(prefix)).toEqual([])
    expect(await row(pid)).toBeUndefined()
    const [entry] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, pid), eq(auditLog.action, 'project.delete')))
    expect(entry?.metaJson).toEqual({ org: ORG, project: slugs.get(pid), versions: 2 })
  })

  it('finishes on retry after the blobs were already removed', async () => {
    const { pid, prefix } = await withState()
    await archive(pid)
    for (const key of await store().list(prefix)) await store().delete(key)
    await hit(deleteRoute, u.admin, pid)
    expect(await row(pid)).toBeUndefined()
  })
})
