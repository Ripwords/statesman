import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { project, projectAccess } from '../db/schema'
import { recordAuditBestEffort } from './audit'
import { currentLock } from './lock'
import { NOT_FOUND } from '../utils/project-access'
import type { UpdateProjectInput } from '../../shared/schemas/project'

/**
 * Applies a settings change (project-settings spec §4). The slug is never
 * written. A rename is copied to the access row so the plugin's name does not
 * drift. The audit row names the fields, not their values.
 */
export async function updateProject(input: {
  projectId: string
  actorId: string
  changes: UpdateProjectInput
}): Promise<void> {
  const fields = Object.keys(input.changes).toSorted()
  if (fields.length === 0) return
  // Two statements, not a transaction: Neon HTTP has none. A crash between
  // them leaves the access row on the old name; saving again repairs it.
  const [updated] = await db()
    .update(project)
    .set(input.changes)
    .where(eq(project.id, input.projectId))
    .returning({ orgId: project.orgId })
  if (input.changes.name !== undefined) {
    await db()
      .update(projectAccess)
      .set({ name: input.changes.name })
      .where(eq(projectAccess.id, input.projectId))
  }
  const orgId = updated?.orgId
  if (orgId === undefined) return
  await recordAuditBestEffort({
    orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'project.update',
    meta: { fields }
  })
}

export const LOCKED_ARCHIVE =
  'The state is locked. Let the run finish or force-unlock it, then archive.'

/**
 * Archives or unarchives (spec §4). Idempotent: asking for the state the
 * project is already in changes nothing and writes no audit row. A held lock
 * means a run is mid-write, which archiving would strand.
 */
export async function setArchived(input: {
  projectId: string
  actorId: string
  archived: boolean
}): Promise<void> {
  const [found] = await db()
    .select({ orgId: project.orgId, archivedAt: project.archivedAt })
    .from(project)
    .where(eq(project.id, input.projectId))
  if (!found) throw createError({ statusCode: 404, statusMessage: NOT_FOUND })
  if ((found.archivedAt !== null) === input.archived) return
  if (input.archived && (await currentLock(input.projectId))) {
    throw createError({ statusCode: 409, statusMessage: LOCKED_ARCHIVE })
  }
  await db()
    .update(project)
    .set({ archivedAt: input.archived ? new Date() : null })
    .where(eq(project.id, input.projectId))
  await recordAuditBestEffort({
    orgId: found.orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: input.archived ? 'project.archive' : 'project.unarchive'
  })
}
