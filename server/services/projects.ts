import { count, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { organization, project, projectAccess, projectState, stateVersion } from '../db/schema'
import { recordAuditBestEffort } from './audit'
import { currentLock } from './lock'
import { store } from '../storage'
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

export const DELETE_ACTIVE = 'Archive the project before deleting it.'

/**
 * Deletes an archived project for good (spec §4). Blobs go first: an archived
 * project takes no writes, so nothing adds one meanwhile, and a crash part-way
 * leaves an archived project that a retry finishes. Rows first would strand
 * encrypted blobs under a prefix a later project with this slug inherits.
 */
export async function deleteProject(input: {
  projectId: string
  actorId: string
}): Promise<{ versions: number; blobs: number }> {
  const [found] = await db()
    .select({
      orgId: project.orgId,
      slug: project.slug,
      orgSlug: organization.slug,
      archivedAt: project.archivedAt
    })
    .from(project)
    .innerJoin(organization, eq(project.orgId, organization.id))
    .where(eq(project.id, input.projectId))
  if (!found) throw createError({ statusCode: 404, statusMessage: NOT_FOUND })
  if (found.archivedAt === null) {
    throw createError({ statusCode: 409, statusMessage: DELETE_ACTIVE })
  }
  const [counted] = await db()
    .select({ n: count() })
    .from(stateVersion)
    .where(eq(stateVersion.projectId, input.projectId))
  const versions = counted?.n ?? 0

  const keys = await store().list(`${found.orgSlug}/${found.slug}/`)
  for (const key of keys) await store().delete(key)

  // Before the row goes; audit_log has no FK, so the record outlives it.
  await recordAuditBestEffort({
    orgId: found.orgId,
    projectId: input.projectId,
    actorType: 'user',
    actorId: input.actorId,
    action: 'project.delete',
    meta: { org: found.orgSlug, project: found.slug, versions }
  })
  // The pointer first: its FK to state_version is RESTRICT, and the cascade
  // from project reaches both tables in no guaranteed order.
  await db().delete(projectState).where(eq(projectState.projectId, input.projectId))
  await db().delete(project).where(eq(project.id, input.projectId))
  return { versions, blobs: keys.length }
}
